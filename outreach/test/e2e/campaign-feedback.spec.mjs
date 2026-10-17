import { test, expect } from "@playwright/test";
async function fixture(page) {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const post = (path, data) =>
    page.request.post(path, {
      headers: { Origin: "http://127.0.0.1:19100" },
      data,
    });
  const stamp = Date.now();
  const m = await (
    await post("/api/mailboxes", {
      email: `feedback-${stamp}@example.com`,
      limit: 30,
      verify: true,
      smtp: { host: "smtp.example.com", port: 465, password: "fixture-only" },
      imap: { host: "imap.example.com", port: 993, password: "fixture-only" },
    })
  ).json();
  const draft = await (
    await post("/api/campaigns/draft", { name: "Feedback " + stamp })
  ).json();
  const campaign = await (
    await post("/api/campaigns", {
      ...draft,
      mailboxIds: [m.id],
      steps: [{ subject: "Fixture", body: "Fixture body", delay: 0 }],
    })
  ).json();
  await post(`/api/campaigns/${campaign.id}/import`, {
    csv: `email\nfeedback-lead-${stamp}@example.com`,
  });
  await page.reload();
  await page.locator(`[data-campaign="${campaign.id}"]`).click();
  return campaign;
}

test("active campaign settings save without pausing or losing a draft on statistics refresh", async ({
  page,
}) => {
  const c = await fixture(page);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Кампания запущена");
  await page.getByRole("button", { name: "3. Настройки", exact: true }).click();
  await expect(page.locator("#campaign-name")).toBeEnabled();
  await page.locator("#campaign-name").fill("Updated active campaign");
  await page.locator("#interval").fill("15");
  await page.locator("#daily-limit").fill("25");
  await page.locator("#timezone").fill("UTC");
  await page.locator("#track").check();
  await page.locator("#track-clicks").check();
  await page
    .getByRole("button", { name: "Обновить статистику", exact: true })
    .click();
  await expect(page.locator("#campaign-name")).toHaveValue(
    "Updated active campaign",
  );
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Кампания сохранена");
  const saved = await (await page.request.get(`/api/campaigns/${c.id}`)).json();
  expect(saved.status).toBe("active");
  expect(saved.name).toBe("Updated active campaign");
  expect(saved.schedule.interval).toBe(15);
  expect(saved.schedule.timezone).toBe("UTC");
  expect(saved.dailyLimit).toBe(25);
  expect(saved.trackOpens && saved.trackClicks).toBe(true);
  await page.reload();
  await page.locator(`[data-campaign="${c.id}"]`).click();
  await page.getByRole("button", { name: "3. Настройки", exact: true }).click();
  await expect(page.locator("#interval")).toHaveValue("15");
});
test("launch, pause and resume display confirmed notifications and retain the newest timer", async ({
  page,
}) => {
  const c = await fixture(page);
  await page.clock.install();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Кампания запущена", {
    timeout: 2000,
  });
  await expect(
    page.getByRole("button", { name: "Пауза", exact: true }),
  ).toBeEnabled();
  await page.clock.runFor(4000);
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  await expect(page.locator("#notice")).toContainText(
    "Кампания приостановлена",
  );
  await page.clock.runFor(2100);
  await expect(page.locator("#notice")).toContainText(
    "Кампания приостановлена",
  );
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Кампания возобновлена");
  expect(
    (await (await page.request.get("/api/campaigns/" + c.id)).json()).status,
  ).toBe("active");
});
test("pending launch stays disabled across tabs and does not issue duplicate requests", async ({
  page,
}) => {
  const c = await fixture(page);
  let release,
    requests = 0;
  const wait = new Promise((r) => (release = r));
  await page.route(`**/api/campaigns/${c.id}/status`, async (route) => {
    requests++;
    await wait;
    await route.fulfill({ response: await route.fetch() });
  });
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  const toggle = page.locator("#toggle");
  await expect(toggle).toBeDisabled();
  await expect(toggle).toContainText("Запускаем");
  await page.getByRole("button", { name: "3. Настройки", exact: true }).click();
  await expect(toggle).toBeDisabled();
  await toggle.evaluate((b) => b.click());
  expect(requests).toBe(1);
  release();
  await expect(page.locator("#notice")).toContainText("Кампания запущена");
  await expect(toggle).toBeEnabled();
});
test("cancelled launch does nothing and failed launch shows an error without claiming success", async ({
  page,
}) => {
  const c = await fixture(page);
  let calls = 0;
  await page.route(`**/api/campaigns/${c.id}/status`, (route) => {
    calls++;
    return route.fulfill({
      status: 400,
      json: { error: "Проверьте подключения всех ящиков" },
    });
  });
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  expect(calls).toBe(0);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await expect(page.locator("#notice")).toContainText(
    "Не удалось запустить кампанию",
  );
  await expect(page.locator("#notice")).toHaveAttribute("role", "alert");
  await expect(
    page.getByRole("button", { name: "Запустить", exact: true }),
  ).toBeEnabled();
  expect(
    (await (await page.request.get("/api/campaigns/" + c.id)).json()).status,
  ).toBe("draft");
});

test("expired authentication during launch keeps the login screen visible", async ({
  page,
}) => {
  const c = await fixture(page);
  await page.route(`**/api/campaigns/${c.id}/status`, (route) =>
    route.fulfill({ status: 401, json: { error: "Требуется вход" } }),
  );
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Войти в команду", exact: true }),
  ).toBeVisible({ timeout: 2000 });
  await expect(page.locator("#notice")).toContainText("Требуется вход");
});
