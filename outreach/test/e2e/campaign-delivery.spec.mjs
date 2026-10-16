import { test, expect } from "@playwright/test";
test("campaign journal distinguishes SMTP evidence, Sent copies and legacy evidence", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.route("**/api/analytics*", (route) =>
    route.fulfill({
      json: {
        sent: 2,
        contacted: 2,
        replies: 0,
        bounces: 0,
        uncertain: 0,
        opens: 0,
        steps: [],
        events: [
          {
            id: "a",
            created: Date.now(),
            recipient: "a@example.com",
            kind: "campaign",
            status: "sent",
            error: "",
            delivery: {
              acceptedAt: Date.now(),
              smtpResponse: "250 queued <script>bad()</script>",
              copyStatus: "copied",
            },
          },
          {
            id: "b",
            created: Date.now(),
            recipient: "b@example.com",
            kind: "campaign",
            status: "sent",
            error: "",
            delivery: {
              legacy: true,
              copyStatus: "error",
              copyError: "IMAP unavailable",
            },
          },
        ],
      },
    }),
  );
  await page.getByRole("button", { name: "Аналитика", exact: true }).click();
  await expect(
    page.getByText("SMTP принял письмо: 250 queued <script>bad()</script>", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Копия сохранена в «Отправленных»", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Ответ SMTP для этой старой отправки не сохранён", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Копия в «Отправленных» не сохранена: IMAP unavailable", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.locator("main script")).toHaveCount(0);
});
