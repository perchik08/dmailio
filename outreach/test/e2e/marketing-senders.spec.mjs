import { test, expect } from "@playwright/test";
test("sender profiles save, connection checks do not send, and test sending requires an explicit recipient", async ({
  page,
}) => {
  const id = "00000000-0000-4000-8000-000000000099";
  let sends = 0,
    checks = 0;
  let sender = {
    id,
    email: "fixture@example.com",
    fromName: "Fixture",
    replyTo: "fixture@example.com",
    enabled: true,
    verified: true,
    marketingEnabled: false,
    eligible: false,
    checkedAt: null,
    providerDailyLimit: 30,
    providerCeiling: 10000,
    externalReserve: 0,
    intervalSeconds: 60,
    budget: { limit: 30, used: 0, remaining: 30, reason: null },
  };
  await page.route("**/api/marketing/senders**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/test")) {
      sends++;
      await route.fulfill({
        json: { status: "accepted", messageId: "test-message" },
      });
    } else if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      sender = {
        ...sender,
        ...input,
        marketingEnabled: input.enabled,
        eligible: input.enabled,
      };
      await route.fulfill({ json: sender });
    } else
      await route.fulfill({ json: { items: [sender], defaultSenderId: null } });
  });
  await page.route(`**/api/marketing/transports/${id}/check`, async (route) => {
    checks++;
    await route.fulfill({ json: sender });
  });
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.goto("/#marketing/senders");
  await expect(
    page.getByRole("heading", { name: "Отправители рассылок", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Разрешить для рассылок").check();
  await page.getByLabel("Имя отправителя").fill("Новое имя");
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect(page.getByLabel("Имя отправителя")).toHaveValue("Новое имя");
  await page
    .getByRole("button", { name: "Проверить подключение", exact: true })
    .click();
  await expect.poll(() => checks).toBe(1);
  expect(sends).toBe(0);
  await page
    .getByRole("button", { name: "Тестовое письмо", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Отправить одно письмо", exact: true })
    .click();
  expect(sends).toBe(0);
  await dialog.getByLabel("Получатель теста").fill("recipient@example.com");
  await dialog
    .getByRole("button", { name: "Отправить одно письмо", exact: true })
    .click();
  await expect(page.locator("[data-feedback]")).toContainText("принято SMTP");
  expect(sends).toBe(1);
  await page.reload();
  await expect(page.getByLabel("Имя отправителя")).toHaveValue("Новое имя");
  await page
    .getByRole("button", { name: "Подключить почту", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Почты", exact: true }),
  ).toBeVisible();
});
