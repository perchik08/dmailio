import { test, expect } from "@playwright/test";
import { renderLetter } from "../../marketing/render.mjs";
test("every advanced block edits, saves, reloads and renders, including a real public countdown GIF", async ({
  page,
  request,
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
  const cases = [
    [
      "Таблица",
      "Строки таблицы (колонки через Tab)",
      "Название\tОписание\nПродукт\tДлинное значение",
    ],
    [
      "Соцсети",
      "Ссылки: название|https://адрес (по одной в строке)",
      "Telegram|https://example.com/social",
    ],
    [
      "Меню",
      "Ссылки: название|https://адрес (по одной в строке)",
      "О нас|https://example.com/about",
    ],
    ["Иконки", "Символы иконок", "★ ✓"],
    ["Стикер", "Адрес HTTPS", "https://example.invalid/sticker.png"],
    ["GIF", "Адрес HTTPS", "https://example.invalid/animation.gif"],
    ["Видео", "Адрес HTTPS", "https://example.com/video"],
    [
      "Галерея",
      "Адреса изображений HTTPS (по одному в строке)",
      "https://example.invalid/one.png\nhttps://example.invalid/two.png",
    ],
    ["Таймер", "Дата ISO с часовым поясом", "2026-12-31T18:00:00+03:00"],
  ];
  for (const [label, field, value] of cases) {
    await frame.getByRole("button", { name: label, exact: true }).click();
    await frame.getByLabel(field, { exact: true }).fill(value);
  }
  await expect(page.locator("[data-save-status]")).toHaveText(/Сохранено/);
  await expect(
    page
      .frameLocator("[data-frame]")
      .getByText("Длинное значение", { exact: true }),
  ).toBeVisible();
  const before = JSON.parse(saved.source);
  expect(Object.keys(before.document)).toHaveLength(10);
  await page.reload();
  await expect(
    page
      .frameLocator("[data-frame]")
      .getByRole("link", { name: "Telegram", exact: true }),
  ).toHaveAttribute("href", "https://example.com/social");
  await expect(
    page
      .frameLocator("[data-frame]")
      .getByRole("link", { name: /Посмотреть видео/ }),
  ).toHaveAttribute("href", "https://example.com/video");
  await expect(
    page.frameLocator("[data-frame]").getByRole("img", { name: /Галерея/ }),
  ).toHaveCount(2);
  const timer = page
    .frameLocator("[data-frame]")
    .getByRole("img", { name: /Обратный отсчёт/ });
  const src = await timer.getAttribute("src");
  const response = await request.get(src);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/gif");
  expect((await response.body()).subarray(0, 6).toString()).toBe("GIF89a");
  expect(JSON.parse(saved.source)).toEqual(before);
});
