import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import { Senders } from "../marketing/senders.mjs";
import { MarketingTransport } from "../marketing/transport.mjs";
const mailbox = {
  email: "sender@example.com",
  name: "Анна",
  limit: 3,
  smtp: {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    user: "sender",
    password: "smtp-secret",
  },
  imap: {
    host: "imap.example.com",
    port: 993,
    secure: true,
    user: "sender",
    password: "imap-secret",
  },
};
function setup(
  gateway = {
    verify: async () => ({}),
    sendMarketing: async () => ({
      messageId: "provider-id",
      accepted: ["recipient@example.com"],
    }),
  },
) {
  const store = new Store(":memory:", "a".repeat(64));
  const box = store.saveMailbox(mailbox);
  store.markMailbox(box.id, true);
  const senders = new Senders(store, gateway);
  senders.update(box.id, {
    enabled: true,
    fromName: "Анна",
    replyTo: "reply@example.com",
    providerDailyLimit: 3,
    externalReserve: 0,
    intervalSeconds: 60,
  });
  return {
    store,
    box,
    senders,
    transport: new MarketingTransport(store, gateway, senders),
  };
}
const message = (box) => ({
  mailboxId: box.id,
  recipient: "recipient@example.com",
  subject: "Test",
  text: "Body",
  html: "<p>Body</p>",
  test: true,
});
test("connected mailbox sender profiles are persistent, secret-free and cannot spoof From", () => {
  const { store, box, senders } = setup();
  try {
    const list = senders.page();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].email, mailbox.email);
    assert.equal(list.items[0].eligible, true);
    assert.doesNotMatch(
      JSON.stringify(list),
      /smtp-secret|imap-secret|smtp\.example/,
    );
    assert.throws(() => senders.update(box.id, { from: "other@example.com" }));
    senders.setDefault(box.id);
    assert.equal(senders.page().defaultSenderId, box.id);
    store.markMailbox(box.id, false);
    assert.equal(senders.page().items[0].eligible, false);
    assert.throws(() => senders.setDefault(box.id));
  } finally {
    store.close();
  }
});
test("submit returns accepted once, detects key conflicts and shares quota with outreach", async () => {
  let calls = 0;
  const { store, box, transport } = setup({
    sendMarketing: async () => {
      calls++;
      return { messageId: "provider-id", accepted: ["recipient@example.com"] };
    },
  });
  try {
    const first = await transport.submit(message(box), "request-1", 1000000);
    assert.equal(first.status, "accepted");
    assert.equal(first.providerMessageId, "provider-id");
    assert.deepEqual(
      await transport.submit(message(box), "request-1", 1000000),
      first,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      transport.submit(
        { ...message(box), subject: "Changed" },
        "request-1",
        1000000,
      ),
    );
    assert.equal(store.available(box.id, 1000001), false);
    assert.equal(store.available(box.id, 1060001), true);
    assert.equal(store.dispatch.budget(box.id, 1060001).used, 1);
    assert.equal(store.analytics().sent, 0);
  } finally {
    store.close();
  }
});
test("unknown SMTP outcome is durable and never automatically resubmitted", async () => {
  let calls = 0;
  const { store, box, transport } = setup({
    sendMarketing: async () => {
      calls++;
      throw Object.assign(new Error("secret smtp diagnostic"), {
        code: "ETIMEDOUT",
      });
    },
  });
  try {
    assert.equal(
      (await transport.submit(message(box), "timeout-1", 1000000)).status,
      "unknown",
    );
    assert.equal(
      (await transport.submit(message(box), "timeout-1", 2000000)).status,
      "unknown",
    );
    assert.equal(calls, 1);
    assert.equal(store.dispatch.budget(box.id, 2000000).used, 1);
    assert.doesNotMatch(
      JSON.stringify(transport.result("timeout-1")),
      /secret/,
    );
  } finally {
    store.close();
  }
});
test("provider rate limits pause all sending paths; verification clears hard blocks without sending", async () => {
  let sent = 0;
  const { store, box, senders, transport } = setup({
    verify: async () => ({}),
    sendMarketing: async () => {
      sent++;
      throw Object.assign(new Error("quota"), {
        responseCode: 421,
        definitive: true,
      });
    },
  });
  try {
    assert.equal(
      (await transport.submit(message(box), "rate-1", 1000000)).status,
      "rejected",
    );
    assert.equal(store.available(box.id, 1060000), false);
    assert.equal(store.dispatch.budget(box.id, 1060000).reason, "RATE_LIMIT");
    store.dispatch.fail(box.id, { code: "EAUTH" }, 2000000);
    assert.equal(store.available(box.id, 4000000), false);
    await senders.check(box.id);
    assert.equal(sent, 1);
    assert.equal(store.dispatch.policy(box.id).blocked, false);
  } finally {
    store.close();
  }
});
test("shared quota counts every recipient and honors an external reserve", () => {
  const { store, box, senders } = setup();
  try {
    senders.update(box.id, { externalReserve: 1 });
    const row = store.insertMessage(
      {
        mailbox_id: box.id,
        kind: "mail",
        recipient: "a@example.com, b@example.com",
        subject: "Manual",
        body: "Body",
      },
      1000000,
    );
    store.db
      .prepare("UPDATE messages SET quota_units=2 WHERE id=?")
      .run(row.id);
    assert.equal(store.dispatch.budget(box.id, 1100000).remaining, 0);
    assert.equal(store.available(box.id, 1100000), false);
  } finally {
    store.close();
  }
});
test("production submit requires the subscriber guard; attachments await approved preparation", async () => {
  const { store, box, transport } = setup();
  try {
    await assert.rejects(
      transport.submit({ ...message(box), test: false }, "unguarded", 1000000),
      /подпис/,
    );
    await assert.rejects(
      transport.submit(
        { ...message(box), attachments: [{ path: "/etc/passwd" }] },
        "file-1",
        1000000,
      ),
    );
    assert.equal(store.dispatch.budget(box.id, 1000000).used, 0);
  } finally {
    store.close();
  }
});
import { letterInput } from "../marketing/letters.mjs";
import { Letters } from "../marketing/letters.mjs";
test("new letters use the default but explicit choose-later and copies of disabled senders remain editable", async () => {
  const id = "00000000-0000-4000-8000-000000000007";
  let captured;
  const letters = new Letters({
    createDocument: async (data) => ({ id, data }),
    document: async () => ({
      id,
      data: { title: "Original", senderId: id, source: "Body" },
    }),
  });
  letters.senders = {
    page: () => ({ defaultSenderId: id }),
    eligible: (value) => {
      if (value === id && captured === "disabled")
        throw Object.assign(new Error("disabled"), {
          code: "SENDER_UNAVAILABLE",
        });
    },
  };
  assert.equal(
    (await letters.create({ title: "L", source: "Body" })).senderId,
    id,
  );
  assert.equal(
    (await letters.create({ title: "L", source: "Body", senderId: null }))
      .senderId,
    null,
  );
  captured = "disabled";
  assert.equal(
    (await letters.create({ title: "New", source: "Body" })).senderId,
    null,
  );
  assert.equal((await letters.copy(id)).senderId, null);
});
import { MailGateway } from "../mail.mjs";
test("letter sender selection survives normalization and rejects fabricated IDs", () => {
  const senderId = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    letterInput({ title: "Letter", source: "Body", senderId }).senderId,
    senderId,
  );
  assert.throws(() => letterInput({ title: "Letter", senderId: "not-an-id" }));
});
test("SMTP gateway fixes From to connected mailbox and reports rejection without leaking server diagnostics", async () => {
  const gateway = new MailGateway({}, "https://example.com");
  let payload;
  gateway.transport = () => ({
    sendMail: async (value) => {
      payload = value;
      return {
        accepted: ["recipient@example.com"],
        messageId: "<provider@example.com>",
      };
    },
    close() {},
  });
  const result = await gateway.sendMarketing(mailbox, {
    recipient: "recipient@example.com",
    subject: "Check",
    text: "Text",
    html: "<p>Text</p>",
    fromName: "Name",
    replyTo: "reply@example.com",
    messageId: "<local@example.com>",
  });
  assert.equal(payload.from.address, mailbox.email);
  assert.equal(payload.disableFileAccess, true);
  assert.equal(payload.disableUrlAccess, true);
  assert.equal(result.messageId, "<provider@example.com>");
  gateway.transport = () => ({
    sendMail: async () => ({ accepted: [] }),
    close() {},
  });
  await assert.rejects(
    gateway.sendMarketing(mailbox, { recipient: "recipient@example.com" }),
    (error) => error.definitive === true,
  );
});
import { createApp } from "../server.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
test("independent processes cannot reserve the same quota or idempotency key twice; profiles survive reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dmailio-quota-")),
    path = join(dir, "quota.sqlite");
  let store = new Store(path, "a".repeat(64));
  const box = store.saveMailbox({ ...mailbox, limit: 3 });
  store.markMailbox(box.id, true);
  new Senders(store, {}).update(box.id, {
    enabled: true,
    providerDailyLimit: 3,
  });
  new Senders(store, {}).setDefault(box.id);
  for (let i = 0; i < 2; i++) {
    const row = store.insertMessage(
      {
        mailbox_id: box.id,
        kind: i ? "warmup" : "campaign",
        recipient: "r@example.com",
        subject: "S",
        body: "B",
      },
      800000 + i,
    );
    store.db
      .prepare("UPDATE messages SET status='sent' WHERE id=?")
      .run(row.id);
  }
  store.close();
  const source = `import {Store} from ${JSON.stringify(new URL("../store.mjs", import.meta.url).href)};const s=new Store(process.env.TEST_DB,'a'.repeat(64));try{const r=s.dispatch.reserve(JSON.parse(process.env.TEST_PAYLOAD),process.env.TEST_KEY,1000000);console.log(JSON.stringify({fresh:r.fresh||false,deferred:r.deferred||false}));}finally{s.close();}`;
  const invoke = (key) =>
    promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        env: {
          ...process.env,
          TEST_DB: path,
          TEST_PAYLOAD: JSON.stringify({
            ...message(box),
            fromName: "Анна",
            replyTo: "reply@example.com",
          }),
          TEST_KEY: key,
        },
      },
    ).then((result) => JSON.parse(result.stdout));
  try {
    const results = await Promise.all([
      invoke("concurrent"),
      invoke("concurrent"),
      invoke("another-key"),
    ]);
    assert.equal(results.filter((row) => row.fresh).length, 1);
    store = new Store(path, "a".repeat(64));
    assert.equal(store.dispatch.budget(box.id, 1000000).used, 3);
    assert.equal(new Senders(store, {}).page().defaultSenderId, box.id);
    assert.equal(new Senders(store, {}).get(box.id).marketingEnabled, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("legacy full-inbox reservations backfill recipient units exactly once", () => {
  const { store, box } = setup();
  try {
    const row = store.fullInbox.reserveOutgoing(
      {
        mailboxId: box.id,
        to: ["a@example.com"],
        cc: ["b@example.com"],
        body: "Body",
        subject: "Subject",
        requestId: "legacy",
      },
      1000000,
    );
    store.db.exec("ALTER TABLE messages DROP COLUMN quota_units");
    new store.dispatch.constructor(store);
    assert.equal(store.dispatch.budget(box.id, 1000000).used, 2);
    new store.dispatch.constructor(store);
    assert.equal(store.dispatch.budget(box.id, 1000000).used, 2);
    assert.equal(store.message(row.id).status, "sending");
  } finally {
    store.close();
  }
});
test("sender API uses current login even when newsletter database is unavailable; checks do not send mail", async () => {
  const { store, box } = setup();
  let checks = 0,
    sends = 0;
  const app = createApp({
    store,
    password: "fixture-password-only",
    publicURL: "http://localhost:9100",
    gateway: {
      verify: async () => {
        checks++;
        return {};
      },
      sendMarketing: async () => {
        sends++;
        return { accepted: ["recipient@example.com"] };
      },
    },
    worker: {},
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(base + "/api/marketing/senders")).status, 401);
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: "http://localhost:9100" },
      body: JSON.stringify({ password: "fixture-password-only" }),
    });
    const headers = {
      Cookie: login.headers.get("set-cookie").split(";")[0],
      Origin: "http://localhost:9100",
    };
    const response = await fetch(base + "/api/marketing/senders", { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items.length, 1);
    const checked = await fetch(
      base + `/api/marketing/transports/${box.id}/check`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(checked.status, 200);
    assert.equal(checks, 1);
    assert.equal(sends, 0);
  } finally {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    store.close();
  }
});
