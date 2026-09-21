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

test("mailbox overview reports warmup status, totals and transparent technical health", () => {
  const s = new module.Store(":memory:", "a".repeat(64));
  const now = new Date("2026-09-21T12:00:00Z").getTime();
  const first = s.saveMailbox(mailbox);
  const second = s.saveMailbox({
    ...mailbox,
    email: "second@example.com",
    smtp: { ...mailbox.smtp, user: "second@example.com" },
    imap: { ...mailbox.imap, user: "second@example.com" },
  });
  for (const m of [first, second]) {
    s.markMailbox(m.id, true);
    s.synced(m.id, { validity: 1 }, now - 60_000);
    s.warmup(
      m.id,
      { enabled: true, consent: true, start: 2, increase: 1, max: 10 },
      now,
    );
  }
  const fresh = s.mailboxOverview(now).find((m) => m.id === first.id);
  assert.equal(fresh.health.score, 65);
  assert.equal(fresh.health.parts.sending, 0);
  assert.equal(fresh.health.parts.receiving, 0);
  assert.equal(fresh.warmupProgress.score, 0);
  assert.equal(fresh.warmupProgress.label, "Старт");
  assert.equal(fresh.warmupProgress.day, 1);
  assert.equal(fresh.currentWarmupLimit, 2);
  const outgoing = s.insertMessage(
    {
      mailbox_id: first.id,
      kind: "warmup",
      recipient: second.email,
      subject: "Проверка",
      body: "Тест",
    },
    now - 30_000,
  );
  s.finish(outgoing.id, "sent", now - 20_000);
  s.ingest(
    second.id,
    {
      remoteId: "warmup-delivery-1",
      messageId: outgoing.message_id,
      references: [],
      from: first.email,
      subject: "Проверка",
      text: "Тест",
      type: "reply",
    },
    now - 15_000,
  );
  s.ingest(
    first.id,
    {
      remoteId: "warmup-reply-1",
      messageId: "<reply@example.com>",
      references: [outgoing.message_id],
      from: second.email,
      subject: "Re: Проверка",
      text: "Получено",
      type: "reply",
    },
    now - 10_000,
  );

  const row = s.mailboxOverview(now).find((m) => m.id === first.id);
  assert.equal(row.warmupStatus, "warming");
  assert.equal(row.warmupStats.sent, 1);
  assert.equal(row.warmupStats.replies, 1);
  assert.equal(row.warmupStats.sent24h, 1);
  assert.equal(row.health.score, 100);
  assert.deepEqual(row.health.parts, {
    connection: 40,
    sync: 25,
    sending: 20,
    receiving: 15,
  });
  assert.equal(
    s.mailboxOverview(now).find((m) => m.id === second.id).warmupStats.replies,
    0,
  );
  s.close();
});

test("automatic warmup follows a fixed fourteen-day progression", () => {
  const s = new module.Store(":memory:", "a".repeat(64));
  const started = new Date("2026-09-01T00:00:00Z").getTime();
  const first = s.saveMailbox(mailbox);
  const second = s.saveMailbox({
    ...mailbox,
    email: "second@example.com",
    smtp: { ...mailbox.smtp, user: "second@example.com" },
    imap: { ...mailbox.imap, user: "second@example.com" },
  });
  for (const m of [first, second]) {
    s.markMailbox(m.id, true);
    s.warmup(m.id, { enabled: true, consent: true }, started);
  }

  const plan = [2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 10];
  for (let day = 0; day < plan.length; day++) {
    const row = s
      .mailboxOverview(started + day * 86400000)
      .find((m) => m.id === first.id);
    assert.equal(row.warmupProgress.day, day + 1);
    assert.equal(row.currentWarmupLimit, plan[day]);
    const message = s.insertMessage(
      {
        mailbox_id: first.id,
        kind: "warmup",
        recipient: second.email,
        subject: `Активный день ${day + 1}`,
        body: "Тест",
      },
      started + day * 86400000,
    );
    s.finish(message.id, "sent", started + day * 86400000 + 1);
  }
  assert.equal(
    s.mailboxOverview(started + 30 * 86400000).find((m) => m.id === first.id)
      .warmupProgress.day,
    14,
  );
  s.close();
});

