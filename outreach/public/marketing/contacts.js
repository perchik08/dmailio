import {
  api,
  request,
  escape,
  guard,
  heading,
  pager,
  dialog,
  input,
  statusNames,
  date,
  navigate,
} from "./common.js";

const standard = [
  ["firstName", "Имя"],
  ["lastName", "Фамилия"],
  ["middleName", "Отчество"],
  ["company", "Компания"],
  ["jobTitle", "Должность"],
  ["phone", "Телефон"],
  ["website", "Сайт"],
];
const splitTags = (value) =>
  String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
async function allLists() {
  const rows = [];
  for (let page = 1; ; page++) {
    const result = await api(`/lists?archived=all&perPage=100&page=${page}`);
    rows.push(...result.items);
    if (rows.length >= result.total || !result.items.length) return rows;
  }
}
export async function editContact(contact, refresh) {
  const lists = contact
    ? []
    : (await allLists()).filter((list) => !list.archived);
  const known = new Set(standard.map(([key]) => key));
  const fieldRow = (key = "", value = "") =>
    `<div class="mk-field-row">${input("fieldKey", "Переменная", key, "text", 'maxlength="80"')}${input("fieldValue", "Значение", value, "text", 'maxlength="4000"')}<button type="button" data-remove-field aria-label="Удалить поле">×</button></div>`;
  const element = dialog(
    contact ? "Контакт" : "Добавить контакт",
    `
    ${input("email", "Email", contact?.email, "email", 'required maxlength="254"')}
    ${input("name", "Отображаемое имя", contact?.name, "text", 'maxlength="200"')}
    <div class="mk-fields">${standard.map(([key, label]) => input(key, label, contact?.fields[key], "text", 'maxlength="4000"')).join("")}</div>
    <h3>Дополнительные переменные</h3><div data-fields>${Object.entries(
      contact?.fields || {},
    )
      .filter(([key]) => !known.has(key))
      .map(([key, value]) => fieldRow(key, value))
      .join("")}</div>
    <button type="button" data-add-field>Добавить поле</button>
    ${input("tags", "Теги через запятую", contact?.tags.join(", "))}
    ${input("source", "Источник контакта", contact?.source, "text", 'required maxlength="1000"')}
    <label class="mk-check"><input type="checkbox" name="enabled" ${contact?.enabled !== false ? "checked" : ""}>Разрешить маркетинговые отправки</label>
    ${contact ? `<p>Статус: <strong>${escape(statusNames[contact.status])}</strong>. Включение отправки сохраняет отписки и блокировки.</p><h3>Участие в списках</h3>${contact.lists.map((list) => `<p><a href="#marketing/lists/${list.id}">${escape(list.name)}</a> — ${escape(list.status)}</p>`).join("") || "<p>Не состоит в списках</p>"}` : `<fieldset><legend>Списки</legend>${lists.map((list) => `<label class="mk-check"><input name="listIds" type="checkbox" value="${list.id}">${escape(list.name)}</label>`).join("") || "Сначала создайте список в разделе «Списки рассылки»"}</fieldset><label class="mk-check"><input type="checkbox" name="consentConfirmed">Подтверждаю согласие контакта на маркетинговые письма</label>`}
  `,
    async (data, form) => {
      const fields = Object.fromEntries(
        standard
          .map(([key]) => [key, data.get(key)])
          .filter(([, value]) => value),
      );
      for (const row of form.querySelectorAll(".mk-field-row")) {
        const key = row.querySelector("[name=fieldKey]").value.trim();
        if (!key || Object.hasOwn(fields, key))
          throw new Error("Укажите уникальное название каждой переменной");
        Object.defineProperty(fields, key, {
          value: row.querySelector("[name=fieldValue]").value,
          enumerable: true,
        });
      }
      const value = {
        email: data.get("email"),
        name: data.get("name"),
        fields,
        tags: splitTags(data.get("tags")),
        source: data.get("source"),
        enabled: data.has("enabled"),
      };
      if (!contact) {
        value.listIds = data.getAll("listIds");
        value.consentConfirmed = data.has("consentConfirmed");
      }
      await api(
        contact ? `/contacts/${contact.id}` : "/contacts",
        value,
        contact ? "PUT" : "POST",
      );
      await refresh();
    },
  );
  element.querySelector("[data-add-field]").onclick = () => {
    element
      .querySelector("[data-fields]")
      .insertAdjacentHTML("beforeend", fieldRow());
  };
  element.addEventListener("click", (event) => {
    event.target
      .closest("[data-remove-field]")
      ?.closest(".mk-field-row")
      .remove();
  });
}

