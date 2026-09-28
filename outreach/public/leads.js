const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const saved = new Map();
const stateLabels = {
  pending: "В очереди",
  sending: "Отправляется",
  replied: "Остановлено после ответа",
  bounced: "Остановлено: недоставка",
  unsubscribed: "Остановлено: отписка",
  stopped: "Остановлено вручную",
  failed: "Ошибка отправки",
  uncertain: "Результат отправки неизвестен",
  invalid: "Ошибка подготовки письма",
};
const fieldName = (key) =>
  ({ email: "Email", sender: "Ящик отправителя", step: "Текущий шаг" })[key] ||
  key;
const operators = {
  eq: "Равно",
  contains: "Содержит",
  empty: "Пусто",
  not_empty: "Не пусто",
};

export function mountLeads(container, campaign, api, notify) {
  if (!campaign.id) {
    container.innerHTML =
      '<div class="lead-empty"><h2>Добавьте лиды</h2><p>Загрузите CSV и сохраните кампанию, чтобы увидеть контакты.</p></div>';
    return;
  }
  let filters = structuredClone(
    saved.get(campaign.id) || {
      search: "",
      actions: [],
      excluded: [],
      fields: [],
      page: 1,
    },
  );
  let serial = 0,
    timer;
  container.innerHTML = `<div class="lead-toolbar"><h2>Лиды <span id="lead-total"></span></h2><div class="row"><button type="button" id="lead-filter">☷ Фильтры</button><input id="lead-search" type="search" aria-label="Поиск лидов" placeholder="Email, имя или компания" value="${esc(filters.search)}"><button type="button" id="lead-reset">Сбросить</button></div></div><div id="lead-active" class="lead-active"></div><div id="lead-results" aria-live="polite"></div>`;
  const result = container.querySelector("#lead-results");
  async function load() {
    const request = ++serial;
    result.setAttribute("aria-busy", "true");
    try {
      const data = await api(`/campaigns/${campaign.id}/leads`, filters);
      if (!container.isConnected || request !== serial) return;
      filters.page = data.page;
      saved.set(campaign.id, structuredClone(filters));
      container.querySelector("#lead-total").textContent =
        `${data.total} из ${data.campaignTotal}`;
      const active = [
        ...filters.actions.map((a) => data.actions[a]),
        ...filters.excluded.map((a) => `Без: ${data.actions[a]}`),
        ...filters.fields.map(
          (f) => `${fieldName(f.key)} ${operators[f.op]} ${f.value || ""}`,
        ),
      ];
      container.querySelector("#lead-active").innerHTML = active
        .map((t) => `<span class="badge">${esc(t)}</span>`)
        .join("");
      const keys = data.fields.filter(
        (k) => !["email", "sender", "step"].includes(k),
      );
      const badges = (l) =>
        Object.entries(l.flags)
          .filter(
            ([k, v]) =>
              v &&
              !["not_replied", "errors", "uncertain", "stopped"].includes(k),
          )
          .map(
            ([k]) =>
              `<span class="badge lead-${k}">${esc(data.actions[k])}</span>`,
          )
          .join(" ");
      result.innerHTML =
        data.campaignTotal === 0
          ? '<div class="lead-empty"><h2>Добавьте лиды</h2><p>Загрузите контакты через форму импорта выше.</p></div>'
          : `<p class="hint">${data.tracking.opens ? "Открытия могут включать автоматическую загрузку изображений." : "Открытия: нет данных — отслеживание выключено."} ${data.tracking.clicks ? "Переходы могут включать автоматические проверки ссылок." : "Клики: нет данных — отслеживание выключено."}</p><div class="table-scroll"><table class="lead-table"><thead><tr><th>Email</th><th>Статус и действия</th><th>Шаг</th><th>Отправитель</th>${keys.map((k) => `<th>${esc(k)}</th>`).join("")}<th>Причина ошибки</th></tr></thead><tbody>${data.rows.map((l) => `<tr><td>${esc(l.email)}</td><td><div class="lead-badges">${badges(l)}${stateLabels[l.status] ? `<span class="badge">${esc(stateLabels[l.status])}</span>` : ""}${campaign.status === "paused" ? '<span class="badge">Кампания на паузе</span>' : ""}${l.suppression && !["unsubscribed", "bounced"].includes(l.status) ? `<span class="badge">Отправка запрещена: ${esc(l.suppression)}</span>` : ""}</div></td><td>${l.flags.completed ? `${l.totalSteps} из ${l.totalSteps}` : `${Math.min(l.step + 1, l.totalSteps)} из ${l.totalSteps}`}</td><td>${esc(l.sender || "Ещё не назначен")}</td>${keys.map((k) => `<td><div class="lead-cell" title="${esc(l.fields[k])}">${esc(l.fields[k])}</div></td>`).join("")}<td><div class="lead-cell" title="${esc(l.error)}">${esc(l.error || "—")}</div></td></tr>`).join("") || `<tr><td colspan="${keys.length + 5}">Нет лидов по выбранным условиям. Измените фильтры или сбросьте их.</td></tr>`}</tbody></table></div><div class="lead-pagination"><button id="lead-prev" ${data.page <= 1 ? "disabled" : ""}>← Назад</button><span>Страница ${data.page} из ${data.pages}</span><button id="lead-next" ${data.page >= data.pages ? "disabled" : ""}>Далее →</button></div>`;
      result.querySelector("#lead-prev")?.addEventListener("click", () => {
        filters.page--;
        load();
      });
      result.querySelector("#lead-next")?.addEventListener("click", () => {
        filters.page++;
        load();
      });
      container.querySelector("#lead-filter").onclick = () => openFilters(data);
    } catch (error) {
      if (request === serial && container.isConnected) {
        result.textContent = error.message;
        notify(error.message);
      }
    } finally {
      if (request === serial) result.removeAttribute("aria-busy");
    }
  }
  function openFilters(data) {
    const draft = structuredClone(filters);
    const modal = document.createElement("dialog");
    modal.className = "lead-filter-dialog";
    modal.innerHTML = `<form><h2>Фильтры лидов</h2><p class="hint">Выбранные действия объединяются через «ИЛИ». Исключения и разные поля — через «И». Несколько условий одного поля — через «ИЛИ».</p><h3>Действия</h3><div class="lead-filter-actions">${Object.entries(
      data.actions,
    )
      .filter(([k]) => k !== "not_replied")
      .map(
        ([k, label]) =>
          `<label>${esc(label)} <span class="hint">${data.counts[k]}</span><select data-action="${k}" aria-label="${esc(label)}"><option value="">Любой</option><option value="yes" ${draft.actions.includes(k) ? "selected" : ""}>Есть</option><option value="no" ${draft.excluded.includes(k) ? "selected" : ""}>Нет</option></select></label>`,
      )
      .join(
        "",
      )}</div><p class="hint">Счётчики учитывают поиск и применённые фильтры полей. Для «Связались и не ответили»: Связались — Есть, Ответили — Нет.</p><h3>Поля контакта</h3><div id="lead-field-rows"></div><button type="button" id="lead-add-field">+ Условие по полю</button><div class="lead-dialog-footer"><button type="button" id="lead-clear">Очистить</button><button type="button" id="lead-cancel">Отмена</button><button class="primary" type="submit">Применить</button></div></form>`;
    const rows = modal.querySelector("#lead-field-rows");
    const renderFields = () => {
      rows.innerHTML = draft.fields
        .map(
          (f, i) =>
            `<div class="lead-field-row"><select data-index="${i}" data-prop="key" aria-label="Поле">${data.fields.map((k) => `<option value="${esc(k)}" ${k === f.key ? "selected" : ""}>${esc(fieldName(k))}</option>`).join("")}</select><select data-index="${i}" data-prop="op" aria-label="Условие">${Object.entries(
              operators,
            )
              .map(
                ([k, v]) =>
                  `<option value="${k}" ${k === f.op ? "selected" : ""}>${v}</option>`,
              )
              .join(
                "",
              )}</select><input data-index="${i}" data-prop="value" aria-label="Значение" maxlength="1000" value="${esc(f.value)}" ${["empty", "not_empty"].includes(f.op) ? "disabled" : ""}><button type="button" data-remove="${i}" aria-label="Удалить условие">×</button></div>`,
        )
        .join("");
      rows.querySelectorAll("[data-prop]").forEach((el) =>
        el.addEventListener("change", () => {
          draft.fields[Number(el.dataset.index)][el.dataset.prop] = el.value;
          if (el.dataset.prop === "op") renderFields();
        }),
      );
      rows.querySelectorAll("[data-remove]").forEach(
        (el) =>
          (el.onclick = () => {
            draft.fields.splice(Number(el.dataset.remove), 1);
            renderFields();
          }),
      );
    };
    modal.querySelector("#lead-add-field").onclick = () => {
      if (draft.fields.length < 20) {
        draft.fields.push({ key: "email", op: "contains", value: "" });
        renderFields();
      }
    };
    modal.querySelector("#lead-cancel").onclick = () => modal.close();
    modal.querySelector("#lead-clear").onclick = () => {
      draft.fields = [];
      renderFields();
      modal.querySelectorAll("[data-action]").forEach((el) => (el.value = ""));
    };
    modal.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      draft.actions = [];
      draft.excluded = [];
      modal.querySelectorAll("[data-action]").forEach((el) => {
        if (el.value)
          draft[el.value === "yes" ? "actions" : "excluded"].push(
            el.dataset.action,
          );
      });
      filters = { ...draft, search: filters.search, page: 1 };
      modal.close();
      load();
    };
    modal.addEventListener("close", () => modal.remove());
    document.body.append(modal);
    renderFields();
    modal.showModal();
  }
  container.querySelector("#lead-search").addEventListener("input", (e) => {
    filters.search = e.target.value;
    filters.page = 1;
    ++serial;
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
  container.querySelector("#lead-reset").onclick = () => {
    clearTimeout(timer);
    filters = { search: "", actions: [], excluded: [], fields: [], page: 1 };
    container.querySelector("#lead-search").value = "";
    load();
  };
  load();
}
