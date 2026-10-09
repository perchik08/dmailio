import { test, expect } from "@playwright/test";
test("letter autosave/reload preserves source; stale second tab offers copy without losing input", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Письма рассылок", exact: true })
    .click();
  if (!process.env.MARKETING_TEST_DATABASE_URL) {
    await expect(page.getByRole("alert")).toContainText("недоступ");
    return;
  }
  await page
    .getByRole("button", { name: "Письмо с нуля", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Название письма", { exact: true })
    .fill(`Browser letter ${Date.now()}`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Создать", exact: true })
    .click();
  await page
    .getByLabel("Исходник письма", { exact: true })
    .fill("<p>Initial</p>");
  await expect(page.locator("[data-save-status]")).toHaveText(
    /Сохранено · версия 2/,
  );
  await page.reload();
  await expect(page.getByLabel("Исходник письма", { exact: true })).toHaveValue(
    "<p>Initial</p>",
  );
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(
    second.getByLabel("Исходник письма", { exact: true }),
  ).toHaveValue("<p>Initial</p>");
  await page
    .getByLabel("Исходник письма", { exact: true })
    .fill("<p>New server value</p>");
  await expect(page.locator("[data-save-status]")).toHaveText(
    /Сохранено · версия 3/,
  );
  await second
    .getByLabel("Исходник письма", { exact: true })
    .fill("<p>My local value</p>");
  await expect(second.locator("[data-conflict]")).toBeVisible();
  await expect(
    second.getByLabel("Исходник письма", { exact: true }),
  ).toHaveValue("<p>My local value</p>");
  await second
    .getByRole("button", { name: "Сохранить копию", exact: true })
    .click();
  await expect(
    second.getByLabel("Исходник письма", { exact: true }),
  ).toHaveValue("<p>My local value</p>");
  await expect(second).not.toHaveURL(page.url());
  await second.close();
  await page.reload();
  await expect(page.getByLabel("Исходник письма", { exact: true })).toHaveValue(
    "<p>New server value</p>",
  );
});
