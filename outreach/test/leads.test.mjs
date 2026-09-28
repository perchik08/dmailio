import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import { renderContent } from "../content.mjs";
import { randomUUID } from "node:crypto";
import { createApp } from "../server.mjs";

function setup() {
  const s = new Store(":memory:", "a".repeat(64));
  s.db
    .prepare(
      "INSERT INTO mailboxes(id,email,config,secrets) VALUES('m','sender@example.com','{}','')",
    )
    .run();
  for (const id of ["c", "other"])
    s.db
      .prepare("INSERT INTO campaigns(id,name,config,created) VALUES(?,?,?,0)")
      .run(
        id,
        id,
        JSON.stringify({
          steps: [{}, {}],
          trackOpens: true,
          trackClicks: true,
        }),
      );
  const add = s.db.prepare(
    "INSERT INTO leads(id,campaign_id,email,fields) VALUES(?,'c',?,?)",
  );
  for (let i = 0; i < 255; i++)
    add.run(
      `l${i}`,
      `lead${i}@example.com`,
      JSON.stringify({
        name: i === 254 ? "Мария" : "Иван",
        company: i % 2 ? "Альфа" : "Бета",
        region: i % 2 ? "Москва" : "Казань",
        note: i % 3 ? "" : "Есть",
      }),
    );
  function message(
    lead,
    kind = "campaign",
    direction = "out",
    campaign = "c",
    step = 0,
    status = "sent",
  ) {
    const id = randomUUID();
    s.db
      .prepare(
        "INSERT INTO messages(id,message_id,mailbox_id,campaign_id,lead_id,step,kind,direction,status,recipient,subject,body,created,token) VALUES(?,?,'m',?,?,?,?,?,?,?,'Тема','Текст',1,?)",
      )
      .run(
        id,
        `<${id}@example.com>`,
        campaign,
        lead,
        step,
        kind,
        direction,
        status,
        "lead@example.com",
        id.replaceAll("-", "").padEnd(48, "a"),
      );
    return s.message(id);
  }
  return { s, message };
}
test("lead API requires login and same-origin requests; click route resolves only stored destinations", async () => {
  const { s, message } = setup();
  const app = createApp({
    store: s,
    password: "test-password-long",
    publicURL: "http://localhost:9100",
    gateway: {},
    worker: {},
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const request = {
      method: "POST",
      headers: {
        origin: "http://localhost:9100",
        "content-type": "application/json",
      },
      body: JSON.stringify({ search: "Мария" }),
    };
    assert.equal(
      (await fetch(base + "/api/campaigns/c/leads", request)).status,
      401,
    );
    const login = await fetch(base + "/api/login", {
      ...request,
      body: JSON.stringify({ password: "test-password-long" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await fetch(base + "/api/campaigns/c/leads", {
          ...request,
          headers: { cookie },
        })
      ).status,
      403,
    );
    const result = await fetch(base + "/api/campaigns/c/leads", {
      ...request,
      headers: { ...request.headers, cookie },
    });
    assert.equal((await result.json()).rows[0].id, "l254");
    const link = s.trackedLink(
      message("l0"),
      "https://example.com/document",
      base,
    );
    const redirect = await fetch(link + "?url=https://attacker.example", {
      redirect: "manual",
    });
    assert.equal(redirect.status, 302);
    assert.equal(
      redirect.headers.get("location"),
      "https://example.com/document",
    );
    assert.equal(
      (await fetch(base + "/click/" + "f".repeat(48), { redirect: "manual" }))
        .status,
      404,
    );
    assert.equal(s.leadPage("c").counts.clicked, 1);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    s.close();
  }
});
test("lead search, custom fields and paging cover the entire campaign", () => {
  const { s } = setup();
  try {
    assert.equal(s.leadPage("c").total, 255);
    assert.equal(s.leadPage("c", { page: 6 }).rows.length, 5);
    assert.equal(s.leadPage("c", { search: "МАРИЯ" }).rows[0].id, "l254");
    assert.equal(s.leadPage("c", { search: "альфа" }).total, 127);
    assert.equal(
      s.leadPage("c", {
        fields: [
          { key: "region", op: "eq", value: "Москва" },
          { key: "region", op: "eq", value: "Казань" },
        ],
      }).total,
      255,
    );
    const data = s.leadPage("c", {
      fields: [
        { key: "region", op: "eq", value: "Москва" },
        { key: "note", op: "not_empty" },
      ],
    });
    assert.equal(data.total, 42);
    assert.equal(data.counts.untouched, 42);
    assert.throws(() => s.leadPage("c", { actions: ["unknown_column"] }));
    assert.throws(() =>
      s.leadPage("c", { fields: [{ key: "email", op: "sql" }] }),
    );
  } finally {
    s.close();
  }
});
test("independent events, completed chain, negative filters and facets count unique leads", () => {
  const { s, message } = setup();
  try {
    const a = message("l0"),
      b = message("l0", "campaign", "out", "c", 1);
    message("l0", "reply", "in");
    message("l1");
    message("l1", "auto", "in");
    message("l2", "warmup");
    message("l3", "manual", "out", "other");
    for (const m of [a, b])
      s.db
        .prepare("INSERT INTO events VALUES(?,?,'open',1)")
        .run(randomUUID(), m.id);
    s.db.prepare("UPDATE leads SET status='replied' WHERE id='l0'").run();
    const data = s.leadPage("c", {
      actions: ["contacted"],
      excluded: ["replied"],
    });
    assert.deepEqual(
      data.rows.map((l) => l.id),
      ["l1"],
    );
    assert.equal(data.counts.contacted, 2);
    assert.equal(data.counts.opened, 1);
    assert.equal(data.counts.replied, 1);
    assert.equal(data.counts.auto, 1);
    const done = s.leadPage("c", { actions: ["completed"] }).rows[0];
    assert.equal(done.flags.completed, true);
    assert.equal(done.flags.replied, true);
    assert.equal(done.flags.opened, true);
    assert.equal(s.leadPage("c", { actions: ["replied", "auto"] }).total, 2);
  } finally {
    s.close();
  }
});
test("errors, unknown sends and tracking disabled remain distinct", () => {
  const { s, message } = setup();
  try {
    message("l0", "campaign", "out", "c", 0, "unknown");
    const m = message("l1", "campaign", "out", "c", 0, "failed");
    s.db
      .prepare("UPDATE messages SET error='421 service unavailable' WHERE id=?")
      .run(m.id);
    s.db
      .prepare(
        "UPDATE leads SET status='invalid',preparation_error='Не заполнено имя' WHERE id='l2'",
      )
      .run();
    assert.equal(s.leadPage("c", { actions: ["uncertain"] }).total, 1);
    assert.equal(s.leadPage("c", { actions: ["errors"] }).total, 2);
    assert.equal(s.leadPage("c", { actions: ["bounced"] }).total, 0);
    assert.match(s.leadPage("c", { search: "lead1@" }).rows[0].error, /421/);
    s.db
      .prepare("UPDATE campaigns SET config=? WHERE id='c'")
      .run(JSON.stringify({ steps: [{}, {}] }));
    assert.deepEqual(s.leadPage("c").tracking, { opens: false, clicks: false });
  } finally {
    s.close();
  }
});
test("tracked links are opaque, idempotent and preserve unsubscribe and both MIME versions", () => {
  const { s, message } = setup();
  try {
    const m = message("l0");
    const rewrite = (url) => s.trackedLink(m, url, "https://dmailio.example");
    const destination = "https://example.com/docs?q=1&x=2";
    const url = rewrite(destination);
    assert.equal(rewrite(destination), url);
    assert.match(url, /\/click\/[a-f0-9]{48}$/);
    assert.equal(s.followLink(url.split("/").pop()), destination);
    s.followLink(url.split("/").pop());
    assert.equal(s.leadPage("c").counts.clicked, 1);
    assert.equal(s.followLink("a".repeat(48)), null);
    assert.throws(() => rewrite("javascript:alert(1)"));
    assert.throws(() => rewrite("https://user:password@example.com"));
    const unsubscribe = "https://dmailio.example/unsubscribe/abc";
    assert.equal(rewrite(unsubscribe), unsubscribe);
    const formatted = renderContent(
      {
        body: `[Документ](${destination})\n[Отписка](${unsubscribe})`,
        format: "markdown",
      },
      () => null,
      true,
      rewrite,
    );
    assert.ok(formatted.html.includes(url));
    assert.ok(formatted.text.includes(url));
    assert.ok(formatted.html.includes(unsubscribe));
    const plain = renderContent(
      { body: destination, format: "plain" },
      () => null,
      true,
      rewrite,
    );
    assert.equal(plain.text, url);
    assert.ok(plain.html.includes(url));
  } finally {
    s.close();
  }
});
