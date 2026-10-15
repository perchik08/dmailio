import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createApp } from "../../server.mjs";
import { Store } from "../../store.mjs";

test("marketing namespace uses existing session and same-origin protection", async () => {
  const store = new Store(":memory:", "a".repeat(64));
  const app = createApp({
    store,
    gateway: {},
    worker: {},
    password: "fixture-password-only",
    publicURL: "http://localhost:9100",
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(`${url}/api/marketing/contacts`)).status, 401);
    const rejected = await fetch(`${url}/api/marketing/contacts`, {
      method: "POST",
      headers: { Origin: "https://foreign.invalid" },
      body: "{}",
    });
    assert.equal(rejected.status, 403);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    store.close();
  }
});

test("PostgreSQL fixture requires a distinct test database and rolls back writes", async () => {
  assert.ok(
    process.env.MARKETING_TEST_DATABASE_URL,
    "Run with an isolated PostgreSQL fixture; absence is not PASS",
  );
  const client = new pg.Client({
    connectionString: process.env.MARKETING_TEST_DATABASE_URL,
  });
  await client.connect();
  try {
    const result = await client.query("SELECT current_database() AS name");
    assert.equal(result.rows[0].name, "marketing_test");
    await client.query("BEGIN");
    await client.query(
      "CREATE TEMP TABLE marketing_fixture_probe (id int PRIMARY KEY)",
    );
    await client.query("INSERT INTO marketing_fixture_probe VALUES (1)");
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM marketing_fixture_probe",
        )
      ).rows[0].n,
      1,
    );
    await client.query("ROLLBACK");
    assert.equal(
      (
        await client.query(
          "SELECT to_regclass('pg_temp.marketing_fixture_probe') AS name",
        )
      ).rows[0].name,
      null,
    );
  } finally {
    await client.end();
  }
});
