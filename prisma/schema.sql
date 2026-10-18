-- Kintsugi database schema
-- Target: Postgres (Supabase). Maps cleanly to SQLite with minor syntax tweaks.
-- Design intent:
--   - One row per habit per day (daily_logs) is the source of truth.
--   - Bounce-backs are materialized at write-time (trigger on daily_logs) so the
--     dashboard reads O(1) instead of scanning the whole history every render.
--   - Ghost days are excluded from all consistency math via FILTER (WHERE NOT is_ghost).
--   - The keystone habit is a flag on habits; a "Keystone Save" is a read-time concept
--     (keystone completed AND all other habits false on that day) — no extra table.

-- ── Users ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Habits ─────────────────────────────────────────────────────────────
-- A user can have many habits; exactly ONE may be the keystone.
CREATE TABLE IF NOT EXISTS habits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  -- Abbreviated name for tight UI (e.g. the 25%-wide minor segments).
  -- NULL falls back to the full label.
  short_label TEXT,
  is_keystone BOOLEAN NOT NULL DEFAULT FALSE,
  color       TEXT NOT NULL DEFAULT '#475569',  -- slate for non-keystone habits
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, label)
);

-- Enforce "one keystone per user" at the database level (defense in depth).
-- The app layer also enforces this, but this trigger makes it bulletproof in-db.
CREATE OR REPLACE FUNCTION enforce_one_keystone_per_user() RETURNS TRIGGER AS $$
DECLARE
  existing_keystone UUID;
BEGIN
  IF NEW.is_keystone = TRUE THEN
    SELECT id INTO existing_keystone
    FROM habits
    WHERE user_id = NEW.user_id
      AND is_keystone = TRUE
      AND id <> NEW.id
    LIMIT 1;

    IF existing_keystone IS NOT NULL THEN
      RAISE EXCEPTION 'User % already has a keystone habit (id %)',
        NEW.user_id, existing_keystone;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Dropped first so this file can be re-applied as a migration.
DROP TRIGGER IF EXISTS trg_one_keystone_per_user ON habits;
CREATE TRIGGER trg_one_keystone_per_user
  BEFORE INSERT OR UPDATE OF is_keystone ON habits
  FOR EACH ROW
  EXECUTE FUNCTION enforce_one_keystone_per_user();

-- ── Daily Log Entries (source of truth) ───────────────────────────────
-- One row per habit, per day. The day is a local DATE (no time component) so
-- the app can render by calendar day regardless of the user's timezone.
CREATE TABLE IF NOT EXISTS daily_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_id   UUID NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  completed  BOOLEAN NOT NULL DEFAULT FALSE,
  is_ghost   BOOLEAN NOT NULL DEFAULT FALSE,     -- excluded from all stats
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (habit_id, day)
);
-- Note: a ghost row MAY keep completed = true. Pausing a day is an overlay, not
-- an erasure — resuming it must restore exactly what was there before. Every
-- reader therefore uses the *effective* value: (completed AND NOT is_ghost).
-- v_weekly_habit_summary already exposes it that way, and consistency_pct,
-- detect_bounce_back, and resync_bounce_backs all filter ghost rows out.
--
-- Earlier revisions cleared completed on pause and enforced it with a CHECK
-- constraint. Dropping it here keeps databases created by those revisions valid
-- instead of failing on the next pause.
ALTER TABLE daily_logs DROP CONSTRAINT IF EXISTS ghost_days_never_complete;

CREATE INDEX IF NOT EXISTS idx_daily_logs_habit_day ON daily_logs(habit_id, day);
CREATE INDEX IF NOT EXISTS idx_daily_logs_day      ON daily_logs(day);

-- ── Bounce-Back Events (materialized for O(1) dashboard reads) ───────
-- A bounce-back = habit NOT completed on day D-1, but WAS completed on day D.
-- We store it here so the dashboard never has to scan the whole log on every
-- page load. Detected by an AFTER INSERT OR UPDATE trigger on daily_logs.
-- (Index and trigger for this table are created after the functions below.)
CREATE TABLE IF NOT EXISTS bounce_back_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_id   UUID NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  bounced_on DATE NOT NULL,   -- the day the user came back
  missed_on  DATE NOT NULL,   -- the day they missed (D-1)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (habit_id, bounced_on)
);

