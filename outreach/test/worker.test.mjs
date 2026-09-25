import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import * as module from "../worker.mjs";
const schedule = {
  days: [0, 1, 2, 3, 4, 5, 6],
  start: "00:00",
  end: "23:59",
  timezone: "UTC",
  interval: 1,
};
function setup() {
  const s = new Store(":memory:", "a".repeat(64));
  const m = s.saveMailbox({
    email: "sender@example.com",
    name: "Даниил",
    limit: 2,
    smtp: { host: "smtp.example.com", port: 465, password: "x" },
    imap: { host: "imap.example.com", port: 993, password: "x" },
  });
  s.markMailbox(m.id, true);
  const c = s.saveCampaign({
    name: "Test",
    mailboxIds: [m.id],
    schedule,
    steps: [{ subject: "Hi", body: "{{name}}", delay: 0 }],
  });
  s.importContacts(c.id, [
    { email: "lead@example.com", fields: { name: "Иван" } },
  ]);
  s.setCampaignStatus(c.id, "active");
  return { s, m, c };
}
test("worker sends persisted personalized message after successful sync", async () => {
  assert.equal(typeof module.Worker, "function");
  const { s, c } = setup();
  const delivered = [];
  const w = new module.Worker(s, {
    sync: async () => ({}),
    send: async (m, msg) => delivered.push(msg),
  });
  await w.tick(new Date("2026-09-21T12:00:00Z").getTime());
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].body, "Иван");
  assert.equal(s.campaign(c.id).status, "completed");
  s.close();
});
test("failed inbox sync prevents automated sends", async () => {
  assert.equal(typeof module.Worker, "function");
  const { s } = setup();
  let sent = 0;
  const w = new module.Worker(s, {
    sync: async () => {
      throw new Error("offline");
    },
    send: async () => sent++,
  });
  await w.tick(Date.now());
  assert.equal(sent, 0);
  s.close();
});
test("worker records transport failures as uncertain rather than retrying", async () => {
  assert.equal(typeof module.Worker, "function");
  const { s, c } = setup();
  const w = new module.Worker(s, {
    sync: async () => ({}),
    send: async () => {
      throw new Error("lost connection");
    },
  });
  await w.tick(new Date("2026-09-21T12:00:00Z").getTime());
  assert.equal(s.campaign(c.id).leads[0].status, "uncertain");
  s.close();
});
test("placement inspection failure does not block campaign delivery", async () => {
  const { s, m, c } = setup();
  const delivered = [];
  let inspected = 0;
  const now = new Date("2026-09-21T12:00:00Z").getTime();
  const warmup = s.insertMessage(
    {
      mailbox_id: m.id,
      kind: "warmup",
      recipient: m.email,
      subject: "Placement",
      body: "Placement",
    },
    now - 120000,
  );
  s.finish(warmup.id, "sent", now - 119999);
  const w = new module.Worker(s, {
    sync: async () => ({ validity: "1", uid: 0, caughtUp: true }),
    inspectWarmupPlacement: async () => {
      inspected++;
      throw new Error("unsupported folder");
    },
    send: async (m, msg) => delivered.push(msg),
  });
  await w.tick(now);
  assert.equal(inspected, 1);
  assert.equal(delivered.length, 1);
  assert.equal(s.campaign(c.id).status, "completed");
  s.close();
});
test("warmup requires opted-in peers and never appears in campaign analytics", () => {
  const { s, m } = setup();
  s.setCampaignStatus(s.campaigns()[0].id, "paused");
  s.warmup(m.id, {
    enabled: true,
    consent: true,
    start: 2,
    increase: 1,
    max: 10,
  });
  assert.equal(s.reserveWarmup(Date.now(), new Set([m.id])), null);
  assert.equal(s.analytics().sent, 0);
  s.close();
});
test("warmup recipient receives initial message and sends a single threaded reply", () => {
  const { s, m } = setup();
  s.setCampaignStatus(s.campaigns()[0].id, "paused");
  const peer = s.saveMailbox({
    email: "peer@other.example",
    name: "Peer",
    limit: 10,
    smtp: { host: "smtp.example.com", port: 465, password: "x" },
    imap: { host: "imap.example.com", port: 993, password: "x" },
  });
  s.markMailbox(peer.id, true);
  for (const id of [m.id, peer.id])
    s.warmup(id, {
      enabled: true,
      consent: true,
      start: 2,
      increase: 1,
      max: 10,
    });
  const now = Date.now();
  const healthy = new Set([m.id, peer.id]);
  const a = s.reserveWarmup(now, healthy);
  s.finish(a.id, "sent", now);
  const recipient = s.mailboxes().find((x) => x.email === a.recipient);
  const b = s.ingest(
    recipient.id,
    {
      remoteId: "w1",
      messageId: a.message_id,
      references: [],
      from: s.mailbox(a.mailbox_id).email,
      subject: a.subject,
      text: a.body,
      type: "reply",
    },
    now + 100,
  );
  assert.ok(b);
  const reply = s.reserveWarmup(now + 3600000, healthy);
  assert.equal(reply.parent, a.message_id);
  assert.equal(reply.mailbox_id, recipient.id);
  s.finish(reply.id, "sent", now + 3600000);
  assert.equal(s.analytics().sent, 0);
  s.close();
});
test("warmup follows a selected scenario through multiple threaded messages", () => {
  const { s, m } = setup();
  const peer = s.saveMailbox({
    email: "scenario-peer@other.example",
    name: "Peer",
    limit: 10,
    smtp: { host: "smtp.example.com", port: 465, password: "x" },
    imap: { host: "imap.example.com", port: 993, password: "x" },
  });
  for (const item of [m, peer]) {
    s.markMailbox(item.id, true);
    s.warmup(item.id, { enabled: true, consent: true }, 1000);
  }
  const healthy = new Set([m.id, peer.id]);
  let now = Date.now();
  let outgoing = s.reserveWarmup(now, healthy);
  assert.ok(outgoing.scenario_id);
  const scenarioId = outgoing.scenario_id;
  let steps = 0;
  while (outgoing && steps < 3) {
    s.finish(outgoing.id, "sent", now);
    const recipient = s
      .mailboxes()
      .find((item) => item.email === outgoing.recipient);
    const source = s.mailbox(outgoing.mailbox_id);
    const inbound = s.ingest(
      recipient.id,
      {
        remoteId: `scenario-${steps}`,
        messageId: outgoing.message_id,
        references: [],
        from: source.email,
        subject: outgoing.subject,
        text: outgoing.body,
        type: "reply",
      },
      now + 100,
    );
    assert.ok(inbound);
    now += 3600000;
    const next = s.reserveWarmup(now, healthy);
    if (!next) break;
    if (next.scenario_id !== scenarioId) break;
    assert.equal(next.scenario_id, scenarioId);
    assert.equal(
      Number(next.scenario_step),
      Number(outgoing.scenario_step) + 1,
    );
    outgoing = next;
    steps += 1;
  }
  assert.ok(steps >= 1);
  s.close();
});
