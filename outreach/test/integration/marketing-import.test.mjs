import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { MarketingRepository } from "../../marketing/repository.mjs";
import { ListmonkClient } from "../../marketing/listmonk-client.mjs";
import { Contacts } from "../../marketing/contacts.mjs";
import { Lists } from "../../marketing/lists.mjs";
import { Imports } from "../../marketing/import.mjs";

test("persistent import retries after remote commit without duplicates; updates preserve blocks and nonempty fields", async () => {
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
  const contacts = new Contacts(client, repository),
    lists = new Lists(client, repository, contacts),
    imports = new Imports(contacts, lists, repository);
  const wait = async (service, id, state) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const job = await service.get(id);
      if (job.state === state) return service.result(job);
      if (job.state === "paused" && state !== "paused")
        throw new Error(job.error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Import did not finish");
  };
  try {
    const list = await lists.create({ name: "Import fixture" }),
      email = `import-${Date.now()}@example.invalid`;
    const value = {
      operationId: randomUUID(),
      file: {
        format: "csv",
        content: `Email;Компания\n${email};ACME\n${email};Duplicate\nbad;Bad`,
      },
      mappings: [
        { columnId: "column-0", target: "email" },
        { columnId: "column-1", target: "company" },
      ],
      source: "Import fixture",
      duplicates: "skip",
      listIds: [list.id],
      consentConfirmed: true,
    };
    const create = contacts.create.bind(contacts);
    let interrupted = false;
    contacts.create = async (...args) => {
      const contact = await create(...args);
      if (!interrupted) {
        interrupted = true;
        throw new Error("Connection dropped after remote commit");
      }
      return contact;
    };
    await imports.start(value);
    await wait(imports, value.operationId, "paused");
    const restarted = new Imports(
      new Contacts(client, repository),
      lists,
      repository,
    );
    await restarted.resume(value.operationId);
    const result = await wait(restarted, value.operationId, "completed");
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.rejected, 1);
    assert.equal((await restarted.start(value)).state, "completed");
    await assert.rejects(restarted.start({ ...value, source: "Different" }), {
      code: "OPERATION_CONFLICT",
    });
    const contact = await contacts.findEmail(email);
    assert.equal(
      (await contacts.page(new URLSearchParams({ search: email }))).total,
      1,
    );
    const external = await repository.externalId("contact", contact.id);
    await client.request("PUT", `/api/subscribers/${external}/blocklist`, {});
    const update = {
      ...value,
      operationId: randomUUID(),
      duplicates: "update",
      file: { format: "csv", content: `Email;Компания\n${email};` },
    };
    await restarted.start(update);
    assert.equal(
      (await wait(restarted, update.operationId, "completed")).updated,
      1,
    );
    const after = await contacts.get(contact.id);
    assert.equal(after.status, "blocked");
    assert.equal(after.fields.company, "ACME");
    assert.match(
      (await restarted.report(value.operationId)).toString(),
      /Повтор email/,
    );
  } finally {
    await pool.end();
  }
});
