import { test, expect } from "@playwright/test";
for (const fail of [false, true])
  test(`normal mailbox form automatically verifies and ${fail ? "shows actionable failure with retry" : "unlocks warmup without an extra click"}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("Пароль").fill("fixture-password-only");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page.getByRole("button", { name: "Почты", exact: true }).click();
    await page
      .getByRole("button", { name: "Подключить почту", exact: true })
      .click();
    const email = `auto-${fail}-${Date.now()}@example.com`;
    await page.locator("[name=email]").fill(email);
    await page.locator("[name=smtpHost]").fill("smtp.example.com");
    await page.locator("[name=imapHost]").fill("imap.example.com");
    for (const name of ["smtpPassword", "imapPassword"])
      await page
        .locator(`[name=${name}]`)
        .fill(fail ? "reject-fixture-only" : "fixture-only");
    await page
      .getByRole("button", { name: "Сохранить подключение", exact: true })
      .click();
    const row = page.locator("[data-mailbox-row]").filter({ hasText: email });
    await expect(row).toBeVisible();
    if (fail) {
      await expect(row).toContainText("IMAP: провайдер отклонил вход");
      await expect(row.locator("[data-warmup-toggle]")).toBeDisabled();
      await row.getByRole("button", { name: "Настройки", exact: true }).click();
      await page
        .getByRole("button", { name: "Подключение SMTP / IMAP", exact: true })
        .click();
      for (const name of ["smtpPassword", "imapPassword"])
        await page.locator(`[name=${name}]`).fill("fixture-only");
      await page
        .getByRole("button", { name: "Сохранить подключение", exact: true })
        .click();
      await page.getByRole("button", { name: "Почты", exact: true }).click();
    }
    await expect(row.locator("[data-warmup-toggle]")).toBeEnabled();
    await expect(row.locator("[data-warmup-toggle]")).not.toBeChecked();
    await page.reload();
    await page.getByRole("button", { name: "Почты", exact: true }).click();
    await expect(row.locator("[data-warmup-toggle]")).toBeEnabled();
    const boxes = await (await page.request.get("/api/mailboxes")).json();
    expect(boxes.filter((m) => m.email === email)).toHaveLength(1);
    expect(boxes.find((m) => m.email === email).verified).toBe(true);
    page.once("dialog", (d) => d.accept());
    await row.getByRole("button", { name: "Отвязать", exact: true }).click();
    await expect(row).toHaveCount(0);
  });

test("unknown DKIM selector is explained as incomplete discovery rather than a missing domain record", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const response = await page.request.post("/api/mailboxes", {
    headers: { Origin: "http://127.0.0.1:19100" },
    data: {
      email: `dns-${Date.now()}@example.com`,
      limit: 30,
      smtp: { host: "smtp.example.com", port: 465, password: "fixture-only" },
      imap: { host: "imap.example.com", port: 993, password: "fixture-only" },
    },
  });
  const box = await response.json();
  const missing = { status: "missing", values: [], error: "" };
  await page.route(`**/api/mailboxes/${box.id}/dns`, (route) =>
    route.fulfill({
      json: {
        domain: "example.com",
        checkedAt: Date.now(),
        mx: missing,
        spf: missing,
        dmarc: missing,
        dkim: missing,
      },
    }),
  );
  await page.reload();
  await page.getByRole("button", { name: "Почты", exact: true }).click();
  await page.locator(`[data-mailbox-detail="${box.id}"]`).first().click();
  await page.getByRole("button", { name: "DNS-записи", exact: true }).click();
  const card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "DKIM", exact: true }) });
  await expect(card).toContainText("Селектор не найден");
  await expect(card).toContainText("Это не доказывает отсутствие записи");
  await expect(card).not.toContainText("Нужно настроить");
});
