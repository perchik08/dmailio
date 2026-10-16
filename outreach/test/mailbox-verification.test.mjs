import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import { MailGateway } from "../mail.mjs";
import { createApp } from "../server.mjs";
const input = {
  email: "auto@example.com",
  limit: 30,
  smtp: { host: "smtp.example.com", port: 465, password: "fixture-only" },
  imap: { host: "imap.example.com", port: 993, password: "fixture-only" },
};
async function api(t, gateway) {
  const store = new Store(":memory:", "a".repeat(64));
  const app = createApp({
    store,
    gateway,
    worker: {},
    password: "fixture-password-only",
    publicURL: "http://localhost:9100",
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => app.close(r));
    store.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const r = await fetch(base + "/api/login", {
    method: "POST",
    headers: { origin: "http://localhost:9100" },
    body: JSON.stringify({ password: "fixture-password-only" }),
  });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return {
    store,
    post: (path, data) =>
      fetch(base + path, {
        method: "POST",
        headers: { cookie, origin: "http://localhost:9100" },
        body: JSON.stringify(data),
      }),
  };
}
test("saving with verification verifies credentials once, initializes cursor and keeps warmup off", async (t) => {
  let calls = 0;
  const { store, post } = await api(t, {
    verify: async () => {
      calls++;
      return { since: 123, folders: {} };
    },
  });
  const r = await post("/api/mailboxes", { ...input, verify: true });
  assert.equal(r.status, 201);
  const m = await r.json();
  assert.equal(m.verified, true);
  assert.equal(m.warmup.enabled, false);
  assert.equal(store.mailbox(m.id, true).cursor.since, 123);
  assert.equal(calls, 1);
});
test("failed automatic verification preserves editable connection and safe protocol-specific error; retry succeeds", async (t) => {
  let fail = true;
  const { store, post } = await api(t, {
    verify: async () => {
      if (fail)
        throw Object.assign(new Error("provider leaked fixture-only"), {
          protocol: "IMAP",
          authenticationFailed: true,
        });
      return { since: 123 };
    },
  });
  const r = await post("/api/mailboxes", { ...input, verify: true });
  assert.equal(r.status, 201);
  const m = await r.json();
  assert.equal(m.verified, false);
  assert.match(m.error, /IMAP/);
  assert.doesNotMatch(JSON.stringify(m), /leaked|fixture-only/);
  assert.equal(store.available(m.id), false);
  fail = false;
  const retried = await post(`/api/mailboxes/${m.id}/verify`, {});
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).verified, true);
});
test("SMTP and IMAP verification failures identify the failing stage and close clients", async () => {
  for (const protocol of ["SMTP", "IMAP"]) {
    let closed = 0;
    const gateway = new MailGateway({}, "https://example.com");
    gateway.transport = () => ({
      verify: async () => {
        if (protocol === "SMTP")
          throw Object.assign(new Error("secret"), { code: "EAUTH" });
      },
      close() {
        closed++;
      },
    });
    gateway.imap = () => ({
      connect: async () => {
        throw Object.assign(new Error("secret"), {
          authenticationFailed: true,
        });
      },
      close() {
        closed++;
      },
    });
    await assert.rejects(gateway.verify({}), (e) => e.protocol === protocol);
    assert.equal(closed, protocol === "SMTP" ? 1 : 2);
  }
});
