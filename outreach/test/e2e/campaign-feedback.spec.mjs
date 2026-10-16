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
