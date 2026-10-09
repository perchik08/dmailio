import { test, expect } from "@playwright/test";

test("one login opens outreach and full inbox without connecting a real mailbox", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("Пароль").fill("fixture-password-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Кампании", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Инбокс", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Почта", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Инбокс", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
