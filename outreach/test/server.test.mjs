import test from "node:test";
import assert from "node:assert/strict";
import * as module from "../server.mjs";
import { Store } from "../store.mjs";
test("draft creation and rename APIs persist titles visible in campaign state", async () => {
  const store = new Store(":memory:", "a".repeat(64));
  const app = module.createApp({
    store,
    password: "test-password-long",
    publicURL: "http://localhost:9100",
    gateway: {},
    worker: {},
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const origin = "http://localhost:9100";
  try {
    assert.equal(
      (
        await fetch(base + "/api/campaigns/draft", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ name: "Новая кампания" }),
        })
      ).status,
      401,
    );
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { origin },
      body: JSON.stringify({ password: "test-password-long" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const post = (path, body) =>
      fetch(base + path, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const created = await post("/api/campaigns/draft", {
      name: "Новая кампания",
    });
    assert.equal(created.status, 201);
    const draft = await created.json();
    const state = await (
      await fetch(base + "/api/state", { headers: { cookie } })
    ).json();
    assert.ok(
      state.campaigns.some(
        ({ id, name, status }) =>
          id === draft.id && name === "Новая кампания" && status === "draft",
      ),
    );

    const renamed = await post(`/api/campaigns/${draft.id}/name`, {
      name: "Партнёры — осень",
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).name, "Партнёры — осень");
  } finally {
    await new Promise((resolve) => app.close(resolve));
    store.close();
  }
});
test("API requires login, same-origin writes and excludes credentials", async () => {
  assert.equal(typeof module.createApp, "function");
  const store = new Store(":memory:", "a".repeat(64));
  const app = module.createApp({
    store,
    password: "test-password-long",
    publicURL: "http://localhost:9100",
    gateway: {},
    worker: {},
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const script = await fetch(base + "/quill.js");
    const stylesheet = await fetch(base + "/quill.snow.css");
    assert.equal(script.status, 200);
    assert.equal(stylesheet.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(base + "/importer.js")).status, 200);
    assert.match(stylesheet.headers.get("content-type"), /css/);
    for (const family of ["onest", "inter"]) {
      for (const subset of ["latin", "cyrillic"]) {
        const font = await fetch(base + `/fonts/${family}-${subset}.woff2`);
        assert.equal(font.status, 200);
        assert.match(font.headers.get("content-type"), /font\/woff2/);
        assert.ok((await font.arrayBuffer()).byteLength > 1000);
      }
    }
    assert.equal((await fetch(base + "/api/mailboxes")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/login", {
          method: "POST",
          body: JSON.stringify({ password: "test-password-long" }),
        })
      ).status,
      403,
    );
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { origin: "http://localhost:9100" },
      body: JSON.stringify({ password: "test-password-long" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    const upload = await fetch(base + "/api/images", {
      method: "POST",
      headers: { cookie, origin: "http://localhost:9100" },
      body: JSON.stringify({ base64: png, mime: "image/png" }),
    });
    assert.equal(upload.status, 201);
    const asset = await upload.json();
    assert.equal((await fetch(base + asset.url)).status, 401);
    const image = await fetch(base + asset.url, { headers: { cookie } });
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(
      Buffer.from(await image.arrayBuffer()),
      Buffer.from(png, "base64"),
    );
    const preview = await fetch(base + "/api/content/preview", {
      method: "POST",
      headers: { cookie, origin: "http://localhost:9100" },
      body: JSON.stringify({
        body: `**Hello**\n![Logo](${asset.url})<script>evil()</script>`,
        format: "markdown",
      }),
    });
    assert.equal(preview.status, 200);
    const formatted = await preview.json();
    assert.match(formatted.html, /<strong>Hello<\/strong>/);
    assert.doesNotMatch(formatted.html, /script|evil/);
    const response = await fetch(base + "/api/mailboxes", {
      headers: { cookie },
    });
    assert.deepEqual(await response.json(), []);
    const mailbox = (address) => ({
      email: address,
      name: "Тест",
      limit: 10,
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        user: address,
        password: "secret",
      },
      imap: {
        host: "imap.example.com",
        port: 993,
        secure: true,
        user: address,
        password: "secret",
      },
    });
    const first = store.saveMailbox(mailbox("one@example.com"));
    const second = store.saveMailbox(mailbox("two@example.com"));
    store.markMailbox(first.id, true);
    store.markMailbox(second.id, true);
    const bulk = await fetch(base + "/api/mailboxes/warmup/bulk", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost:9100",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ids: [first.id, second.id], enabled: true }),
    });
    assert.equal(bulk.status, 200);
    const overview = await bulk.json();
    assert.equal(overview.length, 2);
    assert.equal(overview[0].warmupStatus, "warming");
    assert.equal(typeof overview[0].health.score, "number");
    const csv = await fetch(base + "/api/import/preview", {
      method: "POST",
      headers: { cookie, origin: "http://localhost:9100" },
      body: JSON.stringify({ csv: "email,Письмо 1\na@example.com,Привет" }),
    });
    assert.equal(csv.status, 200);
    assert.equal((await csv.json()).contacts.length, 1);
    assert.equal(
      (
        await fetch(base + "/api/campaigns", {
          method: "POST",
          headers: { cookie, origin: "https://evil.test" },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await new Promise((resolve) => app.close(resolve));
    store.close();
  }
});

test("mapped import preview is read-only, reports campaign-wide duplicates and rechecks on confirmation", async () => {
  const store = new Store(":memory:", "a".repeat(64));
  const mailbox = store.saveMailbox({
    email: "sender@example.com",
    limit: 10,
    smtp: { host: "smtp.example.com", port: 465, password: "secret" },
    imap: { host: "imap.example.com", port: 993, password: "secret" },
  });
  const campaign = store.saveCampaign({
    name: "Import test",
    mailboxIds: [mailbox.id],
    schedule: {
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "18:00",
      timezone: "Europe/Moscow",
      interval: 12,
    },
    steps: [{ subject: "Hello", body: "Hello", delay: 0 }],
  });
  store.importContacts(campaign.id, [
    { email: "used@example.com", fields: {} },
  ]);
  const app = module.createApp({
    store,
    password: "test-password-long",
    publicURL: "http://localhost:9100",
    gateway: {},
    worker: {},
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const origin = "http://localhost:9100";
  try {
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { origin },
      body: JSON.stringify({ password: "test-password-long" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const post = (path, body) =>
      fetch(base + path, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const source = {
      format: "csv",
      content:
        "Email,Компания,Письмо 1\nused@example.com,Acme,Hello\nfresh@example.com,NewCo,Hi\nnot-an-email,Other,Skip",
    };
    const columnResponse = await post("/api/import/preview", source);
    assert.equal(columnResponse.status, 200);
    const columns = await columnResponse.json();
    assert.equal(columns.total, 3);
    assert.equal(columns.columns[1].header, "Компания");
    assert.equal(columns.suggestedMappings[1].target, "company");
    assert.equal(store.campaign(campaign.id).leads.length, 1);
    const mappings = [
      { columnId: "column-0", target: "email" },
      { columnId: "column-1", target: "company" },
      { columnId: "column-2", target: { kind: "sequence_step", step: 1 } },
    ];
    const previewResponse = await post("/api/import/preview", {
      ...source,
      mappings,
      campaignId: campaign.id,
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).preview;
    assert.equal(preview.importable, 1);
    assert.equal(preview.errorCount, 1);
    assert.match(preview.skipped[0].reason, /уже есть/);
    assert.equal(store.campaign(campaign.id).leads.length, 1);
    const imported = await post(`/api/campaigns/${campaign.id}/import`, {
      ...source,
      mappings,
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).added, 1);
    assert.equal(store.campaign(campaign.id).leads.length, 2);
    const secondImport = await post(`/api/campaigns/${campaign.id}/import`, {
      ...source,
      mappings,
    });
    assert.equal(secondImport.status, 400);
    assert.equal(store.campaign(campaign.id).leads.length, 2);
    const xls = await post("/api/import/preview", {
      format: "xls",
      content: "",
    });
    assert.equal(xls.status, 400);
    assert.match((await xls.json()).error, /Сохраните книгу как \.xlsx/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    store.close();
  }
});

test("mailbox detail, DNS and settings endpoints use the stored mailbox", async () => {
  const store = new Store(":memory:", "a".repeat(64));
  const mailbox = store.saveMailbox({
    email: "owner@example.com",
    name: "Старое",
    limit: 10,
    smtp: { host: "smtp.example.com", port: 465, password: "secret" },
    imap: { host: "imap.example.com", port: 993, password: "secret" },
  });
  store.markMailbox(mailbox.id, true);
  const dnsCalls = [];
  const app = module.createApp({
    store,
    password: "test-password-long",
    publicURL: "http://localhost:9100",
    gateway: {},
    worker: {},
    dnsChecker: async (email, options) => {
      dnsCalls.push({ email, options });
      return { domain: "example.com", checkedAt: 123, records: [] };
    },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const origin = "http://localhost:9100";
  try {
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { origin },
      body: JSON.stringify({ password: "test-password-long" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const get = (path) => fetch(base + path, { headers: { cookie } });
    const post = (path, body) =>
      fetch(base + path, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const detailResponse = await get(`/api/mailboxes/${mailbox.id}/detail`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.mailbox.email, "owner@example.com");
    assert.equal(detail.activity.length, 30);

    const settingsResponse = await post(
      `/api/mailboxes/${mailbox.id}/settings`,
      { name: "Даниил", surname: "Демидов", limit: 30, dkimSelector: "mail" },
    );
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.equal(settings.name, "Даниил");
    assert.equal(settings.limit, 30);
    assert.equal(settings.verified, true);
    assert.equal(settings.smtp.password, undefined);

    const dnsResponse = await get(`/api/mailboxes/${mailbox.id}/dns`);
    assert.equal(dnsResponse.status, 200);
    assert.deepEqual(await dnsResponse.json(), {
      domain: "example.com",
      checkedAt: 123,
      records: [],
    });
    assert.deepEqual(dnsCalls, [
      {
        email: "owner@example.com",
        options: { selectors: ["mail"] },
      },
    ]);

    const customResponse = await post(`/api/mailboxes/${mailbox.id}/warmup`, {
      enabled: true,
      consent: true,
      mode: "custom",
      start: 3,
      increase: 2,
      max: 15,
      providers: ["google", "yandex"],
    });
    assert.equal(customResponse.status, 200);
    assert.equal((await customResponse.json()).warmup.mode, "custom");
    const resetResponse = await post(`/api/mailboxes/${mailbox.id}/warmup`, {
      enabled: true,
      consent: true,
      reset: true,
    });
    const reset = await resetResponse.json();
    assert.equal(reset.warmup.mode, "automatic-v1");
    assert.deepEqual(
      [reset.warmup.start, reset.warmup.increase, reset.warmup.max],
      [2, 1, 10],
    );
  } finally {
    await new Promise((resolve) => app.close(resolve));
    store.close();
  }
});
