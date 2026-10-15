import { test, expect } from "@playwright/test";
test("saved textarea label is stable and failed saving keeps local input", async ({
  page,
}) => {
  const id = "00000000-0000-4000-8000-000000000001";
  await page.route(`**/api/marketing/letters/${id}`, async (route) => {
    if (route.request().method() === "GET")
      await route.fulfill({
        json: {
          id,
          title: "Saved fixture",
          subject: "Subject",
          preheader: "",
          editorMode: "html",
          source: "<p>Saved</p>",
          sources: { html: "<p>Saved</p>", markdown: "" },
          version: 2,
        },
      });
    else
      await route.fulfill({
        status: 503,
        json: {
          code: "MARKETING_UNAVAILABLE",
          message: "Test connection failure",
        },
      });
  });
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.goto(`/#marketing/letters/${id}`);
  await expect(page.getByLabel("Исходник письма", { exact: true })).toHaveValue(
    "<p>Saved</p>",
  );
  await page
    .getByLabel("Исходник письма", { exact: true })
    .fill("<p>Local edit</p>");
  await expect(page.locator("[data-save-status]")).toContainText(
    "Не сохранено:",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page
    .getByRole("button", { name: "Восстановить локальный ввод", exact: true })
    .click();
  await expect(page.getByLabel("Исходник письма", { exact: true })).toHaveValue(
    "<p>Local edit</p>",
  );
});
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
