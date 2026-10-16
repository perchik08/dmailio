import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
for (const format of ["xlsx", "csv"])
  test(`import 167 ${format} contacts into a blank campaign and preserve empty chain without permitting launch`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("Пароль").fill("fixture-password-only");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page
      .getByRole("button", { name: "Создать кампанию", exact: true })
      .click();
    const stamp = Date.now();
    const rows = Array.from({ length: 167 }, (_, i) => [
      `lead${i}-${stamp}@example.com`,
      `Name${i}`,
    ]);
    let buffer;
    if (format === "xlsx") {
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet("Contacts");
      sheet.addRow(["Email", "Имя"]);
      sheet.addRows(rows);
      buffer = Buffer.from(await book.xlsx.writeBuffer());
    } else
      buffer = Buffer.from(
        "Email,Имя\n" + rows.map((r) => r.join(",")).join("\n"),
      );
    await page.locator("#import-file").setInputFiles({
      name: `contacts.${format}`,
      mimeType:
        format === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv",
      buffer,
    });
    await page
      .getByRole("button", {
        name: "Проверить и показать результат",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Импортировать 167 контактов", exact: true })
      .click();
    await expect(page.locator("#notice")).toContainText(
      "Импортировано контактов: 167",
    );
    const state = await (await page.request.get("/api/state")).json();
    const campaign = state.campaigns.find((c) =>
      c.counts.some((r) => r.count === 167),
    );
    expect(campaign).toBeTruthy();
    const saved = await (
      await page.request.get("/api/campaigns/" + campaign.id)
    ).json();
    expect(saved.leads).toHaveLength(167);
    expect(saved.steps[0]).toMatchObject({ body: "", subject: "" });
    const r = await page.request.post(
      "/api/campaigns/" + campaign.id + "/status",
      {
        headers: { Origin: "http://127.0.0.1:19100" },
        data: { status: "active" },
      },
    );
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("текст каждого письма");
    await page.reload();
    await page.locator(`[data-campaign="${campaign.id}"]`).click();
    await expect(page.locator("#lead-browser")).toContainText("167");
  });