test("waiting for a healthy peer does not advance the automatic plan", () => {
  const s = new module.Store(":memory:", "a".repeat(64));
  const started = new Date("2026-09-01T00:00:00Z").getTime();
  const m = s.saveMailbox(mailbox);
  s.markMailbox(m.id, true);
  s.warmup(m.id, { enabled: true, consent: true }, started);

  const row = s.mailboxOverview(started + 30 * 86400000)[0];
  assert.equal(row.warmupStatus, "waiting");
  assert.equal(row.warmupProgress.day, 1);
  assert.equal(row.currentWarmupLimit, 2);
  assert.equal(row.warmupProgress.score, 0);
  s.close();
});

test("a connection error does not erase earned warmup progress", () => {
  const s = new module.Store(":memory:", "a".repeat(64));
  const started = new Date("2026-09-01T00:00:00Z").getTime();
  const m = s.saveMailbox(mailbox);
  s.markMailbox(m.id, true);
  s.warmup(m.id, { enabled: true, consent: true }, started);
  const message = s.insertMessage(
    {
      mailbox_id: m.id,
      kind: "warmup",
      recipient: "peer@example.com",
      subject: "Активный день",
      body: "Тест",
    },
    started,
  );
  s.finish(message.id, "sent", started + 1);
  const earned = s.mailboxOverview(started + 3600000)[0].warmupProgress.score;
  assert.ok(earned > 0);

  s.markMailbox(m.id, false, "Нет подключения");
  const disconnected = s.mailboxOverview(started + 7200000)[0];
  assert.equal(disconnected.warmupStatus, "unverified");
  assert.equal(disconnected.warmupProgress.score, earned);
  assert.equal(disconnected.health.score, 0);
  s.close();
});

test("warmup percentage reaches 100 only after fourteen active planned days", () => {
  const s = new module.Store(":memory:", "a".repeat(64));
  const started = new Date("2026-09-01T00:00:00Z").getTime();
  const first = s.saveMailbox(mailbox);
  const second = s.saveMailbox({
    ...mailbox,
    email: "second@example.com",
    smtp: { ...mailbox.smtp, user: "second@example.com" },
    imap: { ...mailbox.imap, user: "second@example.com" },
  });
  for (const m of [first, second]) {
    s.markMailbox(m.id, true);
    s.synced(m.id, { validity: 1 }, started + 14 * 86400000);
    s.warmup(m.id, { enabled: true, consent: true }, started);
  }
  const plan = [2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 10];
  for (let day = 0; day < plan.length; day++) {
    let firstMessage;
    for (let n = 0; n < plan[day]; n++) {
      const message = s.insertMessage(
        {
          mailbox_id: first.id,
          kind: "warmup",
          recipient: second.email,
          subject: `День ${day + 1}`,
          body: "Тест",
        },
        started + day * 86400000 + n * 60000,
      );
      s.finish(message.id, "sent", started + day * 86400000 + n * 60000 + 1);
      firstMessage ||= message;
    }
    s.ingest(
      first.id,
      {
        remoteId: `reply-${day}`,
        messageId: `<reply-${day}@example.com>`,
        references: [firstMessage.message_id],
        from: second.email,
        subject: `Re: День ${day + 1}`,
        text: "Получено",
        type: "reply",
      },
      started + day * 86400000 + 3600000,
    );
  }

  const progress = s
    .mailboxOverview(started + 14 * 86400000)
    .find((m) => m.id === first.id).warmupProgress;
  assert.equal(progress.score, 100);
  assert.equal(progress.label, "Высокий прогрев");
  assert.deepEqual(progress.parts, {
    duration: 40,
    plan: 25,
    sending: 20,
    receiving: 15,
  });
  s.close();
});

test("pausing automatic warmup freezes its program day", () => {
  const s = new module.Store(":memory:", "a".repeat(64));
  const started = new Date("2026-09-01T00:00:00Z").getTime();
  const m = s.saveMailbox(mailbox);
  s.markMailbox(m.id, true);
  s.warmup(m.id, { enabled: true, consent: true }, started);
  for (let day = 0; day < 3; day++) {
    const message = s.insertMessage(
      {
        mailbox_id: m.id,
        kind: "warmup",
        recipient: "peer@example.com",
        subject: `День ${day + 1}`,
        body: "Тест",
      },
      started + day * 86400000,
    );
    s.finish(message.id, "sent", started + day * 86400000 + 1);
  }
  const beforePause = s.mailboxOverview(started + 3 * 86400000)[0];
  s.warmup(m.id, { enabled: false, consent: true }, started + 3 * 86400000);
  const paused = s.mailboxOverview(started + 10 * 86400000)[0];
  assert.equal(paused.warmupProgress.day, 4);
  assert.equal(paused.warmupProgress.score, beforePause.warmupProgress.score);
  s.warmup(m.id, { enabled: true, consent: true }, started + 10 * 86400000);
  assert.equal(
    s.mailboxOverview(started + 11 * 86400000)[0].warmupProgress.day,
    4,
  );
  assert.equal(
    s.mailboxOverview(started + 11 * 86400000)[0].warmup.since,
    started,
  );
  s.close();
});

