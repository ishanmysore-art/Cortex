/**
 * Preflight for a deployment target.
 *
 * Checks two independent things:
 *   1. Required environment variables are present and well-formed.
 *   2. The database actually carries the schema this build expects.
 *
 * The second check exists because migration files living in the repo says
 * nothing about whether they were applied. That gap once let five milestones'
 * worth of tables go missing from a live project, surfacing only as a console
 * error on one page.
 *
 * The expected objects are DERIVED FROM THE MIGRATION FILES, never listed by
 * hand. A hand-maintained list is itself something that can fall behind — the
 * first version of this check hard-coded its expectations and was stale within a
 * single milestone, passing while a new table was missing.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(repoRoot, "supabase/migrations");

/**
 * Falls back to .env.local so the check is runnable locally without sourcing
 * anything first. Node does not load .env files the way Next.js does, and a
 * preflight that only works after a shell incantation is one nobody runs.
 *
 * The real environment always wins, so running this against CI or production
 * values is never quietly overridden by a developer's local file.
 */
function loadEnvFile() {
  const envPath = path.join(repoRoot, ".env.local");
  if (!existsSync(envPath)) return {};
  const parsed = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return parsed;
}

const fileEnv = loadEnvFile();
const env = (name) => process.env[name] ?? fileEnv[name];
const usedFallback = Object.keys(fileEnv).some(
  (name) => process.env[name] === undefined && fileEnv[name],
);

const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "OPENAI_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_APP_URL",
];

const missing = required.filter((name) => !env(name));
const hasWorkerSecret = Boolean(env("CRON_SECRET") || env("INTERNAL_WORKER_SECRET"));

if (!hasWorkerSecret) missing.push("CRON_SECRET or INTERNAL_WORKER_SECRET");

if (env("NEXT_PUBLIC_APP_URL")) {
  try {
    new URL(env("NEXT_PUBLIC_APP_URL"));
  } catch {
    missing.push("NEXT_PUBLIC_APP_URL (must be an absolute URL)");
  }
}

if (missing.length > 0) {
  console.error(
    [
      `Missing or invalid environment variables:`,
      ...missing.map((name) => `- ${name}`),
      "",
      existsSync(path.join(repoRoot, ".env.local"))
        ? "Checked the process environment and .env.local."
        : "Checked the process environment; no .env.local was found.",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * Reads every migration and returns the public tables, views, and callable
 * functions they create, each tagged with the file that introduced it.
 *
 * Trigger functions are excluded: PostgREST does not expose them as RPCs, so
 * their absence from the API says nothing about whether they exist.
 */
function expectedObjectsFromMigrations() {
  const expected = new Map();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");

    for (const match of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.(\w+)/gi,
    )) {
      expected.set(`table:${match[1]}`, { kind: "table", name: match[1], file });
    }

    for (const match of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+public\.(\w+)/gi)) {
      expected.set(`table:${match[1]}`, { kind: "view", name: match[1], file });
    }

    for (const match of sql.matchAll(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(\w+)\s*\([\s\S]*?\)\s*RETURNS\s+(\w+)/gi,
    )) {
      if (match[2].toLowerCase() === "trigger") continue;
      expected.set(`rpc:${match[1]}`, { kind: "rpc", name: match[1], file });
    }
  }

  return [...expected.values()];
}

const expected = expectedObjectsFromMigrations();
const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
const projectRef = new URL(supabaseUrl).hostname.split(".")[0];

// Naming the target makes "pointed at the wrong project" visible rather than
// something you deduce afterwards from a confusing error.
console.log(
  `Checking schema on Supabase project: ${projectRef}${usedFallback ? " (values from .env.local)" : ""}`,
);
console.log(`Expecting ${expected.length} objects derived from ${MIGRATIONS_DIR.split("/").pop()}/`);

let spec;
try {
  // The OpenAPI document lists every table, view, and callable function in one
  // read. Probing RPCs by calling them would run them, and several mutate.
  const response = await fetch(`${supabaseUrl}/rest/v1/`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  spec = await response.json();
} catch (error) {
  // Offline and misconfigured are indistinguishable from here, so this warns
  // rather than fails: a preflight that blocks a build because of flaky
  // networking is a preflight people learn to skip.
  console.warn(`Warning: could not reach Supabase to verify schema (${error.message}).`);
  console.warn("Environment variables are valid; schema was not checked.");
  process.exit(0);
}

const paths = Object.keys(spec.paths ?? {});
const presentTables = new Set(
  paths.filter((p) => p !== "/" && !p.startsWith("/rpc/")).map((p) => p.slice(1)),
);
const presentRpcs = new Set(
  paths.filter((p) => p.startsWith("/rpc/")).map((p) => p.slice("/rpc/".length)),
);

const behind = expected.filter((object) =>
  object.kind === "rpc" ? !presentRpcs.has(object.name) : !presentTables.has(object.name),
);

if (behind.length > 0) {
  const files = [...new Set(behind.map((o) => o.file))];
  console.error(
    [
      "",
      `Database schema is behind the code. Project ${projectRef} is missing:`,
      ...behind.map((o) => `  - ${o.kind} ${o.name}  (${o.file})`),
      "",
      `Unapplied migration${files.length === 1 ? "" : "s"}: ${files.join(", ")}`,
      "",
      "Apply before deploying:",
      `  npx supabase link --project-ref ${projectRef}`,
      "  npx supabase db push",
      "",
      "If the project already has objects that predate its migration history,",
      "mark those migrations applied first with `supabase migration repair`.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`Schema check passed: all ${expected.length} expected objects present.`);
console.log("Environment preflight passed.");
