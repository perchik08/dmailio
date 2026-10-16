import { test, expect } from "@playwright/test";

test("live counts update in place, pause off-page and preserve draft inputs", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const result = await page.request.post("/api/campaigns/draft", {
    headers: { Origin: "http://127.0.0.1:19100" },
    data: { name: "Live stats" },
  });
  const c = await result.json();
  let requests = 0,
    sent = 1;
  await page.route("**/api/campaigns/progress", (route) => {
    requests++;
    return route.fulfill({
      json: {
        campaigns: [
          {
            id: c.id,
            status: "draft",
            totalContacts: 5,
            sentMessages: sent,
            contactedContacts: 1,
            repliedContacts: 0,
            attentionContacts: 0,
          },
        ],
      },
    });
  });
  await page.clock.install();
  await page.reload();
  const row = page
    .locator("tr")
    .filter({ has: page.locator(`[data-campaign="${c.id}"]`) });
  await row.locator("button").evaluate((el) => (el.dataset.preserved = "yes"));
  await page.clock.runFor(30000);
  await expect(row.getByRole("cell").nth(3)).toHaveText("1");
  expect(requests).toBe(1);
  await expect(row.locator("button")).toHaveAttribute("data-preserved", "yes");
  sent = 2;
  await page
    .getByRole("button", { name: "Обновить статистику", exact: true })
    .click();
  await expect(row.getByRole("cell").nth(3)).toHaveText("2");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenCount = requests;
  await page.clock.runFor(60000);
  expect(requests).toBe(hiddenCount);
  sent = 3;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(row.getByRole("cell").nth(3)).toHaveText("3");
  await row.locator("button").click();
  await page.getByRole("button", { name: "2. Цепочка", exact: true }).click();
  await page.locator("#subject").fill("Несохранённый текст");
  sent = 4;
  await page.clock.runFor(30000);
  await expect(page.locator("#subject")).toHaveValue("Несохранённый текст");
  await expect(page.locator("[data-live-metric='sentMessages']")).toHaveText(
    "4",
  );
  await page.getByRole("button", { name: "Почты", exact: true }).click();
  const offPageCount = requests;
  await page.clock.runFor(60000);
  expect(requests).toBe(offPageCount);
});

test("failed refresh retains counts, slow requests do not overlap, and completion updates controls", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const c = await (
    await page.request.post("/api/campaigns/draft", {
      headers: { Origin: "http://127.0.0.1:19100" },
      data: { name: "Safe refresh" },
    })
  ).json();
  let mode = "ok",
    release,
    requests = 0;
  await page.route("**/api/campaigns/progress", async (route) => {
    requests++;
    if (mode === "slow") await new Promise((resolve) => (release = resolve));
    if (mode === "error")
      return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    return route.fulfill({
      json: {
        campaigns: [
          {
            id: c.id,
            status: "completed",
            totalContacts: 3,
            sentMessages: 3,
            contactedContacts: 3,
            repliedContacts: 0,
            attentionContacts: 0,
          },
        ],
      },
    });
  });
  await page.route(`**/api/campaigns/${c.id}`, async (route) =>
    route.fulfill({ json: { ...c, status: "active", leads: [] } }),
  );
  await page.clock.install();
  await page.reload();
  await page.locator(`[data-campaign="${c.id}"]`).click();
  mode = "slow";
  await page
    .getByRole("button", { name: "Обновить статистику", exact: true })
    .click();
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator("#refresh-progress")).toBeDisabled();
  // The 10s request deadline is below the 30s polling interval. Duplicate
  // user clicks are blocked while the request is pending.
  await page.clock.runFor(1000);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  expect(requests).toBe(1);
  release();
  await expect(page.locator(".top .campaign-status")).toHaveText("Закончена");
  await expect(page.locator("#toggle")).toBeDisabled();
  await expect(page.locator("[data-live-metric='sentMessages']")).toHaveText(
    "3",
  );
  mode = "error";
  await page
    .getByRole("button", { name: "Обновить статистику", exact: true })
    .click();
  await expect(page.locator("[data-progress-hint]")).toContainText(
    "Нет обновления",
  );
  await expect(page.locator("[data-live-metric='sentMessages']")).toHaveText(
    "3",
  );
  await expect(page.locator("#refresh-progress")).toBeEnabled();
});

test("a stale unauthorized progress response cannot replace navigation with login", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.request.post("/api/campaigns/draft", {
    headers: { Origin: "http://127.0.0.1:19100" },
    data: { name: "Navigation fixture" },
  });
  await page.reload();
  let releaseProgress, releaseState;
  await page.route("**/api/campaigns/progress", async (route) => {
    await new Promise((resolve) => (releaseProgress = resolve));
    await route.fulfill({ status: 401, json: { error: "Expired" } });
  });
  await page.route("**/api/state", async (route) => {
    await new Promise((resolve) => (releaseState = resolve));
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Обновить статистику", exact: true })
    .click();
  await expect.poll(() => Boolean(releaseProgress)).toBe(true);
  await page.getByRole("button", { name: "Почты", exact: true }).click();
  await expect.poll(() => Boolean(releaseState)).toBe(true);
  releaseProgress();
  await page.waitForResponse((response) =>
    response.url().endsWith("/api/campaigns/progress"),
  );
  releaseState();
  await expect(page.locator('[data-nav="mailboxes"]')).toHaveClass("active");
  await expect(page.locator("form.login")).toHaveCount(0);
});
