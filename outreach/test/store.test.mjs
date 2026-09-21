import test from "node:test";
import assert from "node:assert/strict";
import * as module from "../store.mjs";
import { defaultSchedule } from "../core.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mailbox = {
  email: "sender@example.com",
  name: "Даниил",
  limit: 2,
  smtp: {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    user: "sender@example.com",
    password: "smtp-secret",
  },
  imap: {
    host: "imap.example.com",
    port: 993,
    secure: true,
    user: "sender@example.com",
    password: "imap-secret",
  },
};
function setup() {
  assert.equal(typeof module.Store, "function");
  const s = new module.Store(":memory:", "a".repeat(64));
  const m = s.saveMailbox(mailbox);
  s.markMailbox(m.id, true);
  const c = s.saveCampaign({
    name: "Test",
    mailboxIds: [m.id],
    schedule: {
      ...defaultSchedule,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "00:00",
      end: "23:59",
      interval: 1,
    },
    steps: [
      { subject: "Тема", body: "{{name}}", delay: 0 },
      { subject: "", body: "Пинг", delay: 3 },
    ],
  });
  s.importContacts(c.id, [
    { email: "lead@example.com", fields: { name: "Иван" } },
  ]);
  s.setCampaignStatus(c.id, "active");
  return { s, m, c };
}
test("encrypted secrets never appear in mailbox API and stored ciphertext", () => {
  const { s, m } = setup();
  assert.equal(JSON.stringify(s.mailboxes()).includes("smtp-secret"), false);
  assert.equal(
    s.db
      .prepare("select secrets from mailboxes")
      .get()
      .secrets.includes("smtp-secret"),
    false,
  );
  assert.equal(s.mailbox(m.id, true).smtp.password, "smtp-secret");
  s.close();
});
test("reservation is exclusive, successful send advances a stable-sender chain", () => {
  const { s, m, c } = setup();
  const now = Date.now();
  const a = s.reserve(now, new Set([m.id]));
  assert.ok(a);
  assert.equal(s.reserve(now, new Set([m.id])), null);
  s.finish(a.id, "sent", now);
  const lead = s.campaign(c.id).leads[0];
  assert.equal(lead.step, 1);
  assert.equal(lead.mailbox_id, m.id);
  assert.equal(lead.due, now + 3 * 86400000);
  s.close();
});
test("correlated reply stops followup and duplicate inbound is idempotent", () => {
  const { s, m, c } = setup();
  const now = Date.now();
  const a = s.reserve(now, new Set([m.id]));
  s.finish(a.id, "sent", now);
  const reply = {
    remoteId: "u1",
    messageId: "<reply@example.com>",
    references: [a.message_id],
    from: "lead@example.com",
    subject: "Re: Тема",
    text: "Да",
    type: "reply",
  };
  s.ingest(m.id, reply, now + 100);
  s.ingest(m.id, reply, now + 200);
  assert.equal(s.campaign(c.id).leads[0].status, "replied");
  assert.equal(s.inbox().length, 1);
  assert.equal(s.reserve(now + 4 * 86400000, new Set([m.id])), null);
  s.close();
});
test("ambiguous send is blocked, not automatically retried", () => {
  const { s, m, c } = setup();
  const now = Date.now();
  const a = s.reserve(now, new Set([m.id]));
  s.finish(a.id, "unknown", now, "connection lost");
  assert.equal(s.campaign(c.id).leads[0].status, "uncertain");
  assert.equal(s.reserve(now + 4 * 86400000, new Set([m.id])), null);
  s.close();
});
test("operator can confirm uncertain delivery without resending the same step", () => {
  const { s, m, c } = setup();
  const now = Date.now();
  const a = s.reserve(now, new Set([m.id]));
  s.finish(a.id, "unknown", now);
  s.resolve(a.id, "sent", now + 1000);
  assert.equal(s.campaign(c.id).leads[0].step, 1);
  assert.equal(s.message(a.id).status, "sent");
  assert.throws(() => s.resolve(a.id, "sent"), /неизвестным/);
  s.close();
});
test("operator cancellation terminates uncertain chain without retry", () => {
  const { s, m, c } = setup();
  const now = Date.now();
  const a = s.reserve(now, new Set([m.id]));
  s.finish(a.id, "unknown", now);
  s.resolve(a.id, "cancel", now + 1000);
  assert.equal(s.campaign(c.id).leads[0].status, "stopped");
  assert.equal(s.reserve(now + 4 * 86400000, new Set([m.id])), null);
  s.close();
});
test("duplicate contact imports do not overwrite campaign state", () => {
  const { s, c } = setup();
  assert.throws(
    () =>
      s.importContacts(c.id, [
        { email: "other@example.com", fields: { name: "X" } },
      ]),
    /черновик/,
  );
  s.close();
});
test("credentials persist across restart and wrong encryption key fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "dmailio-test-"));
  let s;
  try {
    s = new module.Store(join(dir, "test.sqlite"), "a".repeat(64));
    const m = s.saveMailbox(mailbox);
    s.close();
    s = new module.Store(join(dir, "test.sqlite"), "a".repeat(64));
    assert.equal(s.mailbox(m.id, true).smtp.password, "smtp-secret");
    s.close();
    s = new module.Store(join(dir, "test.sqlite"), "b".repeat(64));
    assert.throws(() => s.mailbox(m.id, true));
  } finally {
    s?.close();
    rmSync(dir, { recursive: true });
  }
});
test("opt-out and bounce suppression span campaigns; auto replies do not stop chains", () => {
  const { s, m, c } = setup();
  const now = Date.now();
  const a = s.reserve(now, new Set([m.id]));
  s.finish(a.id, "sent", now);
  s.ingest(
    m.id,
    {
      remoteId: "auto",
      messageId: "<auto@example.com>",
      references: [a.message_id],
      from: "lead@example.com",
      subject: "Away",
      text: "OOO",
      type: "auto",
    },
    now + 1,
  );
  assert.equal(s.campaign(c.id).leads[0].status, "pending");
  s.unsubscribe(a.token);
  assert.equal(s.campaign(c.id).leads[0].status, "unsubscribed");
  assert.equal(s.reserve(now + 4 * 86400000, new Set([m.id])), null);
  s.close();
});
test("unhealthy large campaign does not starve a later healthy campaign", () => {
  const { s, m, c } = setup();
  s.db.prepare("UPDATE campaigns SET status='draft' WHERE id=?").run(c.id);
  s.importContacts(
    c.id,
    Array.from({ length: 1001 }, (_, i) => ({
      email: `lead${i}@example.com`,
      fields: { name: "Lead" },
    })),
  );
  s.setCampaignStatus(c.id, "active");
  const other = s.saveMailbox({ ...mailbox, email: "other@example.com" });
  s.markMailbox(other.id, true);
  const next = s.saveCampaign({
    name: "Later",
    mailboxIds: [other.id],
    schedule: s.campaign(c.id).schedule,
    steps: [{ subject: "Hi", body: "Hello", delay: 0 }],
  });
  s.importContacts(next.id, [{ email: "last@example.com", fields: {} }]);
  s.setCampaignStatus(next.id, "active");
  assert.equal(
    s.reserve(new Date("2026-09-21T12:00:00Z").getTime(), new Set([other.id]))
      ?.campaign_id,
    next.id,
  );
  s.close();
});
