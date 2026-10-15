import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { MarketingRepository } from "../../marketing/repository.mjs";
import { Assets } from "../../marketing/assets.mjs";
import { createApp } from "../../server.mjs";
import { Store } from "../../store.mjs";
test("uploaded raster images survive database reload and are public without an admin cookie", async () => {
  const pool = new pg.Pool({
    connectionString: process.env.MARKETING_TEST_DATABASE_URL,
  });
  const repository = new MarketingRepository(pool);
  await repository.migrate();
  const assets = new Assets(repository),
    store = new Store(":memory:", "a".repeat(64));
  const app = createApp({
    store,
    password: "fixture-password-only",
    publicURL: "http://localhost:9100",
    gateway: {},
    worker: {},
    marketing: { assets },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const content =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG3cAAAAASUVORK5CYII=";
    const uploaded = await assets.upload({
      content,
      mime: "image/png",
      name: "Fixture.png",
      alt: "Fixture",
    });
    assert.equal(
      (await new Assets(repository).get(uploaded.id)).mime,
      "image/png",
    );
    const response = await fetch(
      `http://127.0.0.1:${app.address().port}${uploaded.url}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from(content, "base64"),
    );
    await assert.rejects(
      assets.upload({
        content: Buffer.from('<svg onload="alert(1)"/>').toString("base64"),
        mime: "image/svg+xml",
      }),
    );
    await assert.rejects(assets.remote({ url: "https://127.0.0.1/private" }));
  } finally {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    store.close();
    await pool.end();
  }
});
