import { test, expect } from "@playwright/test";

test("marketing navigation has truthful unavailable state without a backend, or persistent contacts and lists with real listmonk", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Списки рассылки", exact: true })
    .click();
  if (!process.env.MARKETING_TEST_DATABASE_URL) {
    await expect(page.getByRole("alert")).toContainText("недоступ");
    await page.getByRole("button", { name: "Кампании", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Кампании", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    return;
  }
  const suffix = Date.now();
  const name = `Browser list ${suffix}`;
  const email = `browser-${suffix}@example.invalid`;
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
    .getByRole("button", { name: "Добавить контакт", exact: true })
    .click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Email", { exact: true }).fill(email);
  await form
    .getByLabel("Отображаемое имя", { exact: true })
    .fill("Browser contact");
  await form.getByLabel("Компания", { exact: true }).fill("Browser ACME");
  await form
    .getByLabel("Источник контакта", { exact: true })
    .fill("Browser fixture");
  await form.getByLabel(name, { exact: true }).check();
  await form
    .getByLabel("Подтверждаю согласие контакта на маркетинговые письма")
    .check();
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: email, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: email, exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Компания", { exact: true })
    .fill("Edited ACME");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("Поиск", { exact: true }).fill("Edited ACME");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(
    page.getByRole("button", { name: email, exact: true }),
  ).toBeVisible();
  await page.getByLabel(`Выбрать ${email}`, { exact: true }).check();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Экспорт Excel", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("contacts.xlsx");
  await page
    .getByRole("button", { name: "Убрать из списка", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Убрать из списка", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: email, exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Контакты", exact: true }).click();
  await page.getByLabel("Поиск", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(
    page.getByRole("button", { name: email, exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
