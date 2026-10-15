import test from "node:test";
import assert from "node:assert/strict";
import { ListmonkClient } from "../../marketing/listmonk-client.mjs";

test("real isolated listmonk fixture authenticates, writes lists and distinguishes missing resources", async () => {
  assert.equal(process.env.LISTMONK_TEST_URL, "http://127.0.0.1:19000");
  const client = new ListmonkClient({
    url: process.env.LISTMONK_TEST_URL,
    user: "fixture-api",
    token: "fixture-api-token-only",
  });
  const created = await client.request("POST", "/api/lists", {
    name: `Fixture ${Date.now()}`,
    type: "private",
    optin: "single",
    tags: ["fixture"],
  });
  assert.ok(created.id > 0);
  assert.equal(
    (await client.request("GET", `/api/lists/${created.id}`)).name,
    created.name,
  );
  const listing = await client.request("GET", "/api/lists?minimal=true");
  assert.ok(listing.results.some((row) => row.id === created.id));
  await client.request("DELETE", `/api/lists/${created.id}`);
  await assert.rejects(
    client.request("GET", `/api/lists/${created.id}`),
    (error) => error.code === "NOT_FOUND",
  );
});