export async function contacts(root, params, { list, refresh }) {
  const query = new URLSearchParams(params);
  if (list) query.set("listId", list.id);
  const result = await api(`/contacts?${query}`);
  const selected = new Set();
  let allSelected = false;
  root.innerHTML =
    heading(
      list ? list.name : "Все контакты",
      list
        ? list.description || "Контакты списка рассылки"
        : "Общая база маркетинговых контактов",
      `${list ? "<button data-back>Все списки</button>" : ""}<button data-new class="primary">Добавить контакт</button>`,
    ) +
    `
    <form data-filters class="mk-filters panel">
      ${input("search", "Поиск", query.get("search"), "search", 'placeholder="Email, имя или значение поля"')}
      <label>Статус<select name="status"><option value="all">Все статусы</option>${Object.entries(
        statusNames,
      )
        .map(
          ([key, name]) =>
            `<option value="${key}" ${query.get("status") === key ? "selected" : ""}>${name}</option>`,
        )
        .join("")}</select></label>
      ${input("tag", "Тег", query.get("tag"))}
      ${input("addedFrom", "Добавлены с", query.get("addedFrom"), "date")}${input("addedTo", "Добавлены по", query.get("addedTo"), "date")}
      <details><summary>Фильтр по переменной</summary>${input("field", "Название переменной", query.get("field"))}<label>Условие<select name="fieldOp">${[
        ["equals", "Равно"],
        ["contains", "Содержит"],
        ["empty", "Не заполнено"],
        ["notEmpty", "Заполнено"],
      ]
        .map(
          ([key, name]) =>
            `<option value="${key}" ${query.get("fieldOp") === key ? "selected" : ""}>${name}</option>`,
        )
        .join(
          "",
        )}</select></label>${input("value", "Значение", query.get("value"))}</details>
      <label>Сортировка<select name="sort">${[
        ["created_at", "Дата добавления"],
        ["email", "Email"],
        ["name", "Имя"],
        ["updated_at", "Дата изменения"],
      ]
        .map(
          ([key, name]) =>
            `<option value="${key}" ${query.get("sort") === key ? "selected" : ""}>${name}</option>`,
        )
        .join("")}</select></label>
      <label>Порядок<select name="direction"><option value="desc">По убыванию</option><option value="asc" ${query.get("direction") === "asc" ? "selected" : ""}>По возрастанию</option></select></label>
      <button class="primary">Применить</button><button type="button" data-reset>Сбросить</button>
    </form>
    <div class="mk-actions"><span data-selection aria-live="polite">Не выбрано</span><button data-select-all>Выбрать всех по фильтру</button><button data-clear>Снять выбор</button><button data-membership>${list ? "Убрать из списка" : "Добавить в список"}</button><button data-export="csv">Экспорт CSV</button><button data-export="xlsx">Экспорт Excel</button></div>
    <div class="panel table-scroll"><table><thead><tr><th><input data-check-page type="checkbox" aria-label="Выбрать страницу"></th><th>Email / имя</th><th>Статус</th><th>Списки</th><th>Теги</th><th>Источник</th><th>Добавлен</th></tr></thead><tbody>${result.items.map((row) => `<tr><td><input data-contact-check="${row.id}" type="checkbox" aria-label="Выбрать ${escape(row.email)}"></td><td><button data-contact="${row.id}">${escape(row.email)}</button><div class="hint">${escape(row.name)}</div></td><td>${escape(statusNames[row.status])}</td><td>${row.lists.map((item) => `<a href="#marketing/lists/${item.id}">${escape(item.name)}</a>`).join(", ") || "—"}</td><td>${row.tags.map(escape).join(", ") || "—"}</td><td>${escape(row.source)}</td><td>${date(row.createdAt)}</td></tr>`).join("") || '<tr><td colspan="7">Контакты не найдены. Измените фильтр или добавьте контакт.</td></tr>'}</tbody></table></div>${pager(result)}`;
  const on = (selector, event, fn) =>
    root
      .querySelectorAll(selector)
      .forEach((element) => element.addEventListener(event, guard(fn, root)));
  const go = (values) =>
    navigate(list ? `lists/${list.id}` : "contacts", values);
  const count = () => (allSelected ? result.total : selected.size);
  const sync = () => {
    root.querySelector("[data-selection]").textContent = `Выбрано: ${count()}`;
    root.querySelectorAll("[data-contact-check]").forEach((box) => {
      box.checked = allSelected || selected.has(box.dataset.contactCheck);
    });
  };
  on("[data-new]", "click", () => editContact(null, refresh));
  on("[data-back]", "click", () => navigate("lists"));
  on("[data-contact]", "click", async (event) =>
    editContact(
      await api(`/contacts/${event.currentTarget.dataset.contact}`),
      refresh,
    ),
  );
  on("[data-filters]", "submit", (event) => {
    event.preventDefault();
    const values = new URLSearchParams();
    for (const [key, value] of new FormData(event.target))
      if (value) values.set(key, value);
    go(values);
  });
  on("[data-reset]", "click", () => go(new URLSearchParams()));
  on("[data-page]", "click", (event) => {
    const values = new URLSearchParams(params);
    values.set("page", event.currentTarget.dataset.page);
    go(values);
  });
  on("[data-check-page]", "change", (event) => {
    allSelected = false;
    selected.clear();
    if (event.target.checked)
      result.items.forEach((row) => selected.add(row.id));
    sync();
  });
  on("[data-contact-check]", "change", (event) => {
    if (allSelected) {
      sync();
      throw new Error(
        "Сначала снимите общий выбор, затем выберите отдельные контакты",
      );
    }
    if (event.target.checked) selected.add(event.target.dataset.contactCheck);
    else selected.delete(event.target.dataset.contactCheck);
    sync();
  });
  on("[data-select-all]", "click", () => {
    if (result.total > 10000)
      throw new Error(
        "Уточните фильтр: можно выбрать до 10 000 контактов за одну операцию",
      );
    allSelected = true;
    sync();
  });
  on("[data-clear]", "click", () => {
    allSelected = false;
    selected.clear();
    root.querySelector("[data-check-page]").checked = false;
    sync();
  });
  const selectedIds = async () => {
    if (!count()) throw new Error("Выберите контакты");
    if (!allSelected) return [...selected];
    const ids = [];
    const filter = new URLSearchParams(query);
    filter.set("perPage", "100");
    for (let page = 1; ; page++) {
      filter.set("page", page);
      const batch = await api(`/contacts?${filter}`);
      if (batch.total > 10000)
        throw new Error("База изменилась: уточните фильтр до 10 000 контактов");
      ids.push(...batch.items.map((row) => row.id));
      if (ids.length >= batch.total || !batch.items.length) return ids;
    }
  };
  on("[data-export]", "click", async (event) => {
    const format = event.currentTarget.dataset.export;
    const response = await request("/contacts/export", {
      filter: Object.fromEntries(query),
      format,
      ...(count() && !allSelected ? { ids: [...selected] } : {}),
    });
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `contacts.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  on("[data-membership]", "click", async () => {
    const ids = await selectedIds();
    if (list)
      dialog(
        "Убрать контакты из списка",
        `<p>Контактов: ${ids.length}. Они останутся в общей базе и других списках.</p>`,
        async () => {
          await api(`/lists/${list.id}/members`, { ids, action: "remove" });
          await refresh();
        },
        { save: "Убрать из списка" },
      );
    else {
      const lists = (await allLists()).filter((item) => !item.archived);
      if (!lists.length) throw new Error("Сначала создайте активный список");
      dialog(
        "Добавить в список",
        `<p>Контактов: ${ids.length}. Отписки и блокировки сохраняются.</p><label>Список<select name="listId">${lists.map((item) => `<option value="${item.id}">${escape(item.name)}</option>`).join("")}</select></label>`,
        async (data) => {
          await api(`/lists/${data.get("listId")}/members`, {
            ids,
            action: "add",
          });
          await refresh();
        },
      );
    }
  });
}
