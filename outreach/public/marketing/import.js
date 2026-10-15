import { fileToImportPayload } from "/importer.js";
import { api, escape, guard, heading, input, navigate } from "./common.js";
const options = [
  ["skip", "Не импортировать"],
  ["email", "Email"],
  ["name", "Полное имя"],
  ["firstName", "Имя"],
  ["lastName", "Фамилия"],
  ["middleName", "Отчество"],
  ["company", "Компания"],
  ["jobTitle", "Должность"],
  ["phone", "Телефон"],
  ["website", "Сайт"],
  ["department", "Отдел"],
  ["industry", "Отрасль"],
  ["region", "Регион"],
  ["country", "Страна"],
  ["custom", "Своя переменная"],
];
export async function importForm(root, params) {
  const lists = [];
  for (let page = 1; ; page++) {
    const result = await api(`/lists?perPage=100&page=${page}`);
    lists.push(...result.items);
    if (lists.length >= result.total || !result.items.length) break;
  }
  let file = null,
    preview = null;
  const previous = localStorage.getItem("dmailio-last-import");
  root.innerHTML =
    heading(
      "Импорт контактов",
      "CSV или Excel (.xlsx), до 25 МБ, 10 000 строк и 200 столбцов. Проверяется формат адреса, без внешнего валидатора.",
    ) +
    `
    ${previous ? `<p><a href="#marketing/imports/${escape(previous)}">Результат предыдущего импорта</a></p>` : ""}
    <form class="panel mk-import" data-import>
    <label>Файл CSV или Excel<input type="file" name="file" accept=".csv,.xlsx" required></label><div data-mapping></div>
    <fieldset><legend>Списки для импорта</legend>${lists.map((list) => `<label class="mk-check"><input type="checkbox" name="listIds" value="${list.id}" ${params.get("listId") === list.id ? "checked" : ""}>${escape(list.name)}</label>`).join("") || "<p>Создайте список в разделе «Списки рассылки».</p>"}</fieldset>
    ${input("source", "Источник базы", "", "text", 'required maxlength="1000"')}
    <label>Если контакт уже существует<select name="duplicates"><option value="skip">Пропустить</option><option value="update">Обновить поля и добавить в выбранные списки</option></select></label>
    <label class="mk-check"><input type="checkbox" name="overwriteEmpty">Разрешить пустым ячейкам очищать существующие значения</label>
    <label class="mk-check"><input type="checkbox" name="consentConfirmed">Подтверждаю согласие новых контактов на маркетинговые письма</label>
    <p class="hint">Импорт сохраняет отписки и блокировки существующих контактов.</p>
    <div class="mk-actions"><button type="button" data-validate>Проверить сопоставление</button><button class="primary" type="submit">Импортировать</button></div><div data-validation role="status"></div></form>`;
  const form = root.querySelector("form"),
    mapping = root.querySelector("[data-mapping]");
  const mappings = () =>
    [...mapping.querySelectorAll("[data-column]")].map((select) => ({
      columnId: select.dataset.column,
      target: select.value,
      variableName: mapping.querySelector(
        `[data-custom="${select.dataset.column}"]`,
      ).value,
    }));
  const draw = () => {
    mapping.innerHTML = `${preview.sheets.length ? `<label>Лист Excel<select data-sheet><option value="">Выберите лист</option>${preview.sheets.map((sheet) => `<option value="${sheet.id}" ${file.sheetId === sheet.id ? "selected" : ""}>${escape(sheet.name)}</option>`).join("")}</select></label>` : ""}${
      preview.table
        ? `<p>Строк: ${preview.table.rows.length}. Выберите тип для каждого нужного столбца.</p><div class="table-scroll"><table><thead><tr><th>Столбец</th><th>Тип переменной</th><th>Своя переменная</th><th>Примеры</th></tr></thead><tbody>${preview.table.columns
            .map((column) => {
              const suggested = preview.mappings.find(
                (item) => item.columnId === column.id,
              );
              return `<tr><td>${escape(column.header)}</td><td><select aria-label="Тип столбца ${escape(column.header)}" data-column="${column.id}">${options.map(([value, label]) => `<option value="${value}" ${suggested?.target === value ? "selected" : ""}>${label}</option>`).join("")}</select></td><td><input aria-label="Название переменной ${escape(column.header)}" data-custom="${column.id}" maxlength="80" value="${escape(suggested?.variableName || column.header)}" ${suggested?.target === "custom" ? "" : "hidden"}></td><td>${column.samples.map(escape).join("<br>")}</td></tr>`;
            })
            .join("")}</tbody></table></div>`
        : ""
    }`;
    mapping.querySelector("[data-sheet]")?.addEventListener(
      "change",
      guard(async (event) => {
        file.sheetId = event.target.value;
        preview = await api("/imports/preview", file);
        draw();
      }, root),
    );
    mapping.querySelectorAll("[data-column]").forEach(
      (select) =>
        (select.onchange = () => {
          mapping.querySelector(
            `[data-custom="${select.dataset.column}"]`,
          ).hidden = select.value !== "custom";
          root.querySelector("[data-validation]").textContent =
            "Сопоставление изменено — проверьте его перед импортом";
        }),
    );
  };
  form.elements.file.onchange = guard(async () => {
    if (!form.elements.file.files[0]) return;
    file = await fileToImportPayload(form.elements.file.files[0]);
    preview = await api("/imports/preview", file);
    draw();
  }, root);
  root.querySelector("[data-validate]").onclick = guard(async () => {
    if (!preview?.table) throw new Error("Загрузите файл и выберите лист");
    const result = await api("/imports/preview", {
      file,
      mappings: mappings(),
    });
    root.querySelector("[data-validation]").textContent =
      `Готовы: ${result.validation.rows.length}; ошибки: ${result.validation.rejected.length}; повторы в файле: ${result.validation.skipped.length}`;
  }, root);
  form.onsubmit = guard(async (event) => {
    event.preventDefault();
    if (!preview?.table) throw new Error("Загрузите файл и выберите лист");
    const data = new FormData(form),
      button = form.querySelector("[type=submit]");
    button.disabled = true;
    const operationId = crypto.randomUUID();
    localStorage.setItem("dmailio-last-import", operationId);
    try {
      await api("/imports", {
        operationId,
        file,
        mappings: mappings(),
        listIds: data.getAll("listIds"),
        source: data.get("source"),
        duplicates: data.get("duplicates"),
        overwriteEmpty: data.has("overwriteEmpty"),
        consentConfirmed: data.has("consentConfirmed"),
      });
      navigate(`imports/${operationId}`);
    } catch (error) {
      root.querySelector("[data-validation]").innerHTML =
        `<p>Если соединение прервалось, <a href="#marketing/imports/${operationId}">проверьте результат операции</a> перед повторной загрузкой.</p>`;
      throw error;
    } finally {
      button.disabled = false;
    }
  }, root);
}
export async function importStatus(root, id) {
  const refresh = async () => {
    if (!root.isConnected) return;
    try {
      const result = await api(`/imports/${id}`);
      if (!root.isConnected) return;
      root.innerHTML =
        heading("Результат импорта", `Операция ${id}`) +
        `<div class="panel mk-import"><p role="status">${{ pending: "В очереди", running: "Импорт идёт", completed: "Завершён", paused: "Приостановлен" }[result.state]}: ${result.processed} / ${result.total}</p><p>Добавлено: ${result.added}; обновлено: ${result.updated}; пропущено: ${result.skipped}; ошибок строк: ${result.rejected}</p>${result.error ? `<p role="alert">${escape(result.error)}</p><button data-resume>Продолжить импорт</button>` : ""}<div class="mk-actions"><a href="/api/marketing/imports/${id}/report">Скачать отчёт CSV по строкам</a><a href="#marketing/contacts">Перейти к контактам</a><a href="#marketing/import">Новый импорт</a></div></div><div class="panel table-scroll"><table><thead><tr><th>Строка</th><th>Email</th><th>Результат</th><th>Причина</th></tr></thead><tbody>${result.report
          .slice(-100)
          .map(
            (row) =>
              `<tr><td>${row.row}</td><td>${escape(row.email)}</td><td>${escape(row.status)}</td><td>${escape(row.reason)}</td></tr>`,
          )
          .join(
            "",
          )}</tbody></table><p>Показаны последние 100 строк; полный отчёт доступен в CSV.</p></div>`;
      root.querySelector("[data-resume]")?.addEventListener(
        "click",
        guard(async () => {
          await api(`/imports/${id}/resume`, {});
          await refresh();
        }, root),
      );
      if (["pending", "running"].includes(result.state))
        setTimeout(refresh, 1000);
    } catch (error) {
      if (root.isConnected) {
        root.innerHTML =
          heading("Импорт", error.message) +
          "<button data-retry>Проверить ещё раз</button>";
        root.querySelector("[data-retry]").onclick = refresh;
      }
    }
  };
  await refresh();
}
