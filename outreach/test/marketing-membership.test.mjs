import test from "node:test";
import assert from "node:assert/strict";
import { Lists } from "../marketing/lists.mjs";
test("adding consented contacts uses insert-only confirmed membership without reviving an opt-out", async () => {
  const requests = [],
    list = "00000000-0000-4000-8000-000000000001",
    contact = "00000000-0000-4000-8000-000000000002";
  const service = new Lists(
    {
      request: async (...args) => {
        requests.push(args);
        return true;
      },
    },
    { externalId: async (kind) => (kind === "list" ? 7 : 11) },
    {},
  );
  service.get = async () => ({ archived: false });
  await service.members(list, [contact], "add");
  assert.equal(requests[0][1], "/api/subscribers/query/lists");
  assert.equal(requests[0][2].status, "confirmed");
  assert.match(requests[0][2].query, /consentConfirmed/);
  assert.equal(requests[1][2].status, "unconfirmed");
});
