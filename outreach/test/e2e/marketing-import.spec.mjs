import { test, expect } from "@playwright/test";
test("CSV import maps custom fields, persists result after reload and exports rejected rows", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Списки рассылки", exact: true })
    .click();
  if (!process.env.MARKETING_TEST_DATABASE_URL) {
    await expect(page.getByRole("alert")).toContainText("недоступ");
    return;
  }
  const name = `Import browser ${Date.now()}`,
    email = `import-browser-${Date.now()}@example.invalid`;
  await page
    .getByRole("button", { name: "Создать список", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Название", { exact: true })
    .fill(name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name, exact: true }).click();
  await page
    .getByRole("button", { name: "Импорт CSV / Excel", exact: true })
    .click();
  await page.getByLabel("Файл CSV или Excel", { exact: true }).setInputFiles({
    name: "clients.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`Email;Заметка\n${email};Свой текст\ninvalid;Ошибка`),
  });
  await expect(page.getByLabel("Тип столбца Email")).toBeVisible();
  await page.getByLabel("Тип столбца Заметка").selectOption("custom");
  await page.getByLabel("Название переменной Заметка").fill("Комментарий");
  await page
    .getByLabel("Источник базы", { exact: true })
    .fill("Browser import");
  await page
    .getByRole("button", { name: "Проверить сопоставление", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Готовы:" }),
  ).toContainText("ошибки: 1");
  await page
    .getByRole("button", { name: "Импортировать", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Завершён:" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: "Завершён:" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Скачать отчёт CSV по строкам" })
    .click();
  expect((await download).suggestedFilename()).toBe("import-report.csv");
  await page.getByRole("link", { name: "Перейти к контактам" }).click();
  await page.getByRole("button", { name: email, exact: true }).click();
  await expect(
    page.getByRole("dialog").getByLabel("Значение", { exact: true }),
  ).toHaveValue("Свой текст");
});
