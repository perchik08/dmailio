import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import { createApp } from "../server.mjs";
const mailbox = {
  email: "sender@example.com",
  name: "Sender",
  limit: 100,
  smtp: {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    user: "sender@example.com",
    password: "secret",
  },
  imap: {
    host: "imap.example.com",
    port: 993,
    secure: true,
    user: "sender@example.com",
    password: "secret",
  },
};

test("full inbox routes require login and origin and expose ordinary received mail", async () => {
  const store = new Store(":memory:", "a".repeat(64));
  const app = createApp({
    store,
    password: "test-password-long",
    publicURL: "http://localhost:9100",
    gateway: {},
    worker: {},
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(base + "/api/mailbox/messages")).status, 401);
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { origin: "http://localhost:9100" },
      body: JSON.stringify({ password: "test-password-long" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const response = await fetch(base + "/api/mailbox/messages", {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).total, 0);
    assert.equal(
      (
        await fetch(base + "/api/mailbox/send", {
          method: "POST",
          headers: { cookie, origin: "http://evil.test" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/mailbox/messages/missing", {
          headers: { cookie },
        })
      ).status,
      404,
    );
  } finally {
    await new Promise((resolve) => app.close(resolve));
    store.close();
  }
});

test("ingestAll preserves ordinary incoming and still stops a campaign on a related reply", () => {
  const s = new Store(":memory:", "a".repeat(64));
  try {
    const m = s.saveMailbox(mailbox);
    s.markMailbox(m.id, true);
    const ordinary = s.ingestAll(m.id, {
      uid: 1,
      validity: "1",
      folder: "Custom",
      remoteId: "Custom:1:1",
      identity: "ordinary",
      from: "stranger@example.com",
      subject: "Обычная почта",
      text: "Не из кампании",
      internalDate: Date.now(),
      flags: [],
      attachments: [],
    });
    assert.equal(s.fullInbox.get(ordinary.id).text, "Не из кампании");
    const c = s.saveCampaign({
      name: "Test",
      mailboxIds: [m.id],
      steps: [{ subject: "Test", body: "Body", delay: 0 }],
    });
    s.importContacts(c.id, [{ email: "lead@example.com", fields: {} }]);
    const lead = s.campaign(c.id).leads[0];
    const sent = s.insertMessage(
      {
        mailbox_id: m.id,
        campaign_id: c.id,
        lead_id: lead.id,
        kind: "manual",
        recipient: lead.email,
        subject: "Test",
        body: "Body",
      },
      Date.now(),
    );
    s.finish(sent.id, "sent");
    const inbound = {
      uid: 2,
      validity: "1",
      folder: "Spam",
      remoteId: "Spam:1:2",
      identity: "reply",
      messageId: "<reply@test>",
      references: [sent.message_id],
      from: lead.email,
      text: "Да",
      subject: "Re: Test",
      internalDate: Date.now(),
      type: "reply",
      attachments: [],
    };
    const reply = s.ingestAll(m.id, inbound);
    assert.equal(s.campaign(c.id).leads[0].status, "replied");
    assert.equal(s.fullInbox.get(reply.id).campaignId, c.id);
    const duplicate = s.ingestAll(m.id, {
      ...inbound,
      folder: "Archive",
      uid: 5,
      remoteId: "Archive:1:5",
    });
    assert.equal(duplicate.fresh, false);
    assert.equal(s.fullInbox.list().total, 2);
    assert.deepEqual(s.fullInbox.get(reply.id).folders, ["Archive", "Spam"]);
  } finally {
    s.close();
  }
});

test("ordinary send API reserves once and does not deliver repeated requests", async () => {
  const store = new Store(":memory:", "a".repeat(64));
  const m = store.saveMailbox(mailbox);
  store.markMailbox(m.id, true);
  let deliveries = 0;
  const app = createApp({
    store,
    password: "test-password-long",
    publicURL: "http://localhost:9100",
    gateway: {},
    worker: {
      deliver: async (msg) => {
        deliveries++;
        store.finish(msg.id, "sent");
      },
    },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { origin: "http://localhost:9100" },
      body: JSON.stringify({ password: "test-password-long" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const input = {
      mailboxId: m.id,
      to: ["friend@example.com"],
      subject: "Привет",
      body: "Проверка",
      format: "plain",
      requestId: "same-request",
    };
    for (let i = 0; i < 2; i++) {
      const response = await fetch(base + "/api/mailbox/send", {
        method: "POST",
        headers: {
          cookie,
          origin: "http://localhost:9100",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "sent");
    }
    assert.equal(deliveries, 1);
    assert.equal(store.fullInbox.list({ view: "sent" }).total, 1);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    store.close();
  }
});
