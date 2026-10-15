import { test, expect } from "@playwright/test";
import { renderLetter } from "../../marketing/render.mjs";
test("Waypoint builder adds, edits, reorders, deletes/undoes and persists JSON and compiled HTML", async ({
  page,
}) => {
  const id = "00000000-0000-4000-8000-000000000002";
  let saved = {
    id,
    title: "Builder fixture",
    subject: "Subject",
    preheader: "",
    editorMode: "builder",
    source: JSON.stringify({
      schemaVersion: 1,
      document: { root: { type: "EmailLayout", data: { childrenIds: [] } } },
    }),
    sources: { html: "", markdown: "" },
    version: 1,
  };
  await page.route(`**/api/marketing/letters/${id}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/preview")) {
      try {
        await route.fulfill({
          json: renderLetter({
            ...route.request().postDataJSON(),
            context: { type: "preview" },
          }),
        });
      } catch (error) {
        await route.fulfill({ status: 422, json: { message: error.message } });
      }
      return;
    }
    if (route.request().method() === "PUT")
      saved = {
        ...saved,
        ...route.request().postDataJSON(),
        version: saved.version + 1,
      };
    await route.fulfill({ json: saved });
  });
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.goto(`/#marketing/letters/${id}`);
  const frame = page.frameLocator('iframe[title="Визуальный конструктор"]');
  await frame.getByRole("button", { name: "Текст", exact: true }).click();
  await frame.getByLabel("Текст блока", { exact: true }).fill("Первый блок");
  await frame.getByRole("button", { name: "Заголовок", exact: true }).click();
  await frame.getByLabel("Текст блока", { exact: true }).fill("Второй блок");
  await frame.getByRole("button", { name: "Выше", exact: true }).click();
  await frame.getByRole("button", { name: "Дублировать", exact: true }).click();
  await frame.getByRole("button", { name: "Удалить", exact: true }).click();
  await frame.getByRole("button", { name: "Отменить", exact: true }).click();
  await frame.getByRole("button", { name: "Строки", exact: true }).click();
  for (const count of [1, 2, 3, 4, 6])
    await frame
      .getByRole("button", { name: `Строка: ${count} колонок`, exact: true })
      .click();
  await frame.getByRole("button", { name: "Настройки", exact: true }).click();
  await frame.getByLabel("Ширина письма, px", { exact: true }).fill("720");
  await page
    .getByRole("button", { name: "Вставить переменную", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Название переменной", { exact: true })
    .fill("firstName");
  await page
    .getByRole("dialog")
    .getByLabel("Запасное значение", { exact: true })
    .fill("Коллега");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Вставить", exact: true })
    .click();
  await expect(
    page.frameLocator("[data-frame]").getByText("Коллега", { exact: true }),
  ).toBeVisible();
  await expect(
    page.frameLocator("[data-frame]").getByText("Первый блок", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-save-status]")).toHaveText(/Сохранено/);
  const before = JSON.parse(saved.source);
  expect(before.document.root.data.width).toBe(720);
  expect(
    Object.values(before.document)
      .filter((b) => b.type === "ColumnsContainer")
      .map((b) => b.data.props.columns.length),
  ).toEqual([1, 2, 3, 4, 6]);
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://foreign.invalid",
        data: {
          channel: "dmailio-builder",
          schemaVersion: 1,
          type: "change",
          source: "corrupt",
        },
      }),
    ),
  );
  await page.reload();
  await expect(page.locator("[data-mode]")).toHaveValue("builder");
  await expect(
    frame.getByLabel("Ширина письма, px", { exact: true }),
  ).toBeHidden();
  await frame.getByRole("button", { name: "Настройки", exact: true }).click();
  await expect(
    frame.getByLabel("Ширина письма, px", { exact: true }),
  ).toHaveValue("720");
  await expect(
    page.frameLocator("[data-frame]").getByText("Первый блок", { exact: true }),
  ).toBeVisible();
  expect(JSON.parse(saved.source)).toEqual(before);
});
