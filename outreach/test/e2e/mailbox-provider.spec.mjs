import { test, expect } from "@playwright/test";

test("mailbox provider choices are selectable by mouse and apply SMTP/IMAP presets", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Почты", exact: true }).click();
  await page.locator("#add-mailbox").click();
  const provider = page.locator("#provider");
  await expect(provider.locator("option")).toHaveCount(4);
  await page.locator("[name=email]").fill("my-mail@example.com");
  for (const [id, smtp, imap] of [
    ["yandex", "smtp.yandex.ru", "imap.yandex.ru"],
    ["google", "smtp.gmail.com", "imap.gmail.com"],
    ["vk", "smtp.mail.ru", "imap.mail.ru"],
  ]) {
    await provider.click();
    await provider.locator(`option[value="${id}"]`).click();
    await expect(provider).toHaveValue(id);
    await expect(page.locator("[name=smtpHost]")).toHaveValue(smtp);
    await expect(page.locator("[name=imapHost]")).toHaveValue(imap);
    await expect(page.locator("[name=smtpPort]")).toHaveValue("465");
    await expect(page.locator("[name=imapPort]")).toHaveValue("993");
    await expect(page.locator("[name=smtpSecure]")).toBeChecked();
    await expect(page.locator("[name=imapSecure]")).toBeChecked();
    await expect(page.locator("[name=email]")).toHaveValue(
      "my-mail@example.com",
    );
  }
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page.locator("dialog")).toHaveCount(0);
});