CREATE INDEX IF NOT EXISTS idx_bounce_back_habit ON bounce_back_events(habit_id, bounced_on);

-- Trigger: detect a bounce-back at write-time.
--
-- The comparison is against the most recent *counted* day (is_ghost = false),
-- not simply yesterday: a ghost day is a pause, so it must neither break a
-- streak nor swallow the comeback that follows it. Tuesday miss → Wednesday
-- ghost → Thursday completion is a bounce-back, and a test asserts it.
CREATE OR REPLACE FUNCTION detect_bounce_back() RETURNS TRIGGER AS $$
DECLARE
  prev_day_log   daily_logs%ROWTYPE;
BEGIN
  -- Un-completing a day retracts its comeback, so undo stays truthful.
  IF NEW.completed = FALSE THEN
    DELETE FROM bounce_back_events
    WHERE habit_id = NEW.habit_id
      AND bounced_on = NEW.day;
    RETURN NEW;
  END IF;

  -- Most recent counted day before this one.
  SELECT * INTO prev_day_log
  FROM daily_logs
  WHERE habit_id = NEW.habit_id
    AND day < NEW.day
    AND NOT is_ghost
  ORDER BY day DESC
  LIMIT 1;

  -- First counted day ever, or the streak was never broken: not a comeback.
  IF prev_day_log IS NULL OR prev_day_log.completed = TRUE THEN
    RETURN NEW;
  END IF;

  -- Upsert so that back-filling or re-logging a day keeps missed_on accurate.
  INSERT INTO bounce_back_events (habit_id, bounced_on, missed_on)
    VALUES (NEW.habit_id, NEW.day, prev_day_log.day)
    ON CONFLICT (habit_id, bounced_on)
    DO UPDATE SET missed_on = EXCLUDED.missed_on;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Dropped first so this file can be re-applied as a migration.
DROP TRIGGER IF EXISTS trg_detect_bounce_back ON daily_logs;
CREATE TRIGGER trg_detect_bounce_back
  AFTER INSERT OR UPDATE OF completed ON daily_logs
  FOR EACH ROW
  EXECUTE FUNCTION detect_bounce_back();

-- ── Dashboard View: 7-day per-habit summary ────────────────────────────
-- One row per (habit, day) for the last 7 days, with ghost flag and a
-- pre-computed `is_bounce_back` so the UI never has to compute it.
-- The UI groups by day to build the 7-day stacked bar.
CREATE OR REPLACE VIEW v_weekly_habit_summary AS
SELECT
  h.id         AS habit_id,
  h.label,
  h.is_keystone,
  h.color,
  dl.day,
  (dl.completed AND NOT dl.is_ghost) AS completed,   -- effective completion
  dl.is_ghost,
  EXISTS (
    SELECT 1
    FROM bounce_back_events b
    WHERE b.habit_id = h.id
      AND b.bounced_on = dl.day
  ) AS is_bounce_back
FROM habits h
JOIN daily_logs dl ON dl.habit_id = h.id
WHERE dl.day >= current_date - 6
  AND dl.day <= current_date;

-- ── Consistency % for a window, EXCLUDING ghost days ──────────────────
-- Ghost days are dropped from both numerator and denominator via FILTER.
-- Returns NULL when there are no eligible (non-ghost) days in the window.
CREATE OR REPLACE FUNCTION consistency_pct(
  window_start DATE,
  window_end   DATE,
  target_habit UUID
)
RETURNS NUMERIC AS $$
DECLARE
  total INT;
  done  INT;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE NOT is_ghost),
    COUNT(*) FILTER (WHERE completed AND NOT is_ghost)
  INTO total, done
  FROM daily_logs
  WHERE habit_id = target_habit
    AND day BETWEEN window_start AND window_end;

  IF total = 0 THEN
    RETURN NULL;  -- no eligible days in window
  END IF;

  RETURN ROUND(done::NUMERIC / total::NUMERIC * 100, 1);
END;
$$ LANGUAGE plpgsql STABLE;  -- reads tables, so STABLE — not IMMUTABLE

