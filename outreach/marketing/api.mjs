import { MarketingError, errorBody, unavailable } from "./contracts.mjs";
import { Contacts } from "./contacts.mjs";
import { Lists } from "./lists.mjs";
import { Imports, importPreview, mappedRows } from "./import.mjs";
import { Letters } from "./letters.mjs";

export class MarketingAPI {
  constructor({ repository, listmonk } = {}) {
    Object.assign(this, { repository, listmonk });
    if (repository && listmonk) {
      this.contacts = new Contacts(listmonk, repository);
      this.lists = new Lists(listmonk, repository, this.contacts);
      this.imports = new Imports(this.contacts, this.lists, repository);
      this.letters = new Letters(repository);
    }
  }
  async handle({ path, method, url, data, send, res }) {
    if (!path.startsWith("/api/marketing/")) return false;
    try {
      if (!this.repository || !this.listmonk) throw unavailable();
      if (path === "/api/marketing/status" && method === "GET") {
        await this.repository.health();
        await this.listmonk.request("GET", "/api/lists?minimal=true");
        send({
          available: true,
          cabinet: "current",
          massTransportConfigured: false,
        });
      } else if (path === "/api/marketing/letters" && method === "GET") {
        send(await this.letters.page(url.searchParams));
      } else if (path === "/api/marketing/letters" && method === "POST") {
        send(await this.letters.create(data), 201);
      } else if (
        /^\/api\/marketing\/letters\/[^/]+(?:\/(?:copy|versions))?$/.test(path)
      ) {
        const [id, action] = path
          .slice("/api/marketing/letters/".length)
          .split("/");
        if (action === "copy" && method === "POST")
          send(await this.letters.copy(id, data), 201);
        else if (action === "versions" && method === "GET")
          send(await this.letters.versions(id));
        else if (!action && method === "GET") send(await this.letters.get(id));
        else if (!action && method === "PUT")
          send(await this.letters.update(id, data));
        else
          throw new MarketingError(
            "METHOD_NOT_ALLOWED",
            "Действие не поддерживается",
            405,
          );
      } else if (
        path === "/api/marketing/imports/preview" &&
        method === "POST"
      ) {
        const preview = await importPreview(data.file || data);
        if (data.mappings && preview.table)
          preview.validation = mappedRows(preview.table, data.mappings);
        send(preview);
      } else if (path === "/api/marketing/imports" && method === "POST") {
        send(await this.imports.start(data), 202);
      } else if (
        /^\/api\/marketing\/imports\/[\w-]+(?:\/(?:report|resume))?$/.test(path)
      ) {
        const [id, action] = path
          .slice("/api/marketing/imports/".length)
          .split("/");
        if (action === "report" && method === "GET") {
          res.setHeader(
            "Content-Disposition",
            'attachment; filename="import-report.csv"',
          );
          send(await this.imports.report(id), 200, "text/csv; charset=utf-8");
        } else if (action === "resume" && method === "POST")
          send(await this.imports.resume(id));
        else if (!action && method === "GET")
          send(this.imports.result(await this.imports.get(id)));
        else
          throw new MarketingError(
            "METHOD_NOT_ALLOWED",
            "Действие не поддерживается",
            405,
          );
      } else if (path === "/api/marketing/contacts" && method === "GET") {
        send(await this.contacts.page(url.searchParams));
      } else if (path === "/api/marketing/contacts" && method === "POST") {
        send(await this.contacts.create(data), 201);
      } else if (
        path === "/api/marketing/contacts/export" &&
        method === "POST"
      ) {
        const exported = await this.contacts.export(
          new URLSearchParams(data.filter || {}),
          data.ids,
          data.format,
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="contacts.${data.format}"`,
        );
        send(exported.buffer, 200, exported.type);
      } else if (/^\/api\/marketing\/contacts\/[^/]+$/.test(path)) {
        const id = path.split("/").at(-1);
        if (method === "GET") send(await this.contacts.get(id));
        else if (method === "PUT") send(await this.contacts.update(id, data));
        else
          throw new MarketingError(
            "METHOD_NOT_ALLOWED",
            "Действие не поддерживается",
            405,
          );
      } else if (path === "/api/marketing/lists" && method === "GET") {
        send(await this.lists.page(url.searchParams));
      } else if (path === "/api/marketing/lists" && method === "POST") {
        send(await this.lists.create(data), 201);
      } else if (
        path === "/api/marketing/audience/preview" &&
        method === "POST"
      ) {
        send(await this.lists.audience(data.listIds));
      } else if (/^\/api\/marketing\/lists\/[^/]+(?:\/members)?$/.test(path)) {
        const [id, action] = path
          .slice("/api/marketing/lists/".length)
          .split("/");
        if (action === "members" && method === "GET")
          send(await this.lists.memberPage(id, url.searchParams));
        else if (action === "members" && method === "POST")
          send(await this.lists.members(id, data.ids, data.action));
        else if (!action && method === "GET") send(await this.lists.get(id));
        else if (!action && method === "PUT")
          send(await this.lists.update(id, data));
        else
          throw new MarketingError(
            "METHOD_NOT_ALLOWED",
            "Действие не поддерживается",
            405,
          );
      } else if (
        path.startsWith("/api/marketing/operations/") &&
        method === "GET"
      ) {
        send(
          await this.repository.operationResult(
            path.slice("/api/marketing/operations/".length),
          ),
        );
      } else throw new MarketingError("NOT_FOUND", "Раздел не найден", 404);
    } catch (error) {
      send(
        errorBody(error),
        error instanceof MarketingError ? error.status : 503,
      );
    }
    return true;
  }
}
