import { test, expect } from "@playwright/test";
import { renderLetter } from "../../marketing/render.mjs";
test("advanced blocks drop into columns and can be moved with keyboard controls", async ({
  page,
}) => {
  const id = "00000000-0000-4000-8000-000000000003";
  let saved = {
    id,
    title: "Advanced fixture",
    subject: "Subject",
    preheader: "",
    editorMode: "builder",
    source: JSON.stringify({
      schemaVersion: 1,
      document: { root: { type: "EmailLayout", data: { childrenIds: [] } } },
    }),
    version: 1,
  };
  await page.route(`**/api/marketing/letters/${id}**`, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/preview")) {
      try {
        await route.fulfill({
          json: renderLetter({
            ...route.request().postDataJSON(),
            context: { type: "preview", publicURL: "http://127.0.0.1:19100" },
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

  await frame.getByRole("button", { name: "Строки", exact: true }).click();
  await frame
    .getByRole("button", { name: "Строка: 2 колонок", exact: true })
    .click();
  await frame.getByRole("button", { name: "Содержимое", exact: true }).click();
  const firstColumn = frame.locator('[data-builder-column="0"]').first();
  await expect(firstColumn).toBeVisible();
  await frame
    .getByRole("button", { name: "Галерея", exact: true })
    .dragTo(firstColumn);
  await expect
    .poll(
      () =>
        Object.values(JSON.parse(saved.source).document).filter(
          (b) => b.type === "Gallery",
        ).length,
    )
    .toBe(1);
  const doc = JSON.parse(saved.source).document;
  const rowId = Object.keys(doc).find(
    (id) => doc[id].type === "ColumnsContainer",
  );
  const galleryId = Object.keys(doc).find((id) => doc[id].type === "Gallery");
  expect(doc[rowId].data.props.columns[0].childrenIds).toContain(galleryId);
  expect(doc.root.data.childrenIds).not.toContain(galleryId);
  await frame
    .getByLabel("Место вставки", { exact: true })
    .selectOption(`${rowId}:1`);
  await frame
    .getByRole("button", { name: "Переместить в выбранное место", exact: true })
    .click();
  await expect
    .poll(
      () =>
        JSON.parse(saved.source).document[rowId].data.props.columns[1]
          .childrenIds,
    )
    .toContain(galleryId);
  await page.reload();
  await expect(
    frame.locator('[data-builder-column="1"]').first(),
  ).toBeVisible();
});
