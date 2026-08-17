import { NextResponse } from "next/server";
import { processQueuedIngestionJobs } from "@/lib/ingestion/processor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function runWorker(request: Request) {
  const expectedSecret = process.env.INTERNAL_WORKER_SECRET ?? process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");

  // A missing secret and a wrong secret are different problems and must not
  // look alike. Returning 401 for both meant a deploy that never had the
  // secret set was indistinguishable from routine rejected traffic: the cron
  // fired every two minutes, was refused every time, and no document ever
  // ingested — with nothing in the logs to say why.
  if (!expectedSecret) {
    console.error(
      "Ingestion worker is not configured: set INTERNAL_WORKER_SECRET or CRON_SECRET. " +
        "Uploads will stay 'pending' and stale jobs will not be reclaimed.",
    );
    return NextResponse.json(
      { error: "Ingestion worker is not configured.", code: "worker_not_configured" },
      { status: 503 },
    );
  }

  if (authorization !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // `processQueuedIngestionJobs` reclaims abandoned jobs before claiming new
    // ones, so this scheduled call is also the ingestion recovery cycle.
    const results = await processQueuedIngestionJobs(`next:${process.env.VERCEL_REGION ?? "local"}`);
    return NextResponse.json({ processed: results.length, results });
  } catch (error) {
    console.error("Ingestion worker failed", error);
    return NextResponse.json({ error: "Worker failed" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return runWorker(request);
}

export async function POST(request: Request) {
  return runWorker(request);
}
