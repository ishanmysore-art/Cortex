/**
 * Crash-and-recovery tests for the ingestion job lifecycle.
 *
 * Before `reclaim_stale_ingestion_jobs`, a worker that died mid-run left its
 * job in 'processing' forever. `claim_ingestion_jobs` only ever claims
 * 'queued'/'retry', and `ingestion_jobs_active_document_key` counts
 * 'processing' as active, so the document could never be re-enqueued either.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness";

let db: TestDb;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.sql.exec(`DELETE FROM public.ingestion_jobs; DELETE FROM public.documents;`);
  alice = await db.createUser("alice@example.test");
  bob = await db.createUser("bob@example.test");
});

async function seedQueuedJob(userId: string, title = "paper.pdf", maxAttempts = 3) {
  const documentId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.documents (user_id, title, file_type, status, file_path)
       VALUES ($1,$2,'pdf','pending',$3) RETURNING id`,
      [userId, title, `${userId}/${title}`],
    )
  ).rows[0].id;

  const jobId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.ingestion_jobs (user_id, document_id, max_attempts)
       VALUES ($1,$2,$3) RETURNING id`,
      [userId, documentId, maxAttempts],
    )
  ).rows[0].id;

  return { documentId, jobId };
}

const claim = (worker = "worker-1", batch = 5) =>
  db.sql.query<{ id: string; attempts: number; locked_by: string; locked_at: Date }>(
    `SELECT id, attempts, locked_by, locked_at FROM public.claim_ingestion_jobs($1, $2)`,
    [worker, batch],
  );

const reclaim = (staleAfterSeconds = 900) =>
  db.sql.query<{ id: string; document_id: string; status: string; attempts: number }>(
    `SELECT id, document_id, status, attempts FROM public.reclaim_stale_ingestion_jobs($1, 25)`,
    [staleAfterSeconds],
  );

/** Simulates a worker that locked the job and then died. */
const backdateLock = (jobId: string, seconds: number) =>
  db.sql.query(
    `UPDATE public.ingestion_jobs SET locked_at = NOW() - make_interval(secs => $2) WHERE id = $1`,
    [jobId, seconds],
  );

const jobRow = async (jobId: string) =>
  (
    await db.sql.query<{
      status: string;
      attempts: number;
      locked_at: Date | null;
      locked_by: string | null;
      last_error: string | null;
    }>(
      `SELECT status, attempts, locked_at, locked_by, last_error FROM public.ingestion_jobs WHERE id = $1`,
      [jobId],
    )
  ).rows[0];

const documentRow = async (documentId: string) =>
  (
    await db.sql.query<{ status: string; extraction_error: string | null }>(
      `SELECT status, extraction_error FROM public.documents WHERE id = $1`,
      [documentId],
    )
  ).rows[0];

describe("claim semantics", () => {
  it("charges exactly one attempt per claim and locks the job", async () => {
    const { jobId } = await seedQueuedJob(alice);
    const claimed = await claim();

    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0].id).toBe(jobId);
    expect(claimed.rows[0].attempts).toBe(1);
    expect(claimed.rows[0].locked_by).toBe("worker-1");
    expect(claimed.rows[0].locked_at).not.toBeNull();
  });

  it("never hands the same job to a second worker", async () => {
    await seedQueuedJob(alice);
    expect((await claim("worker-1")).rows).toHaveLength(1);
    expect((await claim("worker-2")).rows).toHaveLength(0);
  });
});

