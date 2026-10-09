import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ListmonkClient } from "../../marketing/listmonk-client.mjs";
import { MarketingRepository } from "../../marketing/repository.mjs";
import { Contacts } from "../../marketing/contacts.mjs";
import { Lists } from "../../marketing/lists.mjs";

test("two overlapping lists share one subscriber; membership removal and editing never clear a block", async () => {
  const pool = new pg.Pool({
    connectionString: process.env.MARKETING_TEST_DATABASE_URL,
  });
  const repository = new MarketingRepository(pool);
  await repository.migrate();
  const client = new ListmonkClient({
    url: process.env.LISTMONK_TEST_URL,
    user: "fixture-api",
    token: "fixture-api-token-only",
  });
  const contacts = new Contacts(client, repository);
  const lists = new Lists(client, repository, contacts);
  try {
    const a = await lists.create({ name: "Group A", tags: ["fixture"] });
    const b = await lists.create({ name: "Group B" });
    const contact = await contacts.create({
      email: `fixture-${Date.now()}@example.invalid`,
      name: "One",
      fields: { company: "ACME" },
      tags: ["fixture"],
      source: "Controlled fixture",
      listIds: [a.id, b.id],
      consentConfirmed: true,
    });
    assert.equal(contact.lists.length, 2);
    await lists.members(a.id, [contact.id], "add");
    assert.equal(
      (await lists.memberPage(a.id, new URLSearchParams())).total,
      1,
    );
    await lists.members(a.id, [contact.id], "remove");
    assert.equal((await contacts.get(contact.id)).lists.length, 1);
    assert.equal(
      (await lists.memberPage(b.id, new URLSearchParams())).total,
      1,
    );
    await client.request(
      "PUT",
      `/api/subscribers/${await repository.externalId("contact", contact.id)}/blocklist`,
      {},
    );
    const blocked = await contacts.get(contact.id);
    await contacts.update(contact.id, {
      ...blocked,
      name: "Edited",
      enabled: true,
      listIds: [b.id],
    });
    assert.equal((await contacts.get(contact.id)).status, "blocked");
    assert.equal((await lists.audience([b.id])).eligible, 0);
    const archived = await lists.update(b.id, { ...b, archived: true });
    assert.equal(archived.archived, true);
    assert.equal(
      (await lists.memberPage(b.id, new URLSearchParams())).total,
      1,
    );
  } finally {
    await pool.end();
  }
});
