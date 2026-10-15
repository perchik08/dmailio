import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import { MailGateway } from "../mail.mjs";
import { Worker } from "../worker.mjs";
const input = {
  email: "detach@example.com",
  name: "Detach",
  limit: 30,
  smtp: {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    password: "fixture-smtp-only",
  },
  imap: {
    host: "imap.example.com",
    port: 993,
    secure: true,
    password: "fixture-imap-only",
  },
};
function setup(t) {
  const store = new Store(":memory:", "a".repeat(64));
  t.after(() => store.close());
  const box = store.saveMailbox(input);
  store.markMailbox(box.id, true);
  return { store, box };
}
test("disconnect erases stored passwords, pauses warmup/campaigns and preserves all history; repeat is safe", (t) => {
  const { store, box } = setup(t);
  store.warmup(box.id, { enabled: true, consent: true });
  const campaign = store.saveCampaign({
    name: "History",
    mailboxIds: [box.id],
    steps: [{ subject: "S", body: "B", delay: 0 }],
  });
  store.db
    .prepare("UPDATE campaigns SET status='active' WHERE id=?")
    .run(campaign.id);
  const msg = store.insertMessage(
    {
      mailbox_id: box.id,
      kind: "mail",
      recipient: "r@example.com",
      subject: "History",
      body: "Keep",
    },
    1000,
  );
  store.finish(msg.id, "sent", 1001);
  store.dispatch.save(box.id, { enabled: true });
  store.db
    .prepare("INSERT INTO marketing_sender_default(id,mailbox_id) VALUES(1,?)")
    .run(box.id);
  const result = store.disconnectMailbox(box.id, 2000);
  assert.equal(result.detached, true);
  assert.equal(result.enabled, false);
  assert.equal(result.verified, false);
  assert.equal(result.warmup.enabled, false);
  assert.equal(result.warmup.consent, false);
  assert.equal(
    store.db.prepare("SELECT secrets FROM mailboxes WHERE id=?").get(box.id)
      .secrets,
    "",
  );
  assert.throws(() => store.mailbox(box.id, true), /отключ/);
  assert.equal(store.message(msg.id).body, "Keep");
  assert.equal(store.campaign(campaign.id).status, "paused");
  assert.equal(store.dispatch.policy(box.id).enabled, false);
  assert.equal(
    store.db
      .prepare("SELECT mailbox_id FROM marketing_sender_default WHERE id=1")
      .get().mailbox_id,
    null,
  );
  assert.equal(store.available(box.id, 100000), false);
  assert.deepEqual(store.disconnectMailbox(box.id, 3000), result);
});
test("disconnect waits for active I/O; stale completions cannot verify or sync a reconnected mailbox", (t) => {
  const { store, box } = setup(t);
  const snapshot = store.mailbox(box.id, true);
  const token = store.beginMailboxIO(snapshot, 1000);
  assert.throws(
    () => store.disconnectMailbox(box.id, 1001),
    (e) => e.status === 409 && e.code === "MAILBOX_BUSY",
  );
  assert.equal(store.mailbox(box.id).detached, false);
  store.endMailboxIO(token);
  store.disconnectMailbox(box.id, 2000);
  assert.throws(
    () =>
      store.saveMailbox({
        ...input,
        id: box.id,
        smtp: { ...input.smtp, password: "" },
      }),
    /парол/,
  );
  const restored = store.saveMailbox(input);
  assert.equal(restored.id, box.id);
  assert.equal(restored.detached, false);
  assert.equal(restored.verified, false);
  assert.equal(restored.warmup.enabled, false);
  assert.throws(() => store.assertMailboxConnection(snapshot), /измен|отключ/);
  store.markMailbox(box.id, true, "", snapshot.connectionRevision);
  assert.equal(store.mailbox(box.id).verified, false);
  store.synced(box.id, { uid: 7 }, 3000, snapshot.connectionRevision);
  assert.equal(store.mailbox(box.id).lastSync, 0);
  assert.throws(() => store.saveMailbox(input), /уже подключ/);
});
test("gateway leases protect in-flight SMTP and detached mailboxes never reach a transport", async (t) => {
  const { store, box } = setup(t);
  const gateway = new MailGateway(store, "https://example.com");
  let release,
    calls = 0;
  gateway.transport = () => ({
    sendMail: () => {
      calls++;
      return new Promise(
        (resolve) =>
          (release = () =>
            resolve({
              accepted: ["r@example.com"],
              messageId: "<id@example.com>",
            })),
      );
    },
    close() {},
  });
  const pending = gateway.sendMarketing(store.mailbox(box.id, true), {
    recipient: "r@example.com",
    subject: "S",
    text: "B",
    html: "<p>B</p>",
    messageId: "<id@example.com>",
  });
  assert.equal(calls, 1);
  assert.throws(
    () => store.disconnectMailbox(box.id),
    (e) => e.code === "MAILBOX_BUSY",
  );
  release();
  await pending;
  const stale = store.mailbox(box.id, true);
  store.disconnectMailbox(box.id);
  await assert.rejects(
    gateway.sendMarketing(stale, { recipient: "r@example.com" }),
    /отключ/,
  );
  assert.equal(calls, 1);
});
test("worker never synchronizes disconnected accounts or changes their preserved history", async (t) => {
  const { store, box } = setup(t);
  store.disconnectMailbox(box.id);
  let calls = 0;
  await new Worker(store, {
    sync: async () => {
      calls++;
    },
    send: async () => {
      calls++;
    },
  }).tick();
  assert.equal(calls, 0);
  assert.equal(store.mailbox(box.id).lastSync, 0);
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.mjs";
test("connection saves and late completion guards hold a write lock across snapshot and update", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "disconnect-race-"));
  const s = new Store(join(dir, "test.sqlite"), "a".repeat(64));
  const other = new Store(join(dir, "test.sqlite"), "a".repeat(64));
  other.db.exec("PRAGMA busy_timeout=1");
  t.after(() => {
    other.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const box = s.saveMailbox(input);
  let checks = 0;
  const originalSeal = s.seal.bind(s);
  s.seal = (value) => {
    assert.throws(() => other.disconnectMailbox(box.id), /locked|busy/i);
    checks++;
    return originalSeal(value);
  };
  s.saveMailbox({
    ...input,
    id: box.id,
    smtp: { ...input.smtp, password: "" },
    imap: { ...input.imap, password: "" },
  });
  s.seal = originalSeal;
  const originalMailbox = s.mailbox.bind(s);
  s.mailbox = (...args) => {
    const result = originalMailbox(...args);
    assert.throws(() => other.disconnectMailbox(box.id), /locked|busy/i);
    checks++;
    return result;
  };
  const revision = originalMailbox(box.id).connectionRevision;
  s.markMailbox(box.id, true, "", revision);
  s.synced(box.id, { since: 123 }, Date.now(), revision);
  s.syncError(box.id, revision);
  assert.equal(checks, 5);
  s.mailbox = originalMailbox;
  const token = other.beginMailboxIO(originalMailbox(box.id));
  assert.throws(
    () => s.disconnectMailbox(box.id),
    (e) => e.code === "MAILBOX_BUSY",
  );
  other.endMailboxIO(token);
  s.disconnectMailbox(box.id);
  assert.equal(other.mailbox(box.id).detached, true);
});
test("authenticated disconnect API preserves historical reading and rejects provider mutations", async (t) => {
  const { store, box } = setup(t);
  let calls = 0;
  const received = store.ingestAll(box.id, {
    uid: 1,
    validity: "1",
    folder: "Inbox",
    remoteId: "Inbox:1:1",
    identity: "disconnect-history",
    from: "r@example.com",
    subject: "History",
    text: "Keep",
    internalDate: Date.now(),
    flags: [],
    attachments: [],
  });
  const app = createApp({
    store,
    password: "fixture-password-only",
    publicURL: "http://localhost:9100",
    gateway: {
      updateFullMessage: async () => {
        calls++;
      },
    },
    worker: {},
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`,
    path = `/api/mailboxes/${box.id}/disconnect`;
  assert.equal(
    (
      await fetch(base + path, {
        method: "POST",
        headers: { origin: "http://localhost:9100" },
        body: "{}",
      })
    ).status,
    401,
  );
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { origin: "http://localhost:9100" },
    body: JSON.stringify({ password: "fixture-password-only" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const post = (url, data = {}, origin = "http://localhost:9100") =>
    fetch(base + url, {
      method: "POST",
      headers: { cookie, origin },
      body: JSON.stringify(data),
    });
  assert.equal((await post(path, {}, "http://evil.test")).status, 403);
  const token = store.beginMailboxIO(store.mailbox(box.id, true));
  const busy = await post(path);
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, "MAILBOX_BUSY");
  store.endMailboxIO(token);
  assert.equal((await post(path)).status, 200);
  assert.equal((await post(path)).status, 200);
  const history = await fetch(base + `/api/mailbox/messages/${received.id}`, {
    headers: { cookie },
  });
  assert.equal(history.status, 200);
  assert.equal((await history.json()).text, "Keep");
  for (const action of ["read", "star"])
    assert.equal(
      (await post(`/api/mailbox/messages/${received.id}/action`, { action }))
        .status,
      200,
    );
  for (const action of ["archive", "spam", "trash"])
    assert.notEqual(
      (await post(`/api/mailbox/messages/${received.id}/action`, { action }))
        .status,
      200,
    );
  assert.equal(calls, 0);
});
