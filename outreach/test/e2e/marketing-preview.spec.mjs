import { test, expect } from "@playwright/test";
test("real HTML/Markdown rendering, safe preview, image upload and export", async ({
  page,
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
    .getByRole("button", { name: "Создать", exact: true })
    .click();
  await page
    .getByLabel("Исходник письма", { exact: true })
    .fill(
      '<table><tr><td>{Привет|Здравствуйте}, {{firstName}}!</td></tr></table><script>parent.alert("unsafe")</script>',
    );
  await expect(page.frameLocator("[data-frame]").locator("td")).toContainText(
    "Анна",
  );
  await expect(page.frameLocator("[data-frame]").locator("script")).toHaveCount(
    0,
  );
  await expect(
    page
      .frameLocator("[data-frame]")
      .getByText("Отписка (предпросмотр, действие недоступно)"),
  ).toBeVisible();
  await expect(
    page.frameLocator("[data-frame]").getByRole("link", { name: /Отпис/ }),
  ).toHaveCount(0);
  await page.locator("[data-mode]").selectOption("markdown");
  await page
    .getByLabel("Исходник письма", { exact: true })
    .fill("# Заголовок\n\n{{unknown|Коллега}}");
  await expect(
    page
      .frameLocator("[data-frame]")
      .getByRole("heading", { name: "Заголовок" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Вставить изображение", exact: true })
    .click();
  const modal = page.getByRole("dialog");
  await modal.locator("[name=file]").setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG3cAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await modal
    .getByLabel("Описание картинки", { exact: true })
    .fill("Миниатюра");
  await modal.getByRole("button", { name: "Вставить", exact: true }).click();
  await expect(
    page.frameLocator("[data-frame]").getByRole("img", { name: "Миниатюра" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать HTML", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.html$/);
  await expect(page.locator("[data-save-status]")).toHaveText(/Сохранено/);
  await page.reload();
  await expect(page.getByLabel("Исходник письма", { exact: true })).toHaveValue(
    /Миниатюра/,
  );
  await expect(
    page
      .frameLocator("[data-frame]")
      .getByRole("heading", { name: "Заголовок" }),
  ).toBeVisible();
});
