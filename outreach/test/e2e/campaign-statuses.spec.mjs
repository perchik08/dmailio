import { test, expect } from "@playwright/test";

test("campaign statuses have distinct labels and colors in list and detail", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const cases = [
    ["draft", "Черновик", "rgb(238, 240, 255)", "rgb(83, 91, 176)"],
    ["active", "Активна", "rgb(233, 247, 239)", "rgb(39, 115, 77)"],
    ["paused", "Остановлена", "rgb(255, 240, 240)", "rgb(174, 64, 73)"],
    ["completed", "Закончена", "rgb(237, 241, 246)", "rgb(71, 85, 105)"],
  ];
  const response = await page.request.post("/api/campaigns/draft", {
    headers: { Origin: "http://127.0.0.1:19100" },
    data: { name: "Status fixture" },
  });
  const draft = await response.json();
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    state.campaigns = cases.map(([status]) => ({
      ...draft,
      id: status,
      name: "Campaign " + status,
      status,
      counts: [],
      sentMessages: 0,
      contactedContacts: 0,
    }));
    await route.fulfill({ json: state });
  });
  await page.route("**/api/campaigns/*", async (route) => {
    const status = route.request().url().split("/").at(-1);
    await route.fulfill({
      json: {
        ...draft,
        id: status,
        name: "Campaign " + status,
        status,
        leads: [],
      },
    });
  });
  for (const [status, label, background, foreground] of cases) {
    await page.goto("/");
    const row = page
      .locator("tr")
      .filter({ has: page.locator(`[data-campaign="${status}"]`) });
    const badge = row.locator(".badge");
    await expect(badge).toHaveText(label);
    await expect(badge).toHaveCSS("background-color", background);
    await expect(badge).toHaveCSS("color", foreground);
    await row.locator("button").click();
    const detailBadge = page.locator(".top .badge");
    await expect(detailBadge).toHaveText(label);
    await expect(detailBadge).toHaveCSS("background-color", background);
    if (status === "completed")
      await expect(page.locator("#toggle")).toBeDisabled();
  }
});
