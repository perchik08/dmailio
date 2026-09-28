import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parseCsvTable, parseXlsxSheet } from "../import-table.mjs";

async function importer() {
  const loaded = await import("../import.mjs").catch(() => null);
  assert.ok(loaded, "import.mjs should expose mapping and preview functions");
  return loaded;
}

test("column suggestions recognize English/Russian headers and repeated email drafts", async () => {
  const { suggestColumnMappings } = await importer();
  const mappings = suggestColumnMappings([
    { id: "a", header: "E-mail" },
    { id: "b", header: "Компания" },
    { id: "c", header: "Имя" },
    { id: "d", header: "Письмо 1" },
    { id: "e", header: "Письмо 1" },
  ]);
  assert.deepEqual(mappings, [
    { columnId: "a", target: "email" },
    { columnId: "b", target: "company" },
    { columnId: "c", target: "first_name" },
    { columnId: "d", target: { kind: "sequence_step", step: 1 } },
    { columnId: "e", target: { kind: "sequence_step", step: 2 } },
  ]);
});

test("standard person and organization fields include full name without splitting", async () => {
  const { suggestColumnMappings } = await importer();
  assert.deepEqual(
    suggestColumnMappings([
      { id: "a", header: "Контактное лицо" },
      { id: "b", header: "Отчество" },
      { id: "c", header: "Отдел" },
      { id: "d", header: "Страна" },
    ]),
    [
      { columnId: "a", target: "full_name" },
      { columnId: "b", target: "middle_name" },
      { columnId: "c", target: "department" },
      { columnId: "d", target: "country" },
    ],
  );
});

test("preview requires exactly one email, rejects conflicting fields and validates custom variables", async () => {
  const { previewImport } = await importer();
  const table = parseCsvTable(
    "Email,Имя,Имя,Тема\na@example.com,Иван,И.,Вопрос",
  );
  assert.throws(() => previewImport(table, []), /один.*Email/i);
  assert.throws(
    () =>
      previewImport(table, [
        { columnId: "column-0", target: "email" },
        { columnId: "column-1", target: "first_name" },
        { columnId: "column-2", target: "first_name" },
      ]),
    /дважды|повтор/i,
  );
  assert.throws(
    () =>
      previewImport(table, [
        { columnId: "column-0", target: "email" },
        { columnId: "column-1", target: "custom", variableName: "constructor" },
      ]),
    /переменн/i,
  );
  assert.throws(
    () =>
      previewImport(table, [
        { columnId: "column-0", target: "email" },
        { columnId: "column-1", target: "custom", variableName: "Имя" },
      ]),
    /переменн/i,
  );
});

test("preview maps standard and custom fields, subject, sequence steps and preserves all source variables", async () => {
  const { previewImport } = await importer();
  const table = parseCsvTable(
    "Email,Имя,Направление,Тема,Письмо 1,Письмо 2\nA@example.com,Иван,ERP,Встреча,Привет {{Имя}},Пинг",
  );
  const mappings = [
    { columnId: "column-0", target: "email" },
    { columnId: "column-1", target: "first_name" },
    { columnId: "column-2", target: "custom", variableName: "Направление" },
    { columnId: "column-3", target: "sequence_subject" },
    { columnId: "column-4", target: { kind: "sequence_step", step: 1 } },
    { columnId: "column-5", target: { kind: "sequence_step", step: 2 } },
  ];
  const preview = previewImport(table, mappings);
  assert.equal(preview.importable, 1);
  assert.equal(preview.contacts[0].email, "a@example.com");
  assert.equal(preview.contacts[0].fields["Имя"], "Иван");
  assert.equal(preview.contacts[0].fields["Направление"], "ERP");
  assert.equal(preview.contacts[0].fields.email, "a@example.com");
  assert.deepEqual(
    preview.steps.map(({ subject, body }) => ({ subject, body })),
    [
      { subject: "{{Тема цепочки}}", body: "{{Письмо 1}}" },
      { subject: "", body: "{{Письмо 2}}" },
    ],
  );
  assert.deepEqual(preview.variables.sort(), [
    "Email",
    "Имя",
    "Направление",
    "Письмо 1",
    "Письмо 2",
    "Тема цепочки",
  ]);
});

