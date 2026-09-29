import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import SSF from "ssf";

export const MAX_IMPORT_BYTES = 25_000_000;
export const MAX_IMPORT_REQUEST_BYTES = 36_000_000;
export const MAX_IMPORT_CONTACTS = 10_000;
export const MAX_IMPORT_COLUMNS = 200;
const MAX_CSV_PHYSICAL_LINES = 100_000;
const MAX_CELL_SIZE = 200_000;

function requireFileSize(size) {
  if (size > MAX_IMPORT_BYTES)
    throw new Error("Файл должен быть не больше 25 МБ");
}

function csvDelimiter(text) {
  const firstRecord = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      quoted = !quoted;
    } else if (!quoted && (char === "\n" || char === "\r")) {
      break;
    } else if (!quoted) {
      firstRecord.push(char);
    }
  }
  const counts = [",", ";", "\t"].map((delimiter) => ({
    delimiter,
    count: firstRecord.filter((char) => char === delimiter).length,
  }));
  return counts.sort((a, b) => b.count - a.count)[0].delimiter;
}

function recordStartLine(record, endLine) {
  const embeddedLines = (record.join("").match(/\r\n|\r|\n/g) || []).length;
  return endLine - embeddedLines;
}

function columnSamples(rows, position) {
  const samples = [];
  for (const row of rows) {
    const value = row.values[position] || "";
    if (value.trim() && !samples.includes(value)) samples.push(value);
    if (samples.length === 3) break;
  }
  return samples;
}

export function parseCsvTable(text) {
  if (typeof text !== "string")
    throw new Error("CSV-файл прочитать не удалось");
  requireFileSize(Buffer.byteLength(text, "utf8"));
  const physicalLines = (text.match(/\r\n|\r|\n/g) || []).length + 1;
  if (physicalLines > MAX_CSV_PHYSICAL_LINES)
    throw new Error("В CSV слишком много строк для безопасной обработки");

  let records;
  try {
    records = parse(text, {
      bom: true,
      delimiter: csvDelimiter(text),
      info: true,
      max_record_size: MAX_CELL_SIZE,
      relax_column_count: true,
      skip_empty_lines: false,
    });
  } catch {
    throw new Error(
      "Не удалось прочитать CSV. Проверьте кавычки и разделители.",
    );
  }

  if (!records.length)
    throw new Error(
      "Лист пустой — в файле нет заголовков и данных. Добавьте их или выберите другой файл и загрузите снова.",
    );
  const headerRecord = records[0].record.map((value) =>
    String(value ?? "").trim(),
  );
  if (!headerRecord.length || !headerRecord.some(Boolean))
    throw new Error(
      "В CSV нет названий столбцов. Добавьте строку заголовков и загрузите файл снова.",
    );
  if (headerRecord.length > MAX_IMPORT_COLUMNS)
    throw new Error("В таблице может быть не больше 200 колонок");

  const rows = [];
  for (const { record, info } of records.slice(1)) {
    const values = headerRecord.map((_, index) => String(record[index] ?? ""));
    if (
      record.length > headerRecord.length &&
      record.slice(headerRecord.length).some((v) => String(v ?? "").trim())
    )
      throw new Error(
        `В строке ${recordStartLine(record, info.lines)} больше значений, чем заголовков`,
      );
    if (!values.some((value) => value.trim())) continue;
    rows.push({ sourceRow: recordStartLine(record, info.lines), values });
    if (rows.length > MAX_IMPORT_CONTACTS)
      throw new Error("В одном импорте может быть не больше 10 000 контактов");
  }

  if (!rows.length)
    throw new Error(
      "На листе нет строк с контактами. Добавьте данные или выберите другой лист.",
    );

  const columns = headerRecord.map((header, position) => ({
    id: `column-${position}`,
    position,
    header,
    samples: columnSamples(rows, position),
  }));
  return {
    format: "csv",
    sheetId: "csv",
    sheetName: "CSV",
    columns,
    rows,
  };
}

function workbookFrom(buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array))
    throw new Error("Файл Excel прочитать не удалось");
  requireFileSize(buffer.byteLength);
  if (!buffer.byteLength) throw new Error("Файл Excel пустой");
  return new ExcelJS.Workbook().xlsx.load(buffer);
}

