import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { MarketingRepository } from "../../marketing/repository.mjs";
import { Letters } from "../../marketing/letters.mjs";
test("letters persist independent sources, immutable versions and run snapshots; stale edits return conflict", async () => {
  const pool = new pg.Pool({
    connectionString: process.env.MARKETING_TEST_DATABASE_URL,
  });
  const repository = new MarketingRepository(pool);
  await repository.migrate();
  const service = new Letters(repository);
  try {
    const first = await service.create({
      title: "Fixture letter",
      subject: "Subject",
      editorMode: "html",
      source: "<p>One</p>",
    });
    const run = randomUUID();
    await pool.query(
      "INSERT INTO marketing.runs(id,state,document_id,snapshot) VALUES($1,'completed',$2,$3)",
      [run, first.id, JSON.stringify(first)],
    );
    const next = await service.update(first.id, {
      expectedVersion: first.version,
      source: "<p>Two</p>",
    });
    assert.equal(next.version, 2);
    await assert.rejects(
      service.update(first.id, {
        expectedVersion: first.version,
        source: "Lost",
      }),
      { code: "VERSION_CONFLICT" },
    );
    assert.equal(
      (await service.versions(first.id))[0].data.source,
      "<p>One</p>",
    );
    assert.equal(
      (
        await pool.query("SELECT snapshot FROM marketing.runs WHERE id=$1", [
          run,
        ])
      ).rows[0].snapshot.source,
      "<p>One</p>",
    );
    const copy = await service.copy(first.id);
    assert.notEqual(copy.id, first.id);
    assert.equal(copy.source, "<p>Two</p>");
    const archived = await service.update(first.id, {
      expectedVersion: next.version,
      archived: true,
    });
    assert.equal(archived.archived, true);
    assert.equal(
      (
        await service.page(
          new URLSearchParams({ archived: "true", search: "Fixture letter" }),
        )
      ).items[0].runCount,
      1,
    );
    assert.equal(
      (
        await service.update(first.id, {
          expectedVersion: archived.version,
          archived: false,
        })
      ).archived,
      false,
    );
    const builder = await service.create({
      title: "Builder persisted",
      editorMode: "builder",
      source: JSON.stringify({
        schemaVersion: 1,
        document: {
          root: { type: "EmailLayout", data: { childrenIds: ["heading"] } },
          heading: {
            type: "Heading",
            data: { props: { text: "Persisted builder" } },
          },
        },
      }),
    });
    assert.match(builder.renderedHtml, /Persisted builder/);
    const reloaded = await new Letters(repository).get(builder.id);
    assert.deepEqual(JSON.parse(reloaded.source), JSON.parse(builder.source));
  } finally {
    await pool.end();
  }
});
