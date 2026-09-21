import test from "node:test";
import assert from "node:assert/strict";
import * as module from "../store.mjs";
import { defaultSchedule } from "../core.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("legacy database migration preserves messages and adds plain defaults idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "dmailio-migrate-"));
  let s;
  try {
    s = new module.Store(join(dir, "old.sqlite"), "a".repeat(64));
    const m = s.saveMailbox(mailbox);
    const msg = s.insertMessage(
      {
        mailbox_id: m.id,
        kind: "manual",
        recipient: "a@example.com",
        subject: "Old",
        body: "**literal**",
      },
      Date.now(),
    );
    for (const column of [
      "format",
      "signature",
      "signature_format",
      "signature_marker",
    ])
      s.db.exec(`ALTER TABLE messages DROP COLUMN ${column}`);
    s.close();
    s = new module.Store(join(dir, "old.sqlite"), "a".repeat(64));
    assert.equal(s.message(msg.id).body, "**literal**");
    assert.equal(s.message(msg.id).format, "plain");
    assert.equal(s.message(msg.id).signature, "");
    s.close();
    s = new module.Store(join(dir, "old.sqlite"), "a".repeat(64));
    assert.equal(s.message(msg.id).format, "plain");
  } finally {
    s?.close();
    rmSync(dir, { recursive: true });
  }
});
test("manual reply snapshots Markdown signature and supports disabling it", () => {
  const { s, m } = setup(),
    now = new Date("2026-09-21T12:00:00Z").getTime();
  const first = s.reserve(now, new Set([m.id]));
  s.finish(first.id, "sent", now);
  s.saveSignature(m.id, {
    body: "**Иван**",
    format: "markdown",
    enabled: true,
  });
  const reply = s.reserveReply(first.lead_id, "**Ответ**", now + 120000, {
    format: "markdown",
  });
  assert.equal(reply.format, "markdown");
  assert.equal(reply.signature, "**Иван**");
  assert.match(s.rendered(reply).html, /<strong>Ответ<\/strong>/);
  s.finish(reply.id, "failed", now + 120000);
  const noSignature = s.reserveReply(first.lead_id, "Hello", now + 240000, {
    format: "markdown",
    includeSignature: false,
  });
  assert.equal(noSignature.signature, "");
  s.close();
});
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
test("signature editing preserves verification and snapshots formatted signature for queued mail", () => {
  const { s, m, c } = setup();
  s.saveSignature(m.id, {
    body: "С уважением, **{{Имя Отправителя}}**",
    format: "markdown",
    enabled: true,
  });
  assert.equal(s.mailbox(m.id).verified, true);
  const msg = s.reserve(
    new Date("2026-09-21T12:00:00Z").getTime(),
    new Set([m.id]),
  );
  assert.equal(msg.signature, "С уважением, **Даниил**");
  assert.equal(msg.signature_format, "markdown");
  s.saveSignature(m.id, {
    body: "Новая подпись",
    format: "plain",
    enabled: true,
  });
  assert.equal(s.message(msg.id).signature, "С уважением, **Даниил**");
  s.close();
});
test("signature inside a nested CSV field is not appended twice", () => {
  const { s, m, c } = setup();
  s.saveSignature(m.id, { body: "Подпись", format: "markdown", enabled: true });
  const cfg = s.campaign(c.id);
  cfg.steps[0].body = "{{Письмо 1}}";
  const lead = {
    email: "lead@example.com",
    fields: { "Письмо 1": "Привет {{Подпись Отправителя}}" },
  };
  const p = s.compose(cfg, lead, s.mailbox(m.id), 0);
  assert.equal(p.text, "Привет Подпись");
  assert.equal(p.plainText, "Привет Подпись");
  assert.equal(p.html.match(/Подпись/g).length, 1);
  s.close();
});
test("connection settings cannot erase separately saved signature", () => {
  const { s, m } = setup();
  s.saveSignature(m.id, {
    body: "**Подпись**",
    format: "markdown",
    enabled: false,
  });
  s.saveMailbox({ ...mailbox, id: m.id });
  assert.equal(s.mailbox(m.id).signature, "**Подпись**");
  assert.equal(s.mailbox(m.id).signatureEnabled, false);
  s.close();
});
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