export async function listXlsxSheets(buffer) {
  let workbook;
  try {
    workbook = await workbookFrom(buffer);
  } catch (error) {
    throw new Error(error.message || "Не удалось открыть файл .xlsx");
  }
  const sheets = workbook.worksheets.map((sheet) => ({
    id: String(sheet.id),
    name: sheet.name,
  }));
  if (!sheets.length) throw new Error("Книга Excel пустая: в ней нет листов");
  return sheets;
}

function excelSerial(date, date1904) {
  const epochOffset = date1904 ? 24_107 : 25_569;
  return date.getTime() / 86_400_000 + epochOffset;
}

function displayValue(cell, date1904) {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object" && !(value instanceof Date)) {
    if (
      Object.hasOwn(value, "formula") ||
      Object.hasOwn(value, "sharedFormula")
    ) {
      if (
        !Object.hasOwn(value, "result") ||
        value.result === null ||
        value.result === undefined
      )
        return "";
      const result = value.result;
      if (result instanceof Date)
        return formatNumber(
          excelSerial(result, date1904),
          cell.numFmt,
          date1904,
        );
      if (typeof result === "number")
        return formatNumber(result, cell.numFmt, date1904);
      return String(result);
    }
    if (Array.isArray(value.richText))
      return value.richText.map((part) => part.text || "").join("");
    if (typeof value.text === "string") return value.text;
  }
  if (value instanceof Date)
    return formatNumber(
      excelSerial(value, date1904),
      cell.numFmt || "yyyy-mm-dd",
      date1904,
    );
  if (typeof value === "number")
    return formatNumber(value, cell.numFmt, date1904);
  return String(value);
}

function formatNumber(value, format, date1904 = false) {
  if (!format || format === "General") return String(value);
  const dateFormat = format
    .toLowerCase()
    .match(/^(d{1,4})([.\-/])(m{1,4})\2(y{2,4})$/);
  if (dateFormat) {
    const date = new Date(
      Math.round((value - (date1904 ? 24_107 : 25_569)) * 86_400_000),
    );
    const [dayToken, separator, monthToken, yearToken] = dateFormat.slice(1);
    const day = String(date.getUTCDate()).padStart(
      dayToken.length > 1 ? 2 : 1,
      "0",
    );
    const month = String(date.getUTCMonth() + 1).padStart(
      monthToken.length > 1 ? 2 : 1,
      "0",
    );
    const year = String(date.getUTCFullYear());
    return [day, month, yearToken.length === 2 ? year.slice(-2) : year].join(
      separator,
    );
  }
  try {
    return String(SSF.format(format, value));
  } catch {
    return String(value);
  }
}

export async function parseXlsxSheet(buffer, sheetId) {
  let workbook;
  try {
    workbook = await workbookFrom(buffer);
  } catch (error) {
    throw new Error(error.message || "Не удалось открыть файл .xlsx");
  }
  const id = Number(sheetId);
  const sheet = Number.isInteger(id) ? workbook.getWorksheet(id) : undefined;
  if (!sheet) throw new Error("Выберите лист Excel для импорта");

  const nonEmptyRows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    nonEmptyRows.push(row);
  });
  if (!nonEmptyRows.length)
    throw new Error(
      "Лист пустой — в нём нет данных. Выберите другой лист или добавьте данные в таблицу и загрузите файл снова.",
    );

  const headerRow = nonEmptyRows[0];
  const width = headerRow.cellCount;
  if (width > MAX_IMPORT_COLUMNS)
    throw new Error("В таблице может быть не больше 200 колонок");
  const headers = Array.from({ length: width }, (_, index) =>
    displayValue(headerRow.getCell(index + 1), workbook.properties.date1904),
  ).map((value) => value.trim());
  if (!headers.some(Boolean))
    throw new Error("В листе Excel нет названий столбцов");

  const rows = [];
  for (const row of nonEmptyRows.slice(1)) {
    const values = Array.from({ length: width }, (_, index) =>
      displayValue(row.getCell(index + 1), workbook.properties.date1904),
    );
    if (!values.some((value) => value.trim())) continue;
    rows.push({ sourceRow: row.number, values });
    if (rows.length > MAX_IMPORT_CONTACTS)
      throw new Error("В одном импорте может быть не больше 10 000 контактов");
  }

  if (!rows.length)
    throw new Error(
      "На листе нет строк с контактами. Добавьте данные или выберите другой лист.",
    );

  const columns = headers.map((header, position) => ({
    id: `column-${position}`,
    position,
    header,
    samples: columnSamples(rows, position),
  }));
  return {
    format: "xlsx",
    sheetId: String(sheet.id),
    sheetName: sheet.name,
    columns,
    rows,
  };
}
