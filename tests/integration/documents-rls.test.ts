/**
 * Row- and column-level access control on `documents`.
 *
 * The row-level half was already correct: the shipped UPDATE policy carries both
 * USING and WITH CHECK on `auth.uid() = user_id`. The gap was column-level — the
 * owner of a document could rewrite state that only the ingestion worker has any
 * business setting. Both halves are pinned here so neither can regress.
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
  await db.sql.exec(`DELETE FROM public.documents;`);
  alice = await db.createUser("alice@example.test");
  bob = await db.createUser("bob@example.test");
});

async function seedDocument(userId: string, title = "paper.pdf") {
  return (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.documents (user_id, title, file_type, status, file_path, extraction_error)
       VALUES ($1,$2,'pdf','pending',$3,'Parsing failed') RETURNING id`,
      [userId, title, `${userId}/${title}`],
    )
  ).rows[0].id;
}

const documentRow = async (id: string) =>
  (
    await db.sql.query<{
      status: string;
      title: string;
      extraction_error: string | null;
      user_id: string;
    }>(`SELECT status, title, extraction_error, user_id FROM public.documents WHERE id = $1`, [id])
  ).rows[0];

describe("row-level ownership", () => {
  it("rejects an update to a document the caller does not own", async () => {
    const id = await seedDocument(alice);

    const result = await db.asUser(bob, () =>
      db.sql.query(`UPDATE public.documents SET title = 'stolen' WHERE id = $1`, [id]),
    );

    expect(result.affectedRows).toBe(0);
    expect((await documentRow(id)).title).toBe("paper.pdf");
  });

  it("rejects reassigning a document to another user", async () => {
    const id = await seedDocument(alice);

    // Two independent layers stop this. The policy's WITH CHECK always did;
    // since `user_id` is outside the column grant, the privilege check now
    // rejects it before RLS is consulted at all.
    await expect(
      db.asUser(alice, () =>
        db.sql.query(`UPDATE public.documents SET user_id = $2 WHERE id = $1`, [id, bob]),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    expect((await documentRow(id)).user_id).toBe(alice);
  });

  it("does not reveal another user's documents", async () => {
    await seedDocument(alice);
    const visible = await db.asUser(bob, async () =>
      (await db.sql.query(`SELECT id FROM public.documents`)).rows,
    );
    expect(visible).toHaveLength(0);
  });

  it("rejects deleting a document the caller does not own", async () => {
    const id = await seedDocument(alice);
    const result = await db.asUser(bob, () =>
      db.sql.query(`DELETE FROM public.documents WHERE id = $1`, [id]),
    );
    expect(result.affectedRows).toBe(0);
    expect(await documentRow(id)).toBeDefined();
  });
});

describe("column-level write surface", () => {
  it("refuses to let an owner forge ingestion state", async () => {
    const id = await seedDocument(alice);

    // The actual pre-fix hole: this succeeded, marking a document that never
    // ingested as searchable.
    await expect(
      db.asUser(alice, () =>
        db.sql.query(`UPDATE public.documents SET status = 'ready' WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/permission denied/i);

    expect((await documentRow(id)).status).toBe("pending");
  });

  it("refuses to let an owner clear a real extraction error", async () => {
    const id = await seedDocument(alice);

    await expect(
      db.asUser(alice, () =>
        db.sql.query(`UPDATE public.documents SET extraction_error = NULL WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/permission denied/i);

    expect((await documentRow(id)).extraction_error).toBe("Parsing failed");
  });

  it("refuses to let an owner rewrite derived ingestion metadata", async () => {
    const id = await seedDocument(alice);

    for (const column of ["processed_at = NOW()", "content_hash = 'forged'", "file_path = 'x'"]) {
      await expect(
        db.asUser(alice, () =>
          db.sql.query(`UPDATE public.documents SET ${column} WHERE id = $1`, [id]),
        ),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("still allows an owner to rename their own document", async () => {
    const id = await seedDocument(alice);

    const result = await db.asUser(alice, () =>
      db.sql.query(`UPDATE public.documents SET title = 'renamed.pdf' WHERE id = $1`, [id]),
    );

    expect(result.affectedRows).toBe(1);
    expect((await documentRow(id)).title).toBe("renamed.pdf");
  });

  it("does not let renaming become a way in to another user's row", async () => {
    const id = await seedDocument(alice);
    const result = await db.asUser(bob, () =>
      db.sql.query(`UPDATE public.documents SET title = 'stolen' WHERE id = $1`, [id]),
    );
    expect(result.affectedRows).toBe(0);
  });

  it("leaves the ingestion worker able to write everything it owns", async () => {
    const id = await seedDocument(alice);

    // The service role is how ingestion legitimately sets this state.
    const result = await db.asServiceRole(() =>
      db.sql.query(
        `UPDATE public.documents
         SET status = 'ready', extraction_error = NULL, processed_at = NOW()
         WHERE id = $1`,
        [id],
      ),
    );

    expect(result.affectedRows).toBe(1);
    expect((await documentRow(id)).status).toBe("ready");
  });
});
