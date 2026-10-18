import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { getDb, usesPostgres } from "@/lib/db";
import { asUser } from "@/lib/scope";

/** The Supabase-authenticated user for this request, or null when signed out. */
export async function getSessionUser() {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ) {
    return null;
  }
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** The account every query should run as.
 *
 * Postgres mode: the signed-in user, redirecting to sign-in when there is none.
 * The `users` profile row is upserted here (id = auth uid) so habit writes
 * satisfy the foreign key on first request after sign-up.
 *
 * PGlite mode: the seeded demo account — no sign-in exists there. */
export async function requireUserId(): Promise<string> {
  if (!usesPostgres) {
    const db = await getDb();
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM users ORDER BY created_at LIMIT 1",
    );
    if (!rows[0]) throw new Error("No demo account exists yet.");
    return rows[0].id;
  }

  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  await ensureProfile(user.id, user.email ?? null);
  return user.id;
}

async function ensureProfile(userId: string, name: string | null): Promise<void> {
  const db = await getDb();
  await asUser(db, userId, (client) =>
    client.query(
      "INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [userId, name],
    ),
  );
}
