import { test, expect } from "@playwright/test";
test("disconnect requires confirmation, persists after reload and reconnects the same mailbox with new passwords", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const address = "disconnect-" + Date.now() + "@example.com";
  const created = await page.request.post("/api/mailboxes", {
    headers: { Origin: "http://127.0.0.1:19100" },
    data: {
      email: address,
      limit: 30,
      smtp: { host: "smtp.example.com", port: 465, password: "fixture-only" },
      imap: { host: "imap.example.com", port: 993, password: "fixture-only" },
    },
  });
  expect(created.ok()).toBe(true);
  const box = await created.json();
  await page.reload();
  await page.getByRole("button", { name: "Почты", exact: true }).click();
  const row = page
    .locator("[data-mailbox-row]")
    .filter({ has: page.locator(`[data-mailbox-detail="${box.id}"]`) });
  for (const name of ["Подпись", "Настройки", "Проверить", "Отвязать"]) {
    const action = row.getByRole("button", { name, exact: true });
    await expect(action).toHaveAttribute("title", name);
    await expect(action.locator(".ui-icon")).toBeVisible();
    expect((await action.textContent()).trim()).toBe("");
  }
  page.once("dialog", (d) => d.dismiss());
  await row.getByRole("button", { name: "Отвязать", exact: true }).click();
  expect(
    (await (await page.request.get("/api/mailboxes")).json()).find(
      (m) => m.id === box.id,
    ).detached,
  ).toBe(false);
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Отвязать", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Почты", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Подключить снова", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Подключить почту", exact: true })
    .click();
  await page.locator("[name=email]").fill(address);
  await page.locator("[name=smtpHost]").fill("smtp.example.com");
  await page.locator("[name=imapHost]").fill("imap.example.com");
  for (const field of ["smtpPassword", "imapPassword"]) {
    await expect(page.locator(`[name=${field}]`)).toHaveAttribute(
      "required",
      "",
    );
    await page.locator(`[name=${field}]`).fill("new-fixture-only");
  }
  await page
    .getByRole("button", { name: "Сохранить подключение", exact: true })
    .click();
  await expect(
    row.getByRole("button", { name: "Отвязать", exact: true }),
  ).toBeVisible();
  const boxes = await (await page.request.get("/api/mailboxes")).json();
  expect(boxes.filter((m) => m.email === address)).toHaveLength(1);
  expect(boxes.find((m) => m.id === box.id)).toMatchObject({
    detached: false,
    verified: true,
  });
  // Leave the disposable fixture detached; no provider connections were opened.
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Отвязать", exact: true }).click();
  await expect(row).toHaveCount(0);
});
