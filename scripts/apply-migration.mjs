#!/usr/bin/env node
/**
 * Applies one or more SQL files to the linked Supabase project, in the order
 * given, via the Management API.
 *
 * Prefer `supabase db push` for anything under supabase/migrations/ — it tracks
 * what has been applied. Use this for ad-hoc SQL, or to repair a project whose
 * migration history has drifted from its schema.
 *
 * Authentication is a Personal Access Token, NOT the project's service-role key.
 * The Management API is an account-level API and rejects project JWTs with
 * "JWT failed verification" — an earlier version of this script used the
 * service-role key and could never have applied anything, which is how a whole
 * milestone's worth of migrations silently went missing.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/apply-migration.mjs <file.sql> [more.sql ...]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/** Reads .env.local as a fallback so local use matches the running app. */
function loadEnvFile() {
  const envPath = path.join(repoRoot, ".env.local");
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const fileEnv = loadEnvFile();
const read = (name) => process.env[name] ?? fileEnv[name];

const supabaseUrl = read("NEXT_PUBLIC_SUPABASE_URL");
const accessToken = read("SUPABASE_ACCESS_TOKEN");

if (!supabaseUrl) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL (checked the environment and .env.local).");
  process.exit(1);
}

if (!accessToken || !accessToken.startsWith("sbp_")) {
  console.error(
    [
      "Missing or invalid SUPABASE_ACCESS_TOKEN.",
      "",
      "This must be a Personal Access Token (starts with 'sbp_'), not the",
      "service-role key — the Management API is account-scoped and rejects",
      "project JWTs.",
      "",
      "Create one at https://supabase.com/dashboard/account/tokens, then:",
      "  SUPABASE_ACCESS_TOKEN=sbp_... node scripts/apply-migration.mjs <file.sql>",
    ].join("\n"),
  );
  process.exit(1);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/apply-migration.mjs <file.sql> [more.sql ...]");
  process.exit(1);
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }
}

const projectRef = new URL(supabaseUrl).hostname.split(".")[0];

// Naming the target before doing anything: pointing at the wrong project is the
// failure mode this script is most likely to cause.
console.log(`Target project: ${projectRef}`);
console.log(`Applying ${files.length} file(s), in order:`);
for (const file of files) console.log(`  - ${path.relative(repoRoot, file)}`);
console.log();

for (const file of files) {
  const sql = fs.readFileSync(file, "utf-8");
  const label = path.relative(repoRoot, file);
  process.stdout.write(`${label} ... `);

  let response;
  try {
    response = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: sql }),
      },
    );
  } catch (error) {
    console.log("failed");
    console.error(`  network error: ${error.message}`);
    process.exit(1);
  }

  const body = await response.text();
  if (!response.ok) {
    console.log("failed");
    console.error(`  HTTP ${response.status}: ${body.slice(0, 600)}`);
    // Stop rather than continue: later files usually depend on earlier ones.
    console.error("\nStopped. No further files were applied.");
    process.exit(1);
  }

  console.log("ok");
}

console.log(`\nApplied ${files.length} file(s) to ${projectRef}.`);
