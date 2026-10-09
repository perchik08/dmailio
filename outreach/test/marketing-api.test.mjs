import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ListmonkClient } from "../marketing/listmonk-client.mjs";
import { MarketingAPI } from "../marketing/api.mjs";
import { pagination, MarketingError } from "../marketing/contracts.mjs";
import { createApp } from "../server.mjs";
import { Store } from "../store.mjs";

test("pagination rejects SQL and unknown filters, caps page sizes", () => {
  assert.deepEqual(pagination(new URLSearchParams("page=2&perPage=25")), {
    page: 2,
    perPage: 25,
  });
  assert.throws(
    () => pagination(new URLSearchParams("query=DROP TABLE subscribers")),
    MarketingError,
  );
  assert.throws(
    () => pagination(new URLSearchParams("perPage=1001")),
    MarketingError,
  );
  assert.throws(
    () => pagination(new URLSearchParams("page=1.5")),
    MarketingError,
  );
});

test("listmonk adapter bounds requests, hides upstream credentials and never treats failure as empty data", async () => {
  const app = createServer((req, res) => {
    assert.equal(
      req.headers.authorization,
      "token fixture-user:fixture-secret",
    );
    if (req.url === "/api/lists")
      return res.end(JSON.stringify({ data: { results: [], total: 0 } }));
    if (req.url === "/api/subscribers") {
      res.writeHead(503);
      return res.end("fixture-secret postgres://password");
    }
    res.writeHead(302, { Location: "https://foreign.invalid" });
    res.end();
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const client = new ListmonkClient({
    url: `http://127.0.0.1:${app.address().port}`,
    user: "fixture-user",
    token: "fixture-secret",
    timeout: 100,
  });
  try {
    assert.equal((await client.request("GET", "/api/lists")).total, 0);
    await assert.rejects(
      client.request("GET", "/api/subscribers"),
      (e) =>
        e.code === "LISTMONK_UNAVAILABLE" &&
        !e.message.includes("fixture-secret"),
    );
    await assert.rejects(
      client.request("GET", "https://foreign.invalid"),
      MarketingError,
    );
    await assert.rejects(
      client.request("GET", "/api/settings"),
      MarketingError,
    );
    await assert.rejects(
      client.request("GET", "/api/lists/1"),
      (e) => e.code === "LISTMONK_UNAVAILABLE",
    );
  } finally {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  }
});

test("marketing routes share login, use structured errors and never expose server configuration", async () => {
  const store = new Store(":memory:", "a".repeat(64));
  const marketing = new MarketingAPI({
    repository: { health: async () => true },
    listmonk: {
      request: async () => {
        throw new Error("private-secret");
      },
    },
  });
  const app = createApp({
    store,
    marketing,
    gateway: {},
    worker: {},
    password: "fixture-password-only",
    publicURL: "http://localhost:9100",
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const unauth = await fetch(base + "/api/marketing/status");
    assert.equal(unauth.status, 401);
    assert.equal((await unauth.json()).code, "UNAUTHENTICATED");
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: "http://localhost:9100" },
      body: JSON.stringify({ password: "fixture-password-only" }),
    });
    const response = await fetch(base + "/api/marketing/status", {
      headers: { Cookie: login.headers.get("set-cookie").split(";")[0] },
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), [
      "code",
      "fields",
      "message",
      "retryable",
    ]);
    assert.ok(!JSON.stringify(body).includes("private-secret"));
  } finally {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    store.close();
  }
});