describe("stale job reclaim", () => {
  it("leaves a job that is still running alone", async () => {
    const { jobId } = await seedQueuedJob(alice);
    await claim();

    expect((await reclaim(900)).rows).toHaveLength(0);
    expect((await jobRow(jobId)).status).toBe("processing");
  });

  it("returns an abandoned job to the queue and resyncs the document", async () => {
    const { jobId, documentId } = await seedQueuedJob(alice);
    await claim();
    await db.sql.query(`UPDATE public.documents SET status = 'processing' WHERE id = $1`, [documentId]);
    await backdateLock(jobId, 1_800);

    const reclaimed = await reclaim(900);
    expect(reclaimed.rows).toHaveLength(1);
    expect(reclaimed.rows[0].status).toBe("retry");

    const job = await jobRow(jobId);
    expect(job.status).toBe("retry");
    expect(job.locked_at).toBeNull();
    expect(job.locked_by).toBeNull();
    expect(job.last_error).toMatch(/stopped responding/);

    // Job and document state can never disagree: both move in one transaction.
    expect(await documentRow(documentId)).toMatchObject({
      status: "pending",
      extraction_error: null,
    });
  });

  it("preserves the retry budget rather than re-charging an attempt", async () => {
    const { jobId } = await seedQueuedJob(alice);
    await claim();
    await backdateLock(jobId, 1_800);

    // The claim already charged attempt 1; reclaiming must not charge a second.
    expect((await reclaim(900)).rows[0].attempts).toBe(1);
    expect((await jobRow(jobId)).attempts).toBe(1);
  });

  it("makes a reclaimed job immediately claimable again", async () => {
    const { jobId } = await seedQueuedJob(alice);
    await claim("worker-1");
    await backdateLock(jobId, 1_800);
    await reclaim(900);

    const reclaimedThenClaimed = await claim("worker-2");
    expect(reclaimedThenClaimed.rows).toHaveLength(1);
    expect(reclaimedThenClaimed.rows[0].id).toBe(jobId);
    expect(reclaimedThenClaimed.rows[0].attempts).toBe(2);
  });

  it("terminates after the attempt budget is spent instead of looping forever", async () => {
    const { jobId, documentId } = await seedQueuedJob(alice, "paper.pdf", 2);

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await claim(`worker-${cycle}`);
      await backdateLock(jobId, 1_800);
      await reclaim(900);
    }

    const job = await jobRow(jobId);
    expect(job.attempts).toBe(2);
    expect(job.status).toBe("failed");
    expect(await documentRow(documentId)).toMatchObject({ status: "failed" });
    expect((await documentRow(documentId)).extraction_error).toMatch(/exhausted every retry/);

    // A failed job is terminal: nothing claims it again.
    expect((await claim("worker-final")).rows).toHaveLength(0);
  });

  it("unblocks the partial unique index that made a stuck document permanent", async () => {
    const { jobId, documentId } = await seedQueuedJob(alice);
    await claim();
    await backdateLock(jobId, 1_800);

    // While the job sits in 'processing', the document cannot be re-enqueued.
    await expect(
      db.sql.query(
        `INSERT INTO public.ingestion_jobs (user_id, document_id) VALUES ($1,$2)`,
        [alice, documentId],
      ),
    ).rejects.toThrow(/ingestion_jobs_active_document_key/);

    await reclaim(900);
    // Still one active job after reclaim, but it is now a live retry rather
    // than a permanently locked row.
    expect((await jobRow(jobId)).status).toBe("retry");
  });

  it("clamps an unsafely small staleness window to one minute", async () => {
    const { jobId } = await seedQueuedJob(alice);
    await claim();
    await backdateLock(jobId, 30);

    // A caller passing 0 must not reclaim jobs that are still legitimately running.
    expect((await reclaim(0)).rows).toHaveLength(0);
    expect((await jobRow(jobId)).status).toBe("processing");
  });

  it("touches only stale jobs, leaving other users' work untouched", async () => {
    const aliceJob = await seedQueuedJob(alice, "alice.pdf");
    const bobJob = await seedQueuedJob(bob, "bob.pdf");

    await claim("shared-worker");
    await backdateLock(aliceJob.jobId, 1_800);

    const reclaimed = await reclaim(900);
    expect(reclaimed.rows).toHaveLength(1);
    expect(reclaimed.rows[0].id).toBe(aliceJob.jobId);

    expect((await jobRow(bobJob.jobId)).status).toBe("processing");
    expect((await documentRow(bobJob.documentId)).status).toBe("pending");
  });
});

describe("worker ownership fence", () => {
  /**
   * Mirrors `releaseJob` in lib/ingestion/processor.ts: a worker may only
   * release a job it still holds, identified by locked_by + locked_at.
   */
  const release = (
    jobId: string,
    lock: { locked_by: string | null; locked_at: Date | null },
    status: string,
  ) =>
    db.sql.query(
      `UPDATE public.ingestion_jobs
       SET status = $4::ingestion_job_status, locked_at = NULL, locked_by = NULL
       WHERE id = $1 AND status = 'processing' AND locked_by = $2 AND locked_at = $3
       RETURNING id`,
      [jobId, lock.locked_by, lock.locked_at, status],
    );

  it("lets the owning worker release its own job", async () => {
    const { jobId } = await seedQueuedJob(alice);
    const claimed = (await claim("worker-1")).rows[0];

    const released = await release(jobId, claimed, "completed");
    expect(released.rows).toHaveLength(1);
    expect((await jobRow(jobId)).status).toBe("completed");
  });

  it("stops a revived worker from overwriting the run that replaced it", async () => {
    const { jobId } = await seedQueuedJob(alice);
    const stalled = (await claim("worker-1")).rows[0];

    // worker-1 stalls, is reclaimed, and worker-2 picks the job up.
    await backdateLock(jobId, 1_800);
    await reclaim(900);
    await claim("worker-2");

    // worker-1 wakes up and tries to mark its long-dead run complete.
    const released = await release(jobId, stalled, "completed");
    expect(released.rows).toHaveLength(0);

    // The live run still owns the job.
    const job = await jobRow(jobId);
    expect(job.status).toBe("processing");
    expect(job.locked_by).toBe("worker-2");
  });
});

describe("reclaim privileges", () => {
  it("is callable by the service role", async () => {
    await expect(db.asServiceRole(() => reclaim(900))).resolves.toBeDefined();
  });

  it("is not callable by an ordinary authenticated user", async () => {
    await expect(db.asUser(alice, () => reclaim(900))).rejects.toThrow(/permission denied/i);
  });

  it("does not let a user reach another user's ingestion jobs directly", async () => {
    await seedQueuedJob(alice);
    const visibleToBob = await db.asUser(bob, async () =>
      (await db.sql.query(`SELECT id FROM public.ingestion_jobs`)).rows,
    );
    expect(visibleToBob).toHaveLength(0);
  });
});
