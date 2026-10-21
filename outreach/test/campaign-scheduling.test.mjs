import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import { defaultSchedule } from "../core.mjs";
import { Worker } from "../worker.mjs";

function setup() {
  const store = new Store(":memory:", "a".repeat(64));
  const mailbox = store.saveMailbox({
    email: "sender@example.com",
    limit: 100,
    smtp: {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "sender",
      password: "secret",
    },
    imap: {
      host: "imap.example.com",
      port: 993,
      secure: true,
      user: "sender",
      password: "secret",
    },
  });
  store.markMailbox(mailbox.id, true);
  const healthy = new Set([mailbox.id]);
  function campaign(name, interval, count = 10) {
    const c = store.saveCampaign({
      name,
      mailboxIds: [mailbox.id],
      schedule: {
        ...defaultSchedule,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: "00:00",
        end: "23:59",
        timezone: "UTC",
        interval,
      },
      steps: [{ subject: "Hello", body: "Hello", delay: 0 }],
    });
    store.importContacts(
      c.id,
      Array.from({ length: count }, (_, i) => ({
        email: `${name}${i}@example.com`,
        fields: {},
      })),
    );
    store.setCampaignStatus(c.id, "active");
    return c;
  }
  return { store, mailbox, healthy, campaign };
}
const start = Date.parse("2026-10-21T09:00:00Z");

test("campaigns sharing a sender keep independent 7 and 12 minute intervals", () => {
  const { store, healthy, campaign } = setup();
  try {
    const a = campaign("older", 7);
    const b = campaign("newer", 12, 2);
    for (const [minute, expected] of [
      [0, a.id],
      [1, b.id],
      [7, a.id],
      [13, b.id],
      [14, a.id],
    ]) {
      const now = start + minute * 60000;
      const message = store.reserve(now, healthy);
      assert.equal(message?.campaign_id, expected, `minute ${minute}`);
      store.finish(message.id, "sent", now);
      assert.equal(
        store.reserve(now, healthy),
        null,
        "shared mailbox spacing remains enforced",
      );
    }
  } finally {
    store.close();
  }
});

test("simultaneously eligible campaigns take turns even with older due contacts", () => {
  const { store, healthy, campaign } = setup();
  try {
    const campaigns = [
      campaign("first", 1),
      campaign("second", 1),
      campaign("third", 1),
    ];
    for (let minute = 0; minute < 9; minute++) {
      const now = start + minute * 60000;
      const message = store.reserve(now, healthy);
      assert.equal(message?.campaign_id, campaigns[minute % 3].id);
      store.finish(message.id, "sent", now);
    }
  } finally {
    store.close();
  }
});

test("manual and warmup sends enforce mailbox spacing without resetting a campaign timer", () => {
  const { store, mailbox, healthy, campaign } = setup();
  try {
    const a = campaign("campaign", 7);
    const first = store.reserve(start, healthy);
    store.finish(first.id, "sent", start);
    for (const [minute, kind] of [
      [5, "manual"],
      [6, "warmup"],
    ]) {
      const message = store.insertMessage(
        {
          mailbox_id: mailbox.id,
          kind,
          recipient: "test@example.com",
          subject: "Test",
          body: "Test",
        },
        start + minute * 60000,
      );
      store.finish(message.id, "sent", start + minute * 60000);
    }
    assert.equal(store.reserve(start + 6.5 * 60000, healthy), null);
    assert.equal(store.reserve(start + 7 * 60000, healthy)?.campaign_id, a.id);
  } finally {
    store.close();
  }
});

test("shared quota and campaign pause still prevent reservations", () => {
  const { store, mailbox, healthy, campaign } = setup();
  try {
    const a = campaign("active", 7);
    const b = campaign("paused", 12);
    store.setCampaignStatus(b.id, "paused");
    store.dispatch.save(mailbox.id, { providerDailyLimit: 1 });
    const first = store.reserve(start, healthy);
    assert.equal(first.campaign_id, a.id);
    store.finish(first.id, "sent", start);
    assert.equal(store.reserve(start + 20 * 60000, healthy), null);
    store.dispatch.save(mailbox.id, { providerDailyLimit: 100 });
    assert.equal(store.reserve(start + 20 * 60000, healthy)?.campaign_id, a.id);
  } finally {
    store.close();
  }
});

test("an ineligible campaign does not hold up another ready campaign", () => {
  const { store, healthy, campaign } = setup();
  try {
    const closed = campaign("closed", 1);
    const ready = campaign("ready", 7);
    const cfg = store.campaign(closed.id);
    store.saveCampaign({
      ...cfg,
      schedule: { ...cfg.schedule, start: "18:00", end: "19:00" },
    });
    assert.equal(store.reserve(start, healthy)?.campaign_id, ready.id);
    assert.equal(store.reserve(start + 60000, healthy), null);
  } finally {
    store.close();
  }
});

test("a campaign can use another eligible sender while its first sender cools down", () => {
  const { store, mailbox, healthy, campaign } = setup();
  try {
    const c = campaign("parallel", 7);
    const other = store.saveMailbox({
      ...store.mailbox(mailbox.id, true),
      id: undefined,
      email: "other@example.com",
    });
    store.markMailbox(other.id, true);
    healthy.add(other.id);
    store.saveCampaign({
      ...store.campaign(c.id),
      mailboxIds: [mailbox.id, other.id],
    });
    const first = store.reserve(start, healthy);
    const second = store.reserve(start, healthy);
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.mailbox_id, second.mailbox_id);
    assert.equal(store.reserve(start + 60000, healthy), null);
  } finally {
    store.close();
  }
});

test("worker delivers both campaigns through consecutive ticks without resending contacts", async () => {
  const { store, campaign } = setup();
  try {
    const a = campaign("first", 7);
    const b = campaign("second", 12, 2);
    const delivered = [];
    const worker = new Worker(store, {
      sync: async () => ({ caughtUp: true }),
      send: async (_mailbox, message) => delivered.push(message),
    });
    for (const minute of [0, 1, 7, 13, 14])
      await worker.tick(start + minute * 60000);
    assert.equal(worker.lastError, "");
    assert.deepEqual(
      delivered.map((message) => message.campaign_id),
      [a.id, b.id, a.id, b.id, a.id],
    );
    assert.equal(new Set(delivered.map((message) => message.lead_id)).size, 5);
    assert.ok(
      delivered.every((message) => store.message(message.id).status === "sent"),
    );
    assert.equal(store.campaign(b.id).status, "completed");
  } finally {
    store.close();
  }
});
