import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import { createApp } from "../server.mjs";
function fixture(t) {
  const s = new Store(":memory:", "a".repeat(64));
  t.after(() => s.close());
  const box = s.saveMailbox({
    email: "sender@example.com",
    limit: 30,
    smtp: { host: "smtp.example.com", port: 465, password: "fixture-only" },
    imap: { host: "imap.example.com", port: 993, password: "fixture-only" },
  });
  const c = s.saveCampaign({
    name: "Counts",
    mailboxIds: [box.id],
    steps: [{ subject: "S", body: "B", delay: 0 }],
  });
  const empty = s.createCampaignDraft("Empty");
  s.importContacts(c.id, [
    { email: "a@example.com", fields: {} },
    { email: "b@example.com", fields: {} },
    { email: "c@example.com", fields: {} },
  ]);
  const leads = s.campaign(c.id).leads;
  let step = 0;
  const message = (
    lead,
    kind = "campaign",
    status = "sent",
    campaign = c.id,
    direction = "out",
  ) => {
    const m = s.insertMessage(
      {
        mailbox_id: box.id,
        campaign_id: campaign,
        lead_id: lead.id,
        recipient: lead.email,
        subject: "S",
        body: "B",
        kind,
        step: step++,
      },
      Date.now(),
    );
    if (["sent", "failed", "unknown"].includes(status)) s.finish(m.id, status);
    else
      s.db.prepare("UPDATE messages SET status=? WHERE id=?").run(status, m.id);
    if (direction !== "out")
      s.db
        .prepare("UPDATE messages SET direction=? WHERE id=?")
        .run(direction, m.id);
    return m;
  };
  return { s, c, empty, leads, message };
}
test("campaign send counts reflect successful outbound history, distinct contacts and zero defaults", (t) => {
  const { s, c, empty, leads, message } = fixture(t);
  message(leads[0]);
  message(leads[0]);
  message(leads[1]);
  message(leads[1], "manual");
  for (const status of ["failed", "unknown", "cancelled", "sending"])
    message(leads[2], "manual", status);
  for (const kind of ["warmup", "marketing", "marketing_test"])
    message(leads[2], kind);
  message(leads[2], "reply", "sent", c.id, "in");
  s.db.prepare("UPDATE leads SET status='replied' WHERE id=?").run(leads[0].id);
  s.db
    .prepare("UPDATE leads SET status='completed' WHERE id=?")
    .run(leads[1].id);
  const other = s.createCampaignDraft("Other");
  message(leads[2], "manual", "sent", other.id);
  const rows = s.campaigns(),
    result = rows.find((r) => r.id === c.id);
  assert.equal(result.sentMessages, 4);
  assert.equal(result.contactedContacts, 2);
  assert.equal(result.sentMessages, s.analytics(c.id).sent);
  assert.equal(rows.find((r) => r.id === empty.id).sentMessages, 0);
  assert.equal(rows.find((r) => r.id === empty.id).contactedContacts, 0);
  assert.equal(rows.find((r) => r.id === other.id).sentMessages, 1);
});
test("authenticated campaign state exposes numeric successful-send counters", async (t) => {
  const { s, c, leads, message } = fixture(t);
  message(leads[0]);
  message(leads[0], "manual");
  const app = createApp({
    store: s,
    gateway: {},
    worker: {},
    password: "fixture-password-only",
    publicURL: "http://localhost:9100",
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(base + "/api/state")).status, 401);
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Origin: "http://localhost:9100" },
    body: JSON.stringify({ password: "fixture-password-only" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const state = await (
    await fetch(base + "/api/state", { headers: { Cookie: cookie } })
  ).json();
  const row = state.campaigns.find((r) => r.id === c.id);
  assert.equal(row.sentMessages, 2);
  assert.equal(row.contactedContacts, 1);
});
