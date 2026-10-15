import {
  api,
  escape,
  guard,
  heading,
  pager,
  dialog,
  input,
  date,
  navigate,
} from "./common.js";
export async function lists(root, params, refresh) {
  const result = await api(`/lists?${params}`);
  root.innerHTML =
    heading(
      "Списки рассылки",
      "Объединяйте контакты в группы. Один контакт может состоять в нескольких списках.",
      '<button class="primary" data-new-list>Создать список</button>',
    ) +
    `
    <form class="panel mk-filters" data-filter>${input("search", "Поиск списков", params.get("search"), "search")}${input("tag", "Тег", params.get("tag"))}<label>Показывать<select name="archived">${[
      ["false", "Активные"],
      ["true", "Архивные"],
      ["all", "Все"],
    ]
      .map(
        ([key, name]) =>
          `<option value="${key}" ${params.get("archived") === key ? "selected" : ""}>${name}</option>`,
      )
      .join("")}</select></label><label>Сортировка<select name="sort">${[
      ["created_at", "Дата создания"],
      ["name", "Название"],
      ["updated_at", "Дата изменения"],
    ]
      .map(
        ([key, name]) =>
          `<option value="${key}" ${params.get("sort") === key ? "selected" : ""}>${name}</option>`,
      )
      .join(
        "",
      )}</select></label><label>Порядок<select name="direction"><option value="desc">По убыванию</option><option value="asc" ${params.get("direction") === "asc" ? "selected" : ""}>По возрастанию</option></select></label><button class="primary">Применить</button><button type="button" data-reset>Сбросить</button></form>
    <div class="panel table-scroll"><table><thead><tr><th>Список</th><th>Контакты</th><th>Теги</th><th>Создан</th><th>Действия</th></tr></thead><tbody>${result.items.map((row) => `<tr><td><a href="#marketing/lists/${row.id}">${escape(row.name)}</a><p class="hint">${escape(row.description)}</p>${row.archived ? "В архиве" : ""}</td><td>${row.total}</td><td>${row.tags.map(escape).join(", ") || "—"}</td><td>${date(row.createdAt)}</td><td><div class="mk-actions"><button data-edit="${row.id}">Изменить</button><button data-archive="${row.id}">${row.archived ? "Восстановить" : "В архив"}</button>${!row.archived ? `<button data-audience="${row.id}">Проверить аудиторию</button>` : ""}</div></td></tr>`).join("") || '<tr><td colspan="5">Списки не найдены. Создайте список или измените фильтр.</td></tr>'}</tbody></table></div>${pager(result)}`;
  const on = (selector, event, fn) =>
    root
      .querySelectorAll(selector)
      .forEach((element) => element.addEventListener(event, guard(fn, root)));
  const edit = (row) =>
    dialog(
      row ? "Изменить список" : "Создать список",
      `${input("name", "Название", row?.name, "text", 'required maxlength="200"')}<label>Описание<textarea name="description" maxlength="4000">${escape(row?.description)}</textarea></label>${input("tags", "Теги через запятую", row?.tags.join(", "))}`,
      async (data) => {
        await api(
          row ? `/lists/${row.id}` : "/lists",
          {
            name: data.get("name"),
            description: data.get("description"),
            tags: String(data.get("tags"))
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          },
          row ? "PUT" : "POST",
        );
        await refresh();
      },
    );
  on("[data-new-list]", "click", () => edit());
  on("[data-edit]", "click", (event) =>
    edit(
      result.items.find((row) => row.id === event.currentTarget.dataset.edit),
    ),
  );
  on("[data-archive]", "click", (event) => {
    const row = result.items.find(
      (row) => row.id === event.currentTarget.dataset.archive,
    );
    dialog(
      row.archived ? "Восстановить список" : "Архивировать список",
      `<p>${escape(row.name)}. Контакты и история сохранятся.</p>`,
      async () => {
        await api(`/lists/${row.id}`, { archived: !row.archived }, "PUT");
        await refresh();
      },
      { save: row.archived ? "Восстановить" : "В архив" },
    );
  });
  on("[data-audience]", "click", async (event) => {
    const result = await api("/audience/preview", {
      listIds: [event.currentTarget.dataset.audience],
    });
    dialog(
      "Аудитория списка",
      `<p>Уникальных контактов: ${result.total}</p><p>Доступны для отправки: ${result.eligible}</p><p>Исключены: ${result.excluded}</p><p>Учитываются разрешение маркетинга, подтверждение подписки, отписки и блокировки.</p>`,
      async () => {},
      { save: "Понятно" },
    );
  });
  on("[data-filter]", "submit", (event) => {
    event.preventDefault();
    const filter = new URLSearchParams();
    for (const [key, value] of new FormData(event.target))
      if (value) filter.set(key, value);
    navigate("lists", filter);
  });
  on("[data-reset]", "click", () => navigate("lists"));
  on("[data-page]", "click", (event) => {
    const values = new URLSearchParams(params);
    values.set("page", event.currentTarget.dataset.page);
    navigate("lists", values);
  });
}
