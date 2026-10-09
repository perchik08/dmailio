import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { MarketingRepository } from "../../marketing/repository.mjs";

test("PostgreSQL migrations, immutable versions, operation deduplication and optimistic locking survive reconnect", async () => {
  assert.ok(process.env.MARKETING_TEST_DATABASE_URL);
  const pool = new pg.Pool({
    connectionString: process.env.MARKETING_TEST_DATABASE_URL,
  });
  assert.equal(
    (await pool.query("SELECT current_database() name")).rows[0].name,
    "marketing_test",
  );
  await pool.query("DROP SCHEMA IF EXISTS marketing CASCADE");
  const repo = new MarketingRepository(pool);
  try {
    await repo.migrate();
    await repo.migrate();
    const first = await repo.createDocument({
      title: "One",
      subject: "Hello",
      editorMode: "html",
      source: "<p>One</p>",
    });
    const next = await repo.updateDocument(first.id, first.version, {
      ...first,
      title: "Two",
    });
    await assert.rejects(
      repo.updateDocument(first.id, first.version, { ...first, title: "Lost" }),
      (e) => e.code === "VERSION_CONFLICT",
    );
    const versions = await repo.versions(first.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].data.title, "One");
    assert.equal(next.version, 2);
    const [a, b] = await Promise.all([
      repo.operation("fixture-op", { x: 1 }, async () => ({ id: first.id })),
      repo.operation("fixture-op", { x: 1 }, async () => ({ id: "WRONG" })),
    ]);
    assert.deepEqual(a, b);
    await assert.rejects(
      repo.operation("fixture-op", { x: 2 }, async () => ({})),
      (e) => e.code === "OPERATION_CONFLICT",
    );
    const restored = new MarketingRepository(pool);
    assert.equal((await restored.document(first.id)).data.title, "Two");
    assert.deepEqual(await restored.operationResult("fixture-op"), a);
  } finally {
    await pool.end();
  }
});
