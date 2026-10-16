import { test, expect } from "@playwright/test";
test("campaign list separates total contacts, sent messages and contacts with a send", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const result = await page.request.post("/api/campaigns/draft", {
    headers: { Origin: "http://127.0.0.1:19100" },
    data: { name: "Send counts " + Date.now() },
  });
  const c = await result.json();
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    state.campaigns = state.campaigns.map((r) =>
      r.id === c.id
        ? {
            ...r,
            counts: [
              { status: "pending", count: 3 },
              { status: "replied", count: 1 },
            ],
            sentMessages: 7,
            contactedContacts: 2,
          }
        : r,
    );
    await route.fulfill({ json: state });
  });
  await page.reload();
  await expect(
    page.getByRole("columnheader", { name: "Отправлено писем", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", {
      name: "Контактов с отправкой",
      exact: true,
    }),
  ).toBeVisible();
  const row = page
    .locator("tr")
    .filter({ has: page.locator(`[data-campaign="${c.id}"]`) });
  const cells = row.getByRole("cell");
  await expect(cells.nth(2)).toHaveText("4");
  await expect(cells.nth(3)).toHaveText("7");
  await expect(cells.nth(4)).toHaveText("2");
  await expect(cells.nth(5)).toHaveText("1");
});
