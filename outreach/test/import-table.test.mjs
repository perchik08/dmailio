import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

async function reader() {
  const loaded = await import("../import-table.mjs").catch(() => null);
  assert.ok(loaded, "import-table.mjs should expose the table readers");
  return loaded;
}

async function workbookBuffer(build) {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("table reader keeps CSV columns by position and source row numbers", async () => {
  const { parseCsvTable } = await reader();
  const table = parseCsvTable(
    '\uFEFFПочта,Письмо 1,Письмо 1,Имя\r\n\r\nfirst@example.com,"первая строка\nпродолжение",вторая,Иван\r\n\r\ninvalid,x,y,Пётр\r\n',
  );

  assert.equal(table.format, "csv");
  assert.deepEqual(
    table.columns.map(({ id, position, header }) => ({
      id,
      position,
      header,
    })),
    [
      { id: "column-0", position: 0, header: "Почта" },
      { id: "column-1", position: 1, header: "Письмо 1" },
      { id: "column-2", position: 2, header: "Письмо 1" },
      { id: "column-3", position: 3, header: "Имя" },
    ],
  );
  assert.deepEqual(table.columns[1].samples, [
    "первая строка\nпродолжение",
    "x",
  ]);
  assert.deepEqual(table.columns[2].samples, ["вторая", "y"]);
  assert.deepEqual(
    table.rows.map(({ sourceRow }) => sourceRow),
    [3, 6],
  );
  assert.equal(table.rows[0].values[1], "первая строка\nпродолжение");
});

test("table reader enforces the 10 MB and 10,000-contact CSV limits", async () => {
  const { parseCsvTable } = await reader();
  assert.throws(() => parseCsvTable("x".repeat(10_000_001)), /10 МБ/);

  const oversizedRows =
    "Email\n" +
    Array.from(
      { length: 10_001 },
      (_, index) => `user${index}@example.com`,
    ).join("\n");
  assert.throws(() => parseCsvTable(oversizedRows), /10 000/);
});

test("empty CSV uses direct recovery guidance", async () => {
  const { parseCsvTable } = await reader();
  assert.throws(
    () => parseCsvTable(""),
    /Лист пустой.*Добавьте их|загрузите снова/,
  );
});

test("CSV header without any contact rows gives a distinct empty-list message", async () => {
  const { parseCsvTable } = await reader();
  assert.throws(
    () => parseCsvTable("Email,Имя\n"),
    /На листе нет строк с контактами/,
  );
});

test("table reader bounds column count before building a huge mapping view", async () => {
  const { parseCsvTable } = await reader();
  const headers = Array.from({ length: 201 }, (_, index) => `c${index}`).join(
    ",",
  );
  assert.throws(
    () => parseCsvTable(`${headers}\n${Array(201).fill("x").join(",")}`),
    /не больше 200 колонок/,
  );
});

test("XLSX reader lists sheets and preserves visible cell values and duplicate headers", async () => {
  const { listXlsxSheets, parseXlsxSheet } = await reader();
  const buffer = await workbookBuffer((workbook) => {
    workbook
      .addWorksheet("Контакты")
      .addRow(["Почта", "Письмо 1", "Письмо 1", "Код", "Дата", "Формула"]);
    const row = workbook
      .getWorksheet("Контакты")
      .addRow([
        "hello@example.com",
        "Добрый день",
        "Повторное письмо",
        123,
        new Date("2026-09-28T00:00:00Z"),
        { formula: "1+1", result: 2 },
      ]);
    row.getCell(4).numFmt = "000000";
    row.getCell(5).numFmt = "dd.mm.yyyy";
    workbook.addWorksheet("Пустой лист");
  });
  const sheets = await listXlsxSheets(buffer);

  assert.deepEqual(
    sheets.map(({ id, name }) => ({ id, name })),
    [
      { id: "1", name: "Контакты" },
      { id: "2", name: "Пустой лист" },
    ],
  );
  const table = await parseXlsxSheet(buffer, sheets[0].id);
  assert.deepEqual(
    table.columns.map((column) => column.header),
    ["Почта", "Письмо 1", "Письмо 1", "Код", "Дата", "Формула"],
  );
  assert.equal(table.columns[2].id, "column-2");
  assert.equal(table.rows[0].values[3], "000123");
  assert.equal(table.rows[0].values[4], "28.09.2026");
  assert.equal(table.rows[0].values[5], "2");
});

test("XLSX reader does not calculate formulas without saved results", async () => {
  const { parseXlsxSheet } = await reader();
  const buffer = await workbookBuffer((workbook) => {
    const sheet = workbook.addWorksheet("Лист");
    sheet.addRow(["Email", "Формула"]);
    sheet.addRow(["hello@example.com", { formula: "1+1" }]);
  });
  const table = await parseXlsxSheet(buffer, "1");

  assert.equal(table.rows[0].values[1], "");
});

test("XLSX reader reports an empty sheet and rejects malformed workbooks", async () => {
  const { parseXlsxSheet } = await reader();
  const buffer = await workbookBuffer((workbook) => {
    workbook.addWorksheet("Пустой лист");
  });

  await assert.rejects(parseXlsxSheet(buffer, "1"), /Лист пустой/);
  await assert.rejects(parseXlsxSheet(Buffer.from("not an xlsx"), "1"));
  const headersOnly = await workbookBuffer((workbook) => {
    workbook.addWorksheet("Заголовки").addRow(["Email", "Имя"]);
  });
  await assert.rejects(
    parseXlsxSheet(headersOnly, "1"),
    /На листе нет строк с контактами/,
  );
});
