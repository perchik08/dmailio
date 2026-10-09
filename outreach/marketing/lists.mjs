import {
  invalid,
  pagination,
  requiredString,
  identifier,
} from "./contracts.mjs";
import { tagsInput } from "./contacts.mjs";
export function listInput(value) {
  return {
    name: requiredString(value.name, "Название списка", 200),
    description: String(value.description ?? "").slice(0, 4000),
    tags: tagsInput(value.tags),
    type: "private",
    optin: "single",
    status: value.archived === true ? "archived" : "active",
  };
}
export class Lists {
  constructor(client, repository, contacts) {
    Object.assign(this, { client, repository, contacts });
  }
  async map(row) {
    await this.repository.link("list", row.id, row.uuid);
    return {
      id: row.uuid,
      name: row.name,
      description: row.description,
      tags: row.tags || [],
      archived: row.status === "archived",
      createdAt: row.created_at,
      total: row.subscriber_count ?? 0,
      subscriptionCounts: row.subscriber_statuses || {},
    };
  }
  async page(params) {
    const page = pagination(params, [
      "search",
      "archived",
      "sort",
      "direction",
      "tag",
    ]);
    const query = new URLSearchParams({
      page: page.page,
      per_page: page.perPage,
    });
    if (params.get("search"))
      query.set("query", params.get("search").slice(0, 200));
    if (params.get("tag")) query.set("tag", params.get("tag"));
    if (params.get("archived") !== "all")
      query.set(
        "status",
        params.get("archived") === "true" ? "archived" : "active",
      );
    const sort = params.get("sort") || "created_at",
      order = params.get("direction") || "desc";
    if (
      !["name", "created_at", "updated_at"].includes(sort) ||
      !["asc", "desc"].includes(order)
    )
      throw invalid("Некорректная сортировка");
    query.set("order_by", sort);
    query.set("order", order);
    const result = await this.client.request("GET", `/api/lists?${query}`);
    return {
      items: await Promise.all(
        (result.results || []).map((row) => this.map(row)),
      ),
      total: result.total,
      ...page,
    };
  }
  async get(id) {
    return this.map(
      await this.client.request(
        "GET",
        `/api/lists/${await this.repository.externalId("list", id)}`,
      ),
    );
  }
  async create(data) {
    return this.map(
      await this.client.request("POST", "/api/lists", listInput(data)),
    );
  }
  async update(id, value) {
    const previous = await this.get(id);
    return this.map(
      await this.client.request(
        "PUT",
        `/api/lists/${await this.repository.externalId("list", id)}`,
        listInput({ ...previous, ...value }),
      ),
    );
  }
  async memberPage(id, params) {
    const copy = new URLSearchParams(params);
    copy.set("listId", identifier(id));
    return this.contacts.page(copy);
  }
  async members(id, ids, action) {
    if (
      !["add", "remove"].includes(action) ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 10000
    )
      throw invalid("Выберите контакты и действие");
    const external = await this.repository.externalId("list", id);
    const contactIds = await Promise.all(
      [...new Set(ids.map(identifier))].map((uuid) =>
        this.repository.externalId("contact", uuid),
      ),
    );
    if (action === "add" && (await this.get(id)).archived)
      throw invalid("Сначала восстановите список из архива");
    await this.client.request("PUT", "/api/subscribers/lists", {
      ids: contactIds,
      target_list_ids: [external],
      action: action === "add" ? "add" : "remove",
    });
    return { affected: contactIds.length, action };
  }
  async audience(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100)
      throw invalid("Выберите от 1 до 100 списков");
    const chosen = new Set(ids.map(identifier)),
      unique = new Map();
    let duplicated = 0;
    for (const id of chosen) {
      if ((await this.get(id)).archived)
        throw invalid("Архивный список нельзя использовать для новой рассылки");
      for (const row of await this.contacts.all(
        new URLSearchParams({ listId: id }),
      )) {
        if (unique.has(row.id)) duplicated++;
        else unique.set(row.id, row);
      }
      if (unique.size > 10000)
        throw invalid("Не более 10 000 контактов в аудитории текущего выпуска");
    }
    const recipients = [...unique.values()],
      eligible = [],
      excluded = [];
    for (const contact of recipients) {
      const allowed =
        contact.status === "active" &&
        contact.lists.some(
          (list) =>
            chosen.has(list.id) &&
            list.status === "confirmed" &&
            !list.archived,
        );
      (allowed ? eligible : excluded).push(
        allowed
          ? contact
          : {
              ...contact,
              reason:
                contact.status === "active"
                  ? "Нет подтверждённой подписки в выбранных списках"
                  : contact.status,
            },
      );
    }
    return {
      total: recipients.length,
      eligible: eligible.length,
      excluded: excluded.length,
      duplicates: duplicated,
      recipients: eligible,
      exclusions: excluded,
    };
  }
}
