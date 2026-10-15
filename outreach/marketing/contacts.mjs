import { domainToASCII } from "node:url";
import ExcelJS from "exceljs";
import {
  invalid,
  pagination,
  requiredString,
  identifier,
} from "./contracts.mjs";

export function normalizeEmail(value) {
  const raw = requiredString(value, "Email", 254).toLowerCase();
  const parts = raw.split("@");
  const domain = domainToASCII(parts[1] || "");
  if (
    parts.length !== 2 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) ||
    parts[0].length > 64 ||
    !domain.includes(".") ||
    domain
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    domain.split(".").at(-1).length < 2 ||
    `${parts[0]}@${domain}`.length > 254 ||
    domain.includes("..") ||
    parts[0].startsWith(".") ||
    parts[0].endsWith(".") ||
    parts[0].includes("..")
  )
    throw invalid("Некорректный формат email", { email: "Проверьте адрес" });
  return `${parts[0]}@${domain}`;
}
export function tagsInput(value = []) {
  if (!Array.isArray(value) || value.length > 40)
    throw invalid("Не более 40 тегов");
  return [...new Set(value.map((tag) => requiredString(tag, "Тег", 60)))];
}
export function contactInput(value) {
  const fields = value.fields ?? {};
  if (
    !fields ||
    typeof fields !== "object" ||
    Array.isArray(fields) ||
    Object.keys(fields).length > 100
  )
    throw invalid("Проверьте поля контакта");
  for (const [key, field] of Object.entries(fields))
    if (
      !/^[\p{L}\p{N}_ -]{1,80}$/u.test(key) ||
      ["constructor", "prototype", "__proto__", "_dmailio"].includes(key) ||
      typeof field !== "string" ||
      field.length > 4000
    )
      throw invalid("Недопустимое поле контакта", {
        [key]: "Строка до 4000 символов",
      });
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    throw invalid("Проверьте разрешение отправки");
  if (
    value.listIds !== undefined &&
    (!Array.isArray(value.listIds) || value.listIds.length > 100)
  )
    throw invalid("Выберите не более 100 списков");
  return {
    email: normalizeEmail(value.email),
    name: String(value.name ?? "")
      .trim()
      .slice(0, 200),
    fields,
    tags: tagsInput(value.tags),
    source: requiredString(value.source, "Источник базы", 1000),
    enabled: value.enabled !== false,
    consentConfirmed: value.consentConfirmed === true,
    listIds: (value.listIds || []).map(identifier),
  };
}
const literal = (value) =>
  `E'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
const allowedFilters = [
  "search",
  "tag",
  "status",
  "listId",
  "sort",
  "direction",
  "addedFrom",
  "addedTo",
  "field",
  "fieldOp",
  "value",
];
export function contactQuery(params) {
  const page = pagination(params, allowedFilters);
  const upstream = new URLSearchParams({
    page: page.page,
    per_page: page.perPage,
  });
  const sort = params.get("sort") || "created_at";
  const direction = params.get("direction") || "desc";
  if (
    !["email", "name", "created_at", "updated_at"].includes(sort) ||
    !["asc", "desc"].includes(direction)
  )
    throw invalid("Неизвестный порядок сортировки");
  upstream.set("order_by", sort);
  upstream.set("order", direction);
  const expressions = [];
  const search = params.get("search");
  if (search) {
    if (search.length > 200) throw invalid("Поисковая строка слишком длинная");
    const escaped = search
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    expressions.push(
      `(subscribers.email ILIKE ${literal(`%${escaped}%`)} OR subscribers.name ILIKE ${literal(`%${escaped}%`)} OR subscribers.attribs::text ILIKE ${literal(`%${escaped}%`)})`,
    );
  }
  if (params.get("tag"))
    expressions.push(
      `(subscribers.attribs->'_dmailio'->'tags') @> ${literal(JSON.stringify([params.get("tag")]))}::jsonb`,
    );
  const status = params.get("status");
  const enabled =
    "COALESCE(subscribers.attribs->'_dmailio'->>'enabled','true') <> 'false'";
  const confirmed =
    "EXISTS (SELECT 1 FROM subscriber_lists sl JOIN lists ml ON ml.id=sl.list_id WHERE sl.subscriber_id=subscribers.id AND sl.status='confirmed' AND ml.status='active')";
  const active = `subscribers.status='enabled' AND (${enabled}) AND subscribers.attribs->'_dmailio'->>'consentConfirmed'='true' AND ${confirmed}`;
  const unsubscribed =
    "EXISTS (SELECT 1 FROM subscriber_lists sl WHERE sl.subscriber_id=subscribers.id AND sl.status='unsubscribed')";
  if (status === "blocked")
    expressions.push("subscribers.status='blocklisted'");
  else if (status === "disabled")
    expressions.push(`subscribers.status<>'blocklisted' AND NOT (${enabled})`);
  else if (status === "active") expressions.push(active);
  else if (status === "unsubscribed")
    expressions.push(
      `subscribers.status<>'blocklisted' AND (${enabled}) AND NOT COALESCE((${active}),false) AND ${unsubscribed}`,
    );
  else if (status === "unconfirmed")
    expressions.push(
      `subscribers.status<>'blocklisted' AND (${enabled}) AND NOT COALESCE((${active}),false) AND NOT (${unsubscribed})`,
    );
  else if (status && !["all", "unsubscribed", "unconfirmed"].includes(status))
    throw invalid("Неизвестный статус контакта");
  for (const [field, operator] of [
    ["addedFrom", ">="],
    ["addedTo", "<="],
  ])
    if (params.get(field)) {
      const rawDate = params.get(field);
      const date = new Date(rawDate);
      if (!Number.isFinite(date.getTime())) throw invalid("Некорректная дата");
      if (field === "addedTo" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate))
        date.setUTCHours(23, 59, 59, 999);
      expressions.push(
        `subscribers.created_at ${operator} ${literal(date.toISOString())}::timestamptz`,
      );
    }
  if (params.get("field")) {
    const field = params.get("field");
    if (!/^[\p{L}\p{N}_ -]{1,80}$/u.test(field))
      throw invalid("Некорректное поле фильтра");
    const access = `COALESCE(subscribers.attribs->>${literal(field)},'')`;
    const op = params.get("fieldOp") || "equals";
    if (op === "equals")
      expressions.push(`${access}=${literal(params.get("value") || "")}`);
    else if (op === "contains")
      expressions.push(
        `strpos(lower(${access}),lower(${literal(params.get("value") || "")})) > 0`,
      );
    else if (op === "empty") expressions.push(`${access}=''`);
    else if (op === "notEmpty") expressions.push(`${access}<>''`);
    else throw invalid("Неизвестный оператор фильтра");
  }
  if (expressions.length)
    upstream.set("query", expressions.map((expr) => `(${expr})`).join(" AND "));
  return { ...page, params: upstream };
}
export const exportCell = (value) =>
  /^[\s\uFEFF]*[=+@-]/.test(String(value ?? ""))
    ? "'" + String(value)
    : String(value ?? "");
export class Contacts {
  constructor(client, repository) {
    Object.assign(this, { client, repository });
  }
  async map(row) {
    await this.repository.link("contact", row.id, row.uuid);
    const fields = { ...(row.attribs || {}) };
    const meta = fields._dmailio || {};
    delete fields._dmailio;
    const lists = row.lists || [];
    for (const list of lists)
      await this.repository.link("list", list.id, list.uuid);
    const status =
      row.status === "blocklisted"
        ? "blocked"
        : meta.enabled === false
          ? "disabled"
          : lists.some(
                (list) =>
                  list.subscription_status === "confirmed" &&
                  list.status !== "archived",
              ) && meta.consentConfirmed === true
            ? "active"
            : lists.some((list) => list.subscription_status === "unsubscribed")
              ? "unsubscribed"
              : "unconfirmed";
    return {
      id: row.uuid,
      email: row.email,
      name: row.name,
      fields,
      tags: meta.tags || [],
      source: meta.source || "listmonk",
      enabled: meta.enabled !== false,
      consentConfirmed: meta.consentConfirmed === true,
      importKey: meta.importKey || null,
      status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lists: lists.map((list) => ({
        id: list.uuid,
        name: list.name,
        status: list.subscription_status,
        archived: list.status === "archived",
      })),
    };
  }
  async page(params) {
    const query = contactQuery(params);
    if (params.get("listId"))
      query.params.set(
        "list_id",
        await this.repository.externalId("list", params.get("listId")),
      );
    const result = await this.client.request(
      "GET",
      `/api/subscribers?${query.params}`,
    );
    return {
      items: await Promise.all(
        (result.results || []).map((row) => this.map(row)),
      ),
      total: result.total,
      page: query.page,
      perPage: query.perPage,
    };
  }
  async get(id) {
    return this.map(
      await this.client.request(
        "GET",
        `/api/subscribers/${await this.repository.externalId("contact", id)}`,
      ),
    );
  }
  async findEmail(email) {
    const query = new URLSearchParams({
      query: `subscribers.email=${literal(normalizeEmail(email))}`,
      per_page: "1",
    });
    const result = await this.client.request(
      "GET",
      `/api/subscribers?${query}`,
    );
    return result.results?.length ? this.map(result.results[0]) : null;
  }
  async create(value, importKey = null) {
    const data = contactInput(value);
    const lists = await Promise.all(
      data.listIds.map((id) => this.repository.externalId("list", id)),
    );
    return this.map(
      await this.client.request("POST", "/api/subscribers", {
        email: data.email,
        name: data.name,
        attribs: {
          ...data.fields,
          _dmailio: {
            tags: data.tags,
            source: data.source,
            enabled: data.enabled,
            consentConfirmed: data.consentConfirmed,
            importKey,
          },
        },
        status: "enabled",
        lists,
        preconfirm_subscriptions: data.consentConfirmed,
      }),
    );
  }
  async update(id, value) {
    const previous = await this.get(id);
    const data = contactInput({ ...previous, ...value });
    const external = await this.repository.externalId("contact", id);
    // PATCH without lists/status preserves blocklists and every subscription.
    await this.client.request("PATCH", `/api/subscribers/${external}`, {
      email: data.email,
      name: data.name,
      attribs: {
        ...data.fields,
        _dmailio: {
          tags: data.tags,
          source: data.source,
          enabled: data.enabled,
          consentConfirmed: previous.consentConfirmed,
          importKey: previous.importKey,
        },
      },
    });
    return this.get(id);
  }
  async all(params) {
    const rows = [];
    const copy = new URLSearchParams(params);
    copy.set("perPage", "100");
    for (let page = 1; ; page++) {
      copy.set("page", page);
      const batch = await this.page(copy);
      if (batch.total > 10000)
        throw invalid(
          "Не более 10 000 контактов за одну операцию. Уточните фильтр.",
        );
      rows.push(...batch.items);
      if (rows.length >= batch.total || !batch.items.length) return rows;
    }
  }
  async export(params, selectedIds, format) {
    if (!["csv", "xlsx"].includes(format))
      throw invalid("Выберите CSV или XLSX");
    if (
      selectedIds !== undefined &&
      (!Array.isArray(selectedIds) || selectedIds.length > 10000)
    )
      throw invalid("Выберите не более 10 000 контактов");
    let rows = await this.all(params);
    if (selectedIds) {
      const selected = new Set(selectedIds.map(identifier));
      rows = rows.filter((row) => selected.has(row.id));
    }
    const fields = [
      ...new Set(rows.flatMap((row) => Object.keys(row.fields))),
    ].sort();
    const columns = ["email", "name", "status", "source", "tags", ...fields];
    const values = rows.map((row) =>
      [
        row.email,
        row.name,
        row.status,
        row.source,
        row.tags.join(", "),
        ...fields.map((field) => row.fields[field]),
      ].map(exportCell),
    );
    if (format === "xlsx") {
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet("Контакты");
      sheet.addRow(columns);
      values.forEach((row) => sheet.addRow(row));
      return {
        buffer: Buffer.from(await book.xlsx.writeBuffer()),
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
    }
    const csv = [columns, ...values]
      .map((row) =>
        row
          .map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\r\n");
    return {
      buffer: Buffer.from("\uFEFF" + csv),
      type: "text/csv; charset=utf-8",
    };
  }
}
