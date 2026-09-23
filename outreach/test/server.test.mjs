import test from "node:test";
import assert from "node:assert/strict";
import * as module from "../server.mjs";
import { Store } from "../store.mjs";
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