test("legacy paused warmup keeps its history boundary and resumes at the real active day", () => {
  const s = new module.Store(":memory:", "a".repeat(64));
  const started = new Date("2026-08-01T00:00:00Z").getTime();
  const resumed = new Date("2026-09-01T00:00:00Z").getTime();
  const m = s.saveMailbox(mailbox);
  s.markMailbox(m.id, true);
  const row = s.db.prepare("SELECT config FROM mailboxes WHERE id=?").get(m.id);
  const config = JSON.parse(row.config);
  config.warmup = {
    enabled: false,
    consent: true,
    start: 2,
    increase: 1,
    max: 10,
    since: started,
  };
  s.db
    .prepare("UPDATE mailboxes SET config=? WHERE id=?")
    .run(JSON.stringify(config), m.id);

  assert.equal(s.mailboxOverview(resumed)[0].warmupProgress.day, 1);
  s.warmup(m.id, { enabled: true, consent: true }, resumed);
  const after = s.mailboxOverview(resumed + 86400000)[0];
  assert.equal(after.warmup.since, started);
  assert.equal(after.warmupProgress.day, 1);
  s.close();
});

test("mailbox overview upgrades legacy configs without warmup settings", () => {
  const s = new module.Store(":memory:", "a".repeat(64));
  const m = s.saveMailbox(mailbox);
  const row = s.db.prepare("SELECT config FROM mailboxes WHERE id=?").get(m.id);
  const config = JSON.parse(row.config);
  delete config.warmup;
  s.db
    .prepare("UPDATE mailboxes SET config=? WHERE id=?")
    .run(JSON.stringify(config), m.id);

  const overview = s.mailboxOverview(1000);
  assert.equal(overview[0].warmupStatus, "unverified");
  assert.deepEqual(overview[0].warmup, {
    enabled: false,
    consent: false,
    start: 2,
    increase: 1,
    max: 10,
    since: 0,
    pausedAt: 0,
    mode: "automatic-v1",
  });
  s.close();
});

test("bulk warmup starts verified mailboxes together and pauses selected rows", () => {
  const s = new module.Store(":memory:", "a".repeat(64));
  const first = s.saveMailbox(mailbox);
  const second = s.saveMailbox({
    ...mailbox,
    email: "second@example.com",
    smtp: { ...mailbox.smtp, user: "second@example.com" },
    imap: { ...mailbox.imap, user: "second@example.com" },
  });
  s.markMailbox(first.id, true);
  s.markMailbox(second.id, true);

  s.bulkWarmup([first.id, second.id], true, 1000);
  assert.equal(s.mailbox(first.id).warmup.enabled, true);
  assert.equal(s.mailbox(second.id).warmup.consent, true);
  assert.equal(
    s.mailboxOverview(1000).filter((m) => m.warmupStatus === "warming").length,
    2,
  );

  s.bulkWarmup([first.id], false, 2000);
  assert.equal(s.mailbox(first.id).warmup.enabled, false);
  assert.equal(s.mailbox(first.id).warmup.consent, true);
  assert.equal(
    s.mailboxOverview(2000).find((m) => m.id === first.id).warmupStatus,
    "paused",
  );
  s.close();
});

test("bulk warmup refuses a pool with fewer than two verified mailboxes", () => {
  const s = new module.Store(":memory:", "a".repeat(64));
  const first = s.saveMailbox(mailbox);
  s.markMailbox(first.id, true);
  assert.throws(
    () => s.bulkWarmup([first.id], true, 1000),
    /минимум два проверенных ящика/,
  );
  assert.equal(s.mailbox(first.id).warmup.enabled, false);
  s.close();
});
