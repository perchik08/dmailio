import { test, expect } from "@playwright/test";
test("closing a dirty tab warns and a new tab recovers its durable draft", async ({
  page,
  context,
}) => {
  const id = "00000000-0000-4000-8000-000000000001";
  await context.route(`**/api/marketing/letters/${id}`, async (route) => {
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

  const warning = page.waitForEvent("dialog");
  const closing = page.close({ runBeforeUnload: true });
  const dialog = await warning;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
  await closing;
  const reopened = await context.newPage();
  await reopened.goto(`/#marketing/letters/${id}`);
  await reopened
    .getByRole("button", { name: "Восстановить локальный ввод", exact: true })
    .click();
  await expect(
    reopened.getByLabel("Исходник письма", { exact: true }),
  ).toHaveValue("<p>Local edit</p>");
});
