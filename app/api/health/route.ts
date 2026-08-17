import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * A dependency-free readiness endpoint for platform monitors. It deliberately
 * reports configuration state only: database checks belong to authenticated
 * operational probes so a public endpoint cannot amplify provider traffic.
 */
export async function GET() {
  const configured = [
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    process.env.OPENAI_API_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.CRON_SECRET ?? process.env.INTERNAL_WORKER_SECRET,
  ].every(Boolean);

  return NextResponse.json(
    {
      status: configured ? "ok" : "misconfigured",
      timestamp: new Date().toISOString(),
      revision: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    },
    {
      status: configured ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
