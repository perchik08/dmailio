import {
  invalid,
  requiredString,
  pagination,
  identifier,
} from "./contracts.mjs";
import { compileSource } from "./render.mjs";
import { builderHTML, emptyBuilder } from "./builder.mjs";
export function letterInput(value) {
  const editorMode = value.editorMode || "html";
  if (!["html", "markdown", "builder"].includes(editorMode))
    throw invalid("Выберите HTML или Markdown");
  const source =
    value.source ||
    (editorMode === "builder" ? JSON.stringify(emptyBuilder()) : "");
  if (typeof source !== "string" || source.length > 220000)
    throw invalid("Исходник письма: до 220 000 символов");
  const subject = String(value.subject ?? "");
  if (subject.length > 998 || /[\r\n]/.test(subject))
    throw invalid("Проверьте тему письма");
  const sources = {};
  for (const mode of ["html", "markdown", "builder"]) {
    const text = value.sources?.[mode] ?? "";
    if (typeof text !== "string" || text.length > 220000)
      throw invalid("Проверьте исходники редакторов");
    sources[mode] = text;
  }
  sources[editorMode] = source;
  return {
    title: requiredString(value.title, "Название письма", 200),
    subject,
    preheader: String(value.preheader ?? "").slice(0, 500),
    editorMode,
    source,
    sources,
    renderedHtml: compileSource(
      editorMode === "builder" ? builderHTML(source) : source,
      editorMode === "builder" ? "html" : editorMode,
    ),
    archived: value.archived === true,
  };
}
export class Letters {
  constructor(repository) {
    this.repository = repository;
  }
  map(row) {
    return {
      id: row.id,
      ...row.data,
      archived: row.archived,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.run_count !== undefined
        ? { runCount: Number(row.run_count) }
        : {}),
    };
  }
  async page(params) {
    const page = pagination(params, ["search", "mode", "archived"]);
    const values = [],
      where = [];
    if (params.get("search")) {
      values.push(
        "%" +
          params
            .get("search")
            .replace(/[\\%_]/g, "\\$&")
            .slice(0, 200) +
          "%",
      );
      where.push(
        `(data->>'title' ILIKE $${values.length} OR data->>'subject' ILIKE $${values.length})`,
      );
    }
    if (params.get("mode")) {
      if (!["html", "markdown", "builder"].includes(params.get("mode")))
        throw invalid("Неизвестный редактор");
      values.push(params.get("mode"));
      where.push(`data->>'editorMode'=$${values.length}`);
    }
    if (params.get("archived") !== "all") {
      values.push(params.get("archived") === "true");
      where.push(`archived=$${values.length}`);
    }
    const condition = where.length ? " WHERE " + where.join(" AND ") : "";
    const total = Number(
      (
        await this.repository.pool.query(
          "SELECT count(*) n FROM marketing.documents" + condition,
          values,
        )
      ).rows[0].n,
    );
    const rows = (
      await this.repository.pool.query(
        `SELECT d.*, (SELECT count(*) FROM marketing.runs r WHERE r.document_id=d.id) run_count FROM marketing.documents d${condition} ORDER BY updated_at DESC,id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, page.perPage, (page.page - 1) * page.perPage],
      )
    ).rows;
    return { ...page, total, items: rows.map((row) => this.map(row)) };
  }
  async get(id) {
    return this.map(await this.repository.document(identifier(id)));
  }
  async create(value) {
    return this.map(await this.repository.createDocument(letterInput(value)));
  }
  async update(id, value) {
    const current = await this.get(id);
    return this.map(
      await this.repository.updateDocument(
        id,
        value.expectedVersion,
        letterInput({ ...current, ...value }),
      ),
    );
  }
  async copy(id, value = {}) {
    const current = await this.get(id);
    return this.create({
      ...current,
      ...value,
      title: value.title || `${current.title.slice(0, 190)} — копия`,
      archived: false,
    });
  }
  async versions(id) {
    await this.get(id);
    return this.repository.versions(id);
  }
}