-- ── Keystone Save detection (read-time; no separate table) ─────────────
-- A day is a "Keystone Save" when:
--   1. the keystone habit's daily_logs row has completed = true
--   2. every OTHER habit for that user on that day has completed = false
-- This is a cheap read-time check on the same daily_logs rows; no extra
-- storage or trigger required. The UI renders a special "Keystone Save" badge
-- on such days.
--
-- Example query (for the dashboard, given a user_id and a day):
--   SELECT EXISTS (
--     SELECT 1 FROM daily_logs dk
--     JOIN habits hk ON hk.id = dk.habit_id
--     WHERE hk.is_keystone = TRUE
--       AND dk.day = :day
--       AND dk.completed = TRUE
--       AND NOT EXISTS (
--         SELECT 1 FROM daily_logs dother
--         JOIN habits hother ON hother.id = dother.habit_id
--         WHERE hother.is_keystone = FALSE
--           AND dother.habit_id IN (SELECT id FROM habits WHERE user_id = :user_id)
--           AND dother.day = :day
--           AND dother.completed = TRUE
--       )
--   ) AS is_keystone_save;
--
-- For an MVP dashboard reading from v_weekly_habit_summary, the simplest approach
-- is to fetch all rows for the window and run this check in JS per day — it's a
-- small in-memory comparison over 7 days x 3 habits.

-- ── Recompute bounce-backs for a window (authoritative) ────────────────
-- The trigger above is the fast path for a single written row. This function
-- is the repair path: call it after anything that changes history backwards —
-- marking a day as a ghost, un-pausing a day, or back-filling a log. It clears
-- the window and rebuilds it from the counted rows with a window function, so
-- it cannot drift from the trigger's rule and is safe to call repeatedly.
CREATE OR REPLACE FUNCTION resync_bounce_backs(
  p_habit UUID,
  p_from  DATE,
  p_to    DATE
)
RETURNS INTEGER AS $$
DECLARE
  inserted INTEGER;
BEGIN
  DELETE FROM bounce_back_events
  WHERE habit_id = p_habit
    AND bounced_on BETWEEN p_from AND p_to;

  WITH counted AS (
    SELECT
      habit_id,
      day,
      completed,
      LAG(day)       OVER (ORDER BY day) AS prev_day,
      LAG(completed) OVER (ORDER BY day) AS prev_completed
    FROM daily_logs
    WHERE habit_id = p_habit
      AND day <= p_to
      AND NOT is_ghost
  ),
  rebuilt AS (
    INSERT INTO bounce_back_events (habit_id, bounced_on, missed_on)
    SELECT habit_id, day, prev_day
    FROM counted
    WHERE completed
      AND prev_completed = FALSE
      AND prev_day IS NOT NULL
      AND day BETWEEN p_from AND p_to
    RETURNING 1
  )
  SELECT COUNT(*) INTO inserted FROM rebuilt;

  RETURN inserted;
END;
$$ LANGUAGE plpgsql;

-- ── Known limitation: retracting a counted day ────────────────────────
-- Marking a previously counted day as a ghost day after the fact leaves stale
-- bounce_back_events rows behind, because the trigger only ever looks backwards
-- from the row being written. Call resync_bounce_backs() for the affected
-- habits and window (src/lib/mutations.ts does this on every ghost toggle).

-- ── Ghost days: global vs per-habit ────────────────────────────────────
-- The schema currently stores is_ghost per daily_logs row (per-habit granularity).
-- If you want a GLOBAL ghost day (the whole calendar day is paused for the user),
-- add this table and join it in v_weekly_habit_summary:
--
--   CREATE TABLE IF NOT EXISTS ghost_days (
--     id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     day   DATE NOT NULL,
--     UNIQUE (user_id, day)
--   );
--
-- Then in v_weekly_habit_summary, add:
--     OR EXISTS (SELECT 1 FROM ghost_days gd WHERE gd.user_id = h.user_id AND gd.day = dl.day)
-- to the is_ghost logic, and exclude it from consistency_pct via the same FILTER.

-- ── Row counts / sanity queries for the dashboard ─────────────────────
-- Weekly consistency per habit (last 7 days, ghost-excluded):
--   SELECT h.label, consistency_pct(current_date - 6, current_date, h.id) AS pct
--   FROM habits h
--   WHERE h.user_id = :user_id;
--
-- Total bounce-backs in the last 7 days:
--   SELECT COUNT(*)
--   FROM bounce_back_events b
--   JOIN habits h ON h.id = b.habit_id
--   WHERE h.user_id = :user_id
--     AND b.bounced_on >= current_date - 6;
