import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");

/**
 * Supabase provides `auth`, `storage`, and the `authenticated`/`service_role`
 * roles. PGlite does not, so the harness stands them up before applying the
 * real migration files unmodified. Everything below this comment is a stub for
 * a Supabase-managed object; no application table is created here.
 */
const SUPABASE_STUBS = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
-- Supabase installs pgvector into "extensions", NOT "public", and does not put
-- that schema on the search_path migrations run under. Mirroring it here is
-- what makes a migration referencing vector, vector_cosine_ops, or the <=>
-- operator without declaring its own search_path fail in tests, rather than
-- only at "supabase db push" time.
CREATE SCHEMA IF NOT EXISTS extensions;

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT
);

CREATE TABLE IF NOT EXISTS storage.buckets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id TEXT,
  name TEXT
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT string_to_array(name, '/');
$fn$;

-- Mirrors Supabase's auth.uid(): reads the current request's subject claim.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', TRUE), '')::UUID;
$fn$;

DO $do$ BEGIN
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;

-- Supabase grants table privileges through default privileges, so they attach
-- when a table is created rather than being re-applied afterwards. Emulating it
-- the same way matters: a migration that deliberately REVOKEs a privilege must
-- stay revoked, which a blanket grant run after all migrations would silently
-- undo.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
`;

export type TestDb = {
  sql: PGlite;
  /** Run `fn` as `authenticated` with auth.uid() bound to `userId`. */
  asUser<T>(userId: string, fn: () => Promise<T>): Promise<T>;
  asServiceRole<T>(fn: () => Promise<T>): Promise<T>;
  createUser(email?: string): Promise<string>;
  close(): Promise<void>;
};

export async function createTestDb(): Promise<TestDb> {
  const sql = await PGlite.create({ extensions: { vector } });
  await sql.exec(SUPABASE_STUBS);
  // Into `extensions`, as Supabase does — not the default `public`.
  await sql.exec(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const contents = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      // Reset before every file so each migration must declare the schemas it
      // needs. Without this, one migration's `SET search_path` would leak into
      // the next and hide a missing declaration.
      await sql.exec(`SET search_path = public;`);
      await sql.exec(contents);
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }

  // Views are not covered by the default privileges above.
  await sql.exec(`
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
  `);

  // Test helpers cast to `vector` directly; application code never relies on
  // this, because every function that needs it declares its own search_path.
  await sql.exec(`SET search_path = public, extensions;`);

  /**
   * PGlite runs every statement on one connection, so role and claim are set at
   * session scope (`SET ROLE`, not `SET LOCAL ROLE`, which would need an
   * explicit transaction block) and reset afterwards.
   */
  async function withRole<T>(role: string, userId: string | null, fn: () => Promise<T>) {
    await sql.exec(`SET ROLE ${role};`);
    await sql.query(`SELECT set_config('request.jwt.claim.sub', $1, FALSE)`, [userId ?? ""]);
    try {
      return await fn();
    } finally {
      await sql.exec(`RESET ROLE;`);
      await sql.query(`SELECT set_config('request.jwt.claim.sub', $1, FALSE)`, [""]);
    }
  }

  return {
    sql,
    asUser: (userId, fn) => withRole("authenticated", userId, fn),
    asServiceRole: (fn) => withRole("service_role", null, fn),
    async createUser(email = `${crypto.randomUUID()}@example.test`) {
      const result = await sql.query<{ id: string }>(
        `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`,
        [email],
      );
      return result.rows[0].id;
    },
    close: () => sql.close(),
  };
}
