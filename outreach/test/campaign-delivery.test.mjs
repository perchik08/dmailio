import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import { MailGateway } from "../mail.mjs";
import { Worker } from "../worker.mjs";
import { simpleParser } from "mailparser";
function setup(
  t,
  { copyError = false, duplicate = false, searchError = false } = {},
) {
  const s = new Store(":memory:", "a".repeat(64));
  t.after(() => s.close());
  const box = s.saveMailbox({
    email: "sender@example.com",
    limit: 100,
    smtp: { host: "smtp.example.com", port: 465, password: "fixture" },
    imap: { host: "imap.example.com", port: 993, password: "fixture" },
  });
  s.markMailbox(box.id, true);
  const c = s.saveCampaign({
    name: "Receipt",
    mailboxIds: [box.id],
    steps: [
      {
        subject: "Hello",
        body: "**Saved message**",
        format: "markdown",
        delay: 0,
      },
    ],
  });
  s.importContacts(c.id, [{ email: "lead@example.com", fields: {} }]);
  const lead = s.campaign(c.id).leads[0];
  s.db.prepare("UPDATE leads SET status='sending' WHERE id=?").run(lead.id);
  const m = s.insertMessage(
    {
      mailbox_id: box.id,
      campaign_id: c.id,
      lead_id: lead.id,
      kind: "campaign",
      step: 0,
      recipient: lead.email,
      subject: "Hello",
      body: "**Saved message**",
      format: "markdown",
    },
    Date.now(),
  );
  const g = new MailGateway(s, "https://example.com");
  const calls = { smtp: 0, append: 0 };
  g.transport = () => ({
    close() {},
    async sendMail(value) {
      calls.smtp++;
      calls.raw = value.raw;
      return {
        accepted: [lead.email],
        rejected: [],
        response: "250 2.0.0 queued: fixture-queue",
        messageId: m.message_id,
      };
    },
  });
  g.imap = () => ({
    connect: async () => {},
    close() {},
    list: async () => [{ path: "Sent", specialUse: "\\Sent" }],
    getMailboxLock: async () => ({ release() {} }),
    search: async () => (searchError ? false : duplicate ? [7] : []),
    async *fetch() {
      if (duplicate) yield { uid: 7, envelope: { messageId: m.message_id } };
    },
    async append(folder, raw, flags, date) {
      calls.append++;
      calls.copy = raw;
      calls.date = date;
      assert.equal(folder, "Sent");
      if (copyError) throw Error("copy offline");
      return { uid: 8 };
    },
  });
  return { s, box, m, g, calls };
}
test("campaign saves SMTP proof and identical Sent MIME without sending twice", async (t) => {
  const { s, box, m, g, calls } = setup(t);
  await new Worker(s, g).deliver(m);
  assert.equal(s.message(m.id).status, "sent");
  const receipt = s.campaignDelivery.get(m.id);
  assert.equal(receipt.smtpResponse, "250 2.0.0 queued: fixture-queue");
  assert.deepEqual(receipt.accepted, ["lead@example.com"]);
  assert.equal(receipt.copyStatus, "copied");
  assert.deepEqual(calls.copy, calls.raw);
  assert.equal((await simpleParser(calls.copy)).messageId, m.message_id);
  await g.restoreCampaignCopy(s.mailbox(box.id, true), s.message(m.id));
  assert.equal(calls.smtp, 1);
  assert.equal(calls.append, 1);
  assert.equal(receipt.mime, undefined);
});
test("copy failure retains SMTP acceptance and does not become unknown", async (t) => {
  const { s, m, g } = setup(t, { copyError: true });
  await new Worker(s, g).deliver(m);
  assert.equal(s.message(m.id).status, "sent");
  assert.equal(s.campaignDelivery.get(m.id).copyStatus, "error");
  assert.match(s.campaignDelivery.get(m.id).copyError, /copy offline/);
});
test("legacy restore copies only, preserves historical date and never invents SMTP proof", async (t) => {
  const { s, box, m, g, calls } = setup(t);
  const sent = Date.now() - 86400000;
  s.finish(m.id, "sent", sent);
  await g.restoreCampaignCopy(s.mailbox(box.id, true), s.message(m.id));
  assert.equal(calls.smtp, 0);
  assert.equal(calls.append, 1);
  assert.equal(calls.date.getTime(), sent);
  const receipt = s.campaignDelivery.get(m.id);
  assert.equal(receipt.smtpResponse, "");
  assert.equal(receipt.acceptedAt, null);
  assert.equal(receipt.legacy, true);
});
test("provider copy is deduplicated by Message-ID", async (t) => {
  const { s, m, g, calls } = setup(t, { duplicate: true });
  await new Worker(s, g).deliver(m);
  assert.equal(calls.smtp, 1);
  assert.equal(calls.append, 0);
  assert.equal(s.campaignDelivery.get(m.id).copyStatus, "copied");
});
test("failed search never appends an unchecked duplicate or retries SMTP", async (t) => {
  const { s, m, g, calls } = setup(t, { searchError: true });
  await new Worker(s, g).deliver(m);
  assert.equal(calls.smtp, 1);
  assert.equal(calls.append, 0);
  assert.equal(s.message(m.id).status, "sent");
  assert.equal(s.campaignDelivery.get(m.id).copyStatus, "error");
});

