import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { importPreview, mappedRows } from "../marketing/import.mjs";

test("marketing import reuses CSV parser, maps custom columns and reports blank/duplicate/invalid email rows", async () => {
  const preview = await importPreview({
    format: "csv",
    content:
      '\uFEFFПочта;Имя;Отдел\r\na@example.com;Анна;"Продажи\nB2B"\r\n;Без почты;ИТ\r\na@example.com;Повтор;ИТ\r\nbroken;Ошибка;ИТ',
  });
  assert.equal(preview.table.rows.length, 4);
  const result = mappedRows(preview.table, [
    { columnId: "column-0", target: "email" },
    { columnId: "column-1", target: "firstName" },
    { columnId: "column-2", target: "custom", variableName: "Отдел" },
  ]);
  assert.equal(result.rows[0].fields.Отдел, "Продажи\nB2B");
  assert.equal(result.rows[0].fields.firstName, "Анна");
  assert.equal(result.rejected.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.throws(() =>
    mappedRows(preview.table, [
      { columnId: "column-0", target: "email" },
      { columnId: "column-1", target: "email" },
    ]),
  );
  assert.throws(() =>
    mappedRows(preview.table, [
      { columnId: "column-0", target: "email" },
      { columnId: "column-1", target: "custom", variableName: "_dmailio" },
    ]),
  );
});
test("Excel import lists sheets and parses chosen sheet without executing formulas", async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Первый").addRow(["Почта"]);
  const second = book.addWorksheet("Клиенты");
  second.addRow(["Email", "Компания"]);
  second.addRow(["b@example.com", "ACME"]);
  const content = Buffer.from(await book.xlsx.writeBuffer()).toString("base64");
  const overview = await importPreview({ format: "xlsx", content });
  assert.equal(overview.sheets.length, 2);
  assert.equal(overview.table, null);
  const preview = await importPreview({
    format: "xlsx",
    content,
    sheetId: String(second.id),
  });
  assert.equal(preview.table.rows[0].values[0], "b@example.com");
});
