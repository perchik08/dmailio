import { createHash } from "node:crypto";
import {
  parseCsvTable,
  listXlsxSheets,
  parseXlsxSheet,
  MAX_IMPORT_BYTES,
} from "../import-table.mjs";
import { suggestColumnMappings } from "../import.mjs";
import { contactInput, normalizeEmail, exportCell } from "./contacts.mjs";
import {
  identifier,
  invalid,
  requiredString,
  MarketingError,
} from "./contracts.mjs";

const aliases = {
  first_name: "firstName",
  last_name: "lastName",
  middle_name: "middleName",
  full_name: "name",
  position: "jobTitle",
};
const targets = new Set([
  "email",
  "name",
  "firstName",
  "lastName",
  "middleName",
  "company",
  "jobTitle",
  "phone",
  "website",
  "department",
  "industry",
  "region",
  "country",
]);
export async function importPreview(source) {
  if (
    !source ||
    typeof source.content !== "string" ||
    !["csv", "xlsx"].includes(source.format)
  )
    throw invalid("Выберите CSV или Excel (.xlsx)");
  const bytes =
    source.format === "csv"
      ? Buffer.byteLength(source.content)
      : Buffer.byteLength(source.content, "base64");
  if (bytes > MAX_IMPORT_BYTES)
    throw invalid("Файл должен быть не больше 25 МБ");
  try {
    const buffer =
      source.format === "xlsx" ? Buffer.from(source.content, "base64") : null;
    const sheets = buffer ? await listXlsxSheets(buffer) : [];
    const table = buffer
      ? source.sheetId
        ? await parseXlsxSheet(buffer, source.sheetId)
        : null
      : parseCsvTable(source.content);
    const mappings = table
      ? suggestColumnMappings(table.columns).map((row) => ({
          ...row,
          target:
            aliases[row.target] ||
            (targets.has(row.target) || row.target === "custom"
              ? row.target
              : "skip"),
        }))
      : [];
    return { sheets, table, mappings };
  } catch (error) {
    if (error instanceof MarketingError) throw error;
    throw invalid(error.message);
  }
}
export function mappedRows(table, mappings) {
  if (!Array.isArray(mappings) || mappings.length > 200)
    throw invalid("Проверьте сопоставление столбцов");
  const used = new Set(),
    columns = new Set(),
    mapped = [];
  for (const item of mappings) {
    const column = table.columns.find((column) => column.id === item.columnId);
    if (!column || columns.has(column.id))
      throw invalid("Столбец сопоставлен несколько раз или не найден");
    columns.add(column.id);
    if (item.target === "skip") continue;
    const target =
      item.target === "custom"
        ? String(item.variableName || "").trim()
        : item.target;
    if (item.target !== "custom" && !targets.has(target))
      throw invalid("Неизвестный тип переменной");
    if (used.has(target))
      throw invalid("Два столбца не могут задавать одну переменную");
    used.add(target);
    contactInput({
      email: "check@example.invalid",
      source: "Mapping validation",
      fields: { [target]: "" },
    });
    mapped.push({ ...column, target });
  }
  if (!used.has("email")) throw invalid("Выберите столбец Email");
  const rows = [],
    rejected = [],
    skipped = [],
    seen = new Set();
  for (const row of table.rows) {
    const values = Object.fromEntries(
      mapped.map((column) => [
        column.target,
        String(row.values[column.position] ?? "").trim(),
      ]),
    );
    try {
      const email = normalizeEmail(values.email);
      if (seen.has(email)) {
        skipped.push({
          row: row.sourceRow,
          email,
          status: "skipped",
          reason: "Повтор email внутри файла",
        });
        continue;
      }
      seen.add(email);
      const { email: ignored, name = "", ...fields } = values;
      contactInput({ email, source: "Preview", name, fields });
      rows.push({
        row: row.sourceRow,
        email,
        name,
        nameMapped: used.has("name"),
        fields,
      });
    } catch (error) {
      rejected.push({
        row: row.sourceRow,
        email: values.email || "",
        status: "rejected",
        reason: error.message,
      });
    }
  }
  return { rows, rejected, skipped };
}
export class Imports {
  constructor(contacts, lists, repository) {
    Object.assign(this, { contacts, lists, repository });
    this.active = new Set();
  }
  async prepare(data) {
    const source = requiredString(data.source, "Источник базы", 1000);
    if (!["skip", "update"].includes(data.duplicates))
      throw invalid("Выберите правило дубликатов");
    if (
      !Array.isArray(data.listIds) ||
      !data.listIds.length ||
      data.listIds.length > 100
    )
      throw invalid("Выберите от 1 до 100 списков");
    const listIds = [...new Set(data.listIds.map(identifier))];
    for (const id of listIds)
      if ((await this.lists.get(id)).archived)
        throw invalid("Нельзя импортировать в архивный список");
    const preview = await importPreview(data.file);
    if (!preview.table) throw invalid("Выберите лист Excel");
    const mapped = mappedRows(preview.table, data.mappings);
    return {
      ...mapped,
      source,
      listIds,
      duplicates: data.duplicates,
      overwriteEmpty: data.overwriteEmpty === true,
      consentConfirmed: data.consentConfirmed === true,
    };
  }
  async start(data) {
    if (
      typeof data.operationId !== "string" ||
      !/^[\w-]{8,120}$/.test(data.operationId)
    )
      throw invalid("Требуется идентификатор операции");
    const payload = await this.prepare(data);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    await this.repository.pool.query(
      "INSERT INTO marketing.import_jobs(id,fingerprint,payload,report) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [
        data.operationId,
        fingerprint,
        JSON.stringify(payload),
        JSON.stringify([...payload.rejected, ...payload.skipped]),
      ],
    );
    const job = await this.get(data.operationId, false);
    if (job.fingerprint !== fingerprint)
      throw new MarketingError(
        "OPERATION_CONFLICT",
        "Операция уже использована для другого импорта",
        409,
      );
    this.launch(data.operationId);
    return this.result(job);
  }
  launch(id) {
    if (this.active.has(id)) return;
    this.active.add(id);
    this.execute(id)
      .catch(() => {})
      .finally(() => this.active.delete(id));
  }
  async get(id, resume = true) {
    if (!/^[\w-]{8,120}$/.test(id))
      throw invalid("Некорректный идентификатор операции");
    const { rows } = await this.repository.pool.query(
      "SELECT * FROM marketing.import_jobs WHERE id=$1",
      [id],
    );
    if (!rows.length)
      throw new MarketingError("NOT_FOUND", "Импорт не найден", 404);
    if (resume && ["pending", "running"].includes(rows[0].state))
      this.launch(id);
    return rows[0];
  }
  result(job) {
    const counts = { added: 0, updated: 0, skipped: 0, rejected: 0 };
    for (const row of job.report) counts[row.status]++;
    return {
      id: job.id,
      state: job.state,
      processed:
        job.cursor + job.payload.rejected.length + job.payload.skipped.length,
      total:
        job.payload.rows.length +
        job.payload.rejected.length +
        job.payload.skipped.length,
      ...counts,
      report: job.report,
      error: job.error,
    };
  }
  async execute(id) {
    const client = await this.repository.pool.connect();
    let locked = false;
    try {
      locked = (
        await client.query("SELECT pg_try_advisory_lock(73193302) AS locked")
      ).rows[0].locked;
      if (!locked) return;
      let job = await this.get(id, false);
      if (job.state === "completed" || job.state === "paused") return;
      await client.query(
        "UPDATE marketing.import_jobs SET state='running',error='' WHERE id=$1",
        [id],
      );
      const p = job.payload;
      for (let index = job.cursor; index < p.rows.length; index++) {
        const row = p.rows[index];
        const key = `${id}:${index}`;
        let existing = await this.contacts.findEmail(row.email);
        let status;
        if (existing?.importKey === key) status = "added";
        else if (existing && p.duplicates === "skip") status = "skipped";
        else if (existing) {
          const fields = { ...existing.fields };
          for (const [field, value] of Object.entries(row.fields))
            if (value || p.overwriteEmpty) fields[field] = value;
          await this.contacts.update(existing.id, {
            name: row.nameMapped
              ? row.name || (!p.overwriteEmpty ? existing.name : "")
              : existing.name,
            fields,
          });
          status = "updated";
        } else {
          try {
            existing = await this.contacts.create(
              {
                email: row.email,
                name: row.name,
                fields: row.fields,
                source: p.source,
                listIds: p.listIds,
                consentConfirmed: p.consentConfirmed,
              },
              key,
            );
            status = "added";
          } catch (error) {
            if (error.code !== "CONFLICT") throw error;
            existing = await this.contacts.findEmail(row.email);
            if (!existing) throw error;
            status = existing.importKey === key ? "added" : "skipped";
          }
        }
        // Adding membership with no subscription-status override preserves existing opt-outs.
        if (status === "updated")
          for (const list of p.listIds)
            if (!existing.lists.some((item) => item.id === list))
              await this.lists.members(list, [existing.id], "add");
        job.report.push({
          row: row.row,
          email: row.email,
          status,
          reason: status === "skipped" ? "Контакт уже существует" : "",
        });
        await client.query(
          "UPDATE marketing.import_jobs SET cursor=$2,report=$3,updated_at=now() WHERE id=$1",
          [id, index + 1, JSON.stringify(job.report)],
        );
      }
      await client.query(
        "UPDATE marketing.import_jobs SET state='completed',updated_at=now() WHERE id=$1",
        [id],
      );
    } catch (error) {
      await client.query(
        "UPDATE marketing.import_jobs SET state='paused',error=$2,updated_at=now() WHERE id=$1",
        [
          id,
          error instanceof MarketingError
            ? error.message
            : "Импорт приостановлен: сервис контактов временно недоступен",
        ],
      );
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(73193302)");
      client.release();
    }
  }
  async resume(id) {
    await this.get(id, false);
    await this.repository.pool.query(
      "UPDATE marketing.import_jobs SET state='pending',error='' WHERE id=$1 AND state='paused'",
      [id],
    );
    this.launch(id);
    return this.result(await this.get(id, false));
  }
  async report(id) {
    const job = await this.get(id, false);
    return Buffer.from(
      "\uFEFF" +
        [
          ["Строка", "Email", "Результат", "Причина"],
          ...job.report.map((row) => [
            row.row,
            row.email,
            row.status,
            row.reason,
          ]),
        ]
          .map((row) =>
            row
              .map((cell) => '"' + exportCell(cell).replaceAll('"', '""') + '"')
              .join(","),
          )
          .join("\r\n"),
    );
  }
}