test("durable SMTP proof recovers a crash before worker finalization without SMTP", (t) => {
  const { s, m, calls } = setup(t);
  s.campaignDelivery.prepare(
    m,
    Buffer.from("Message-ID: " + m.message_id + "\r\n\r\nSaved"),
  );
  s.campaignDelivery.accept(
    m.id,
    { accepted: [m.recipient], response: "250 queued" },
    Date.now(),
  );
  s.recover(Date.now());
  assert.equal(s.message(m.id).status, "sent");
  assert.equal(calls.smtp, 0);
  const event = s.analytics(m.campaign_id).events.find((e) => e.id === m.id);
  assert.equal(event.delivery.smtpResponse, "250 queued");
  assert.equal(event.delivery.mime, undefined);
  s.recover(Date.now());
  assert.equal(s.message(m.id).status, "sent");
});
test("definitive SMTP rejection is recorded and never copied", async (t) => {
  const { s, m, g, calls } = setup(t);
  g.transport = () => ({
    close() {},
    sendMail: async () => {
      throw Object.assign(Error("Rejected"), {
        responseCode: 550,
        response: "550 mailbox rejected",
      });
    },
  });
  await new Worker(s, g).deliver(m);
  assert.equal(s.message(m.id).status, "failed");
  assert.equal(
    s.campaignDelivery.get(m.id).smtpResponse,
    "550 mailbox rejected",
  );
  assert.equal(s.campaignDelivery.get(m.id).acceptedAt, null);
  assert.equal(calls.append, 0);
});
test("a copy metadata failure after acceptance never changes delivery to unknown", async (t) => {
  const { s, m, g } = setup(t);
  s.campaignDelivery.copied = () => {
    throw Error("metadata unavailable");
  };
  await new Worker(s, g).deliver(m);
  assert.equal(s.message(m.id).status, "sent");
  assert.equal(
    s.campaignDelivery.get(m.id).smtpResponse,
    "250 2.0.0 queued: fixture-queue",
  );
});
test("restore refuses an unsent campaign and cannot call SMTP", async (t) => {
  const { s, box, m, g, calls } = setup(t);
  await assert.rejects(
    () => g.restoreCampaignCopy(s.mailbox(box.id, true), m),
    /отправленному/,
  );
  assert.equal(calls.smtp, 0);
  assert.equal(calls.append, 0);
});

test("worker recovers an accepted send and retries its missing copy without SMTP", async (t) => {
  const { s, m, g, calls } = setup(t);
  s.campaignDelivery.prepare(
    m,
    Buffer.from("Message-ID: " + m.message_id + "\r\n\r\nSaved"),
  );
  s.campaignDelivery.accept(m.id, {
    accepted: [m.recipient],
    response: "250 queued",
  });
  g.sync = async () => ({ caughtUp: true });
  await new Worker(s, g).tick();
  assert.equal(s.message(m.id).status, "sent");
  assert.equal(s.campaignDelivery.get(m.id).copyStatus, "copied");
  assert.equal(calls.smtp, 0);
  assert.equal(calls.append, 1);
});

test("unhealthy mailbox copies do not starve a healthy retry", (t) => {
  const { s, box, m } = setup(t);
  const healthy = s.saveMailbox({
    email: "healthy@example.com",
    limit: 100,
    smtp: { host: "smtp.example.com", port: 465, password: "fixture" },
    imap: { host: "imap.example.com", port: 993, password: "fixture" },
  });
  let target;
  for (let i = 0; i < 12; i++) {
    const row = s.insertMessage(
      {
        mailbox_id: i === 11 ? healthy.id : box.id,
        kind: "campaign",
        campaign_id: m.campaign_id,
        recipient: "lead@example.com",
        subject: "Hi",
        body: "Saved",
      },
      Date.now() + i,
    );
    s.db.prepare("UPDATE messages SET status='sent' WHERE id=?").run(row.id);
    s.campaignDelivery.prepare(row, Buffer.from("Saved"));
    s.campaignDelivery.accept(row.id, {
      accepted: [row.recipient],
      response: "250 queued",
    });
    if (i === 11) target = row.id;
  }
  assert.deepEqual(
    s.campaignDelivery.pendingCopies(new Set([healthy.id])).map((r) => r.id),
    [target],
  );
  assert.deepEqual(s.campaignDelivery.pendingCopies(new Set()), []);
});
