// Per-user scoping.
//
// The security boundary lives in the database (row level security in
// prisma/schema.sql), not in these helpers. What they do is put the connection
// into the same posture Supabase puts it in for a signed-in user:
//
//   1. assume the `authenticated` role — table owners bypass RLS, so querying as
//      the owner would silently disable every policy;
//   2. publish the user id where `current_user_id()` looks for it, using the
//      same GUC that Supabase's JWT claim would populate.
//
// Both steps are transaction-local (`SET LOCAL`, `set_config(..., true)`), so a
// pooled or shared connection can serve two accounts without leaking between
// them.

/** The slice of a database handle the rules need. Satisfied by PGlite and by a
 * PGlite transaction, so callers pass whichever context they already have. */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

/** A database handle. Satisfied by PGlite and by the Postgres pool adapter in
 * db.ts, so the scoping rules run identically against either backend. */
export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUserId(userId: string): void {
  // A GUC is not a SQL string, so this is not injection defence — it is a guard
  // against a caller passing an empty id and quietly scoping to "nobody".
  if (!UUID.test(userId)) {
    throw new Error(`Not a user id: ${JSON.stringify(userId)}`);
  }
}

async function assumeIdentity(client: SqlClient, userId: string): Promise<void> {
  assertUserId(userId);
  await client.exec("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
}

/**
 * Runs `fn` as `userId` inside one transaction. Use this for anything that
 * writes more than once and must not half-apply.
 */
export async function asUser<T>(
  db: Db,
  userId: string,
  fn: (client: SqlClient) => Promise<T>,
): Promise<T> {
  assertUserId(userId);
  return db.transaction(async (tx) => {
    const client = tx as SqlClient;
    await assumeIdentity(client, userId);
    return fn(client);
  });
}

/**
 * A handle that runs every statement as `userId`, each in its own transaction.
 * Convenient for read paths and tests, where atomicity across calls is not
 * needed; prefer `asUser` for multi-statement writes.
 */
export function userClient(db: Db, userId: string): SqlClient {
  assertUserId(userId);
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return db.transaction(async (tx) => {
        const client = tx as SqlClient;
        await assumeIdentity(client, userId);
        const result = await client.query<T>(sql, params);
        return { rows: result.rows };
      });
    },
    async exec(sql: string) {
      return db.transaction(async (tx) => {
        const client = tx as SqlClient;
        await assumeIdentity(client, userId);
        return client.exec(sql);
      });
    },
  };
}