test("preview reports invalid, blank and duplicate rows with source row and reasons", async () => {
  const { previewImport } = await importer();
  const table = parseCsvTable(
    "Email,Имя\nwrong,А\nA@example.com,Б\na@example.com,В\n,Г",
  );
  const preview = previewImport(
    table,
    [
      { columnId: "column-0", target: "email" },
      { columnId: "column-1", target: "first_name" },
    ],
    { existingEmails: new Set(["used@example.com"]) },
  );
  assert.equal(preview.importable, 1);
  assert.equal(preview.errorCount, 2);
  assert.deepEqual(
    preview.errors.map(({ sourceRow }) => sourceRow),
    [2, 5],
  );
  assert.match(preview.errors[0].reason, /email/i);
  assert.equal(preview.skipped[0].sourceRow, 4);
  assert.match(preview.skipped[0].reason, /дубликат/i);
  assert.deepEqual(
    preview.skipped.map(({ sourceRow }) => sourceRow),
    [4],
  );
});

test("preview skips existing records by default and can explicitly keep them", async () => {
  const { previewImport } = await importer();
  const table = parseCsvTable("Email\nused@example.com");
  const mappings = [{ columnId: "column-0", target: "email" }];
  assert.equal(
    previewImport(table, mappings, { existingEmails: ["used@example.com"] })
      .importable,
    0,
  );
  assert.equal(
    previewImport(table, mappings, {
      existingEmails: ["used@example.com"],
      skipExisting: false,
    }).importable,
    1,
  );
  assert.equal(
    previewImport(table, mappings, {
      campaignEmails: ["used@example.com"],
      skipExisting: false,
    }).importable,
    0,
  );
});

test("preview limits sequence steps to 20 and requires mapped values", async () => {
  const { previewImport } = await importer();
  const table = parseCsvTable("Email,Текст\na@example.com,");
  assert.throws(
    () =>
      previewImport(table, [
        { columnId: "column-0", target: "email" },
        { columnId: "column-1", target: { kind: "sequence_step", step: 21 } },
      ]),
    /1–20/,
  );
  const preview = previewImport(table, [
    { columnId: "column-0", target: "email" },
    { columnId: "column-1", target: { kind: "sequence_step", step: 1 } },
  ]);
  assert.equal(preview.errorCount, 1);
  assert.match(preview.errors[0].reason, /письмо|пуст/i);
});

test("Trigga-style duplicate message headers yield equivalent CSV and XLSX mappings", async () => {
  const { previewImport, suggestColumnMappings } = await importer();
  const headers = [
    "Направление",
    "Компания",
    "Почта",
    "Тема",
    "Письмо 1",
    "Письмо 1",
  ];
  const csv = parseCsvTable(
    `${headers.join(",")}\nERP,Acme,lead@example.com,Встреча,Первое,Второе`,
  );
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Лиды");
  sheet.addRow(headers);
  sheet.addRow([
    "ERP",
    "Acme",
    "lead@example.com",
    "Встреча",
    "Первое",
    "Второе",
  ]);
  const xlsx = await parseXlsxSheet(
    Buffer.from(await workbook.xlsx.writeBuffer()),
    "1",
  );
  const mappings = suggestColumnMappings(csv.columns);
  const csvPreview = previewImport(csv, mappings);
  const xlsxPreview = previewImport(xlsx, mappings);
  assert.deepEqual(xlsxPreview.contacts, csvPreview.contacts);
  assert.deepEqual(xlsxPreview.steps, csvPreview.steps);
  assert.equal(csvPreview.contacts[0].fields["Направление"], "ERP");
  assert.equal(csvPreview.contacts[0].fields["Письмо 2"], "Второе");
});
