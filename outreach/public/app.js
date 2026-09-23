import { mountEditor } from "/editor.js";
const root = document.querySelector("#app");
const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = {
  connected: "Подключён",
  unverified: "Не проверен",
  stopped: "Остановлен",
  cancelled: "Остановлено",
  draft: "Черновик",
  active: "Активна",
  paused: "На паузе",
  completed: "Завершена",
  pending: "В очереди",
  sending: "Отправляется",
  sent: "Отправлено",
  received: "Получено",
  replied: "Ответил",
  bounced: "Недоставка",
  warming: "Прогревается",
  waiting: "Ожидает второй ящик",
  error: "Ошибка подключения",
  unsubscribed: "Отписан",
  invalid: "Ошибка переменных",
  uncertain: "Нужна проверка",
  unknown: "Нужна проверка",
  failed: "Ошибка",
  new: "Новый",
  interested: "Интересно",
  closed: "Закрыто",
  not_interested: "Не интересно",
  campaign: "Цепочка",
  reply: "Ответ",
  manual: "Ручное письмо",
  auto: "Автоответ",
  bounce: "Недоставка",
};
const badge = (s) =>
  `<span class="badge ${escape(s)}">${escape(labels[s] || s)}</span>`;
const date = (t) => (t ? new Date(t).toLocaleString("ru-RU") : "—");
const mailWord = (n) => {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "писем";
  if (n % 10 === 1) return "письмо";
  if (n % 10 >= 2 && n % 10 <= 4) return "письма";
  return "писем";
};
let state = { mailboxes: [], campaigns: [] },
  page = "campaigns",
  current = null,
  activeTab = "sequence",
  stepIndex = 0,
  importCSV = "",
  parsed = null,
  inboxCampaign = "",
  threadId = "",
  analyticsCampaign = "",
  selectedMailboxes = new Set(),
  mailboxDetailId = "",
  mailboxDetailTab = "stats";
async function api(path, data) {
  const r = await fetch("/api" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const out = await r.json();
  if (r.status === 401) {
    login();
    throw new Error(out.error);
  }
  if (!r.ok) throw new Error(out.error || "Ошибка запроса");
  return out;
}
function notice(text) {
  document.querySelector("#notice").textContent = text;
  setTimeout(() => {
    document.querySelector("#notice").textContent = "";
  }, 6000);
}
function action(fn) {
  return async (e) => {
    try {
      await fn(e);
    } catch (err) {
      notice(err.message);
    }
  };
}
function click(id, fn) {
  document.getElementById(id)?.addEventListener("click", action(fn));
}
function options(items, value, key = "id", label = "name") {
  return items
    .map(
      (i) =>
        `<option value="${escape(i[key])}" ${i[key] === value ? "selected" : ""}>${escape(i[label])}</option>`,
    )
    .join("");
}
function shell(body) {
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div class="logo">dmailio</div><div class="subtle">Аутрич для вашей команды</div><nav>${[
    ["campaigns", "Кампании"],
    ["inbox", "Инбокс"],
    ["analytics", "Аналитика"],
    ["mailboxes", "Почты"],
  ]
    .map(
      ([id, name]) =>
        `<button data-nav="${id}" class="${page === id ? "active" : ""}">${name}</button>`,
    )
    .join(
      "",
    )}</nav><footer><p>Письма, которые становятся диалогами.</p><button id="logout">Выйти</button></footer></aside><main class="content">${body}</main></div>`;
  document.querySelectorAll("[data-nav]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        page = b.dataset.nav;
        current = null;
        mailboxDetailId = "";
        await refresh();
      })),
  );
  click("logout", async () => {
    await api("/logout", {});
    login();
  });
}
function login() {
  root.innerHTML =
    '<form class="login"><div class="logo">dmailio</div><h1>Войти в команду</h1><p class="hint">Введите пароль администратора вашей установки.</p><label>Пароль<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">Войти</button></form>';
  root.querySelector("form").onsubmit = action(async (e) => {
    e.preventDefault();
    await api("/login", { password: new FormData(e.target).get("password") });
    await refresh();
  });
}
async function refresh() {
  state = await api("/state");
  if (current) return renderCampaign();
  if (page === "campaigns") campaigns();
  if (page === "mailboxes") {
    if (mailboxDetailId) return renderMailboxDetail();
    mailboxes();
  }
  if (page === "inbox") await inbox();
  if (page === "analytics") await analytics();
}
function campaigns() {
  shell(
    `<div class="top"><div><h1>Кампании</h1><p class="hint">Контакты, персональные письма и последовательность касаний</p></div><button id="new" class="primary">+ Создать кампанию</button></div>${state.workerError ? `<div class="alert">${escape(state.workerError)}</div>` : ""}${state.campaigns.length ? `<div class="panel table-scroll"><table><thead><tr><th>Кампания</th><th>Статус</th><th>Контакты</th><th>Ответили</th><th>Требуют внимания</th></tr></thead><tbody>${state.campaigns.map((c) => `<tr><td><button data-campaign="${c.id}">${escape(c.name)}</button></td><td>${badge(c.status)}</td><td>${c.counts.reduce((n, r) => n + r.count, 0)}</td><td>${c.counts.find((r) => r.status === "replied")?.count || 0}</td><td>${c.counts.filter((r) => ["failed", "invalid", "uncertain"].includes(r.status)).reduce((n, r) => n + r.count, 0)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty"><h2>Начните с первой кампании</h2><p>Загрузите таблицу с контактами и текстами. Dmailio предложит шаги цепочки, а вы выберете отправителей и расписание.</p><a href="/api/template.csv">Скачать шаблон CSV</a></div>'}`,
  );
  click("new", () => {
    current = {
      name: "Новая кампания",
      status: "draft",
      mailboxIds: [],
      steps: [
        {
          subject: "",
          body: "",
          delay: 0,
          format: "markdown",
          includeSignature: true,
        },
      ],
      schedule: {
        days: [1, 2, 3, 4, 5],
        start: "09:00",
        end: "18:00",
        timezone: "Europe/Moscow",
        interval: 12,
      },
      leads: [],
      trackOpens: false,
    };
    activeTab = "leads";
    stepIndex = 0;
    importCSV = "";
    parsed = null;
    renderCampaign();
  });
  document.querySelectorAll("[data-campaign]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        current = await api("/campaigns/" + b.dataset.campaign);
        activeTab = "sequence";
        stepIndex = 0;
        importCSV = "";
        parsed = null;
        renderCampaign();
      })),
  );
}
function readEditor() {
  if (!current) return;
  const title = document.querySelector("#campaign-name");
  if (title) current.name = title.value;
  if (document.querySelector("#subject")) {
    current.steps[stepIndex].subject = document.querySelector("#subject").value;
    current.steps[stepIndex].body = document.querySelector("#body").value;
    current.steps[stepIndex].delay = Number(
      document.querySelector("#delay").value,
    );
  }
  if (document.querySelector("#schedule-start")) {
    current.mailboxIds = [
      ...document.querySelectorAll("[name=sender]:checked"),
    ].map((e) => e.value);
    current.schedule = {
      start: document.querySelector("#schedule-start").value,
      end: document.querySelector("#schedule-end").value,
      timezone: document.querySelector("#timezone").value,
      interval: Number(document.querySelector("#interval").value),
      days: [...document.querySelectorAll("[name=weekday]:checked")].map((e) =>
        Number(e.value),
      ),
    };
    current.trackOpens = document.querySelector("#track").checked;
  }
}
async function saveCampaign() {
  readEditor();
  current = await api("/campaigns", current);
  if (importCSV) {
    await api("/campaigns/" + current.id + "/import", { csv: importCSV });
    importCSV = "";
    parsed = null;
    current = await api("/campaigns/" + current.id);
  }
  state = await api("/state");
  notice("Кампания сохранена");
  renderCampaign();
}
function renderCampaign() {
  const editable = current.status === "draft";
  shell(
    `<div class="top"><div class="row"><button id="back">← Кампании</button><h1>${escape(current.name)}</h1>${badge(current.status)}</div><div class="row">${editable ? '<button id="save" class="primary">Сохранить</button>' : ""}${current.id ? `<button id="toggle" ${current.status === "completed" ? "disabled" : ""}>${current.status === "active" ? "Пауза" : "Запустить"}</button>` : ""}</div></div><div class="tabs">${[
      ["leads", "1. Лиды"],
      ["sequence", "2. Цепочка"],
      ["settings", "3. Настройки"],
      ["results", "Аналитика"],
    ]
      .map(
        ([id, name]) =>
          `<button data-tab="${id}" class="${activeTab === id ? "selected" : ""}">${name}</button>`,
      )
      .join("")}</div><div id="campaign-content"></div>`,
  );
  click("back", async () => {
    current = null;
    await refresh();
  });
  click("save", saveCampaign);
  click("toggle", async () => {
    const status = current.status === "active" ? "paused" : "active";
    if (status === "active" && current.status === "draft") await saveCampaign();
    if (
      status === "active" &&
      !confirm(
        "Запустить реальную отправку этой кампании по выбранному расписанию?",
      )
    )
      return;
    current = await api("/campaigns/" + current.id + "/status", { status });
    renderCampaign();
  });
  document.querySelectorAll("[data-tab]").forEach(
    (b) =>
      (b.onclick = action(() => {
        readEditor();
        activeTab = b.dataset.tab;
        renderCampaign();
      })),
  );
  const box = document.querySelector("#campaign-content");
  if (activeTab === "leads") {
    box.innerHTML = `<div class="panel"><h2>Контакты из таблицы</h2><p class="hint">CSV до 10 МБ и 10 000 строк. Обязателен email. Колонки «Письмо 1», «Письмо 2»… станут шагами цепочки. <a href="/api/template.csv">Скачать шаблон</a></p>${editable ? '<label>Выберите CSV<input id="csv" type="file" accept=".csv,text/csv"></label>' : ""}<div id="import-result">${parsed ? `Готово к импорту: ${parsed.contacts.length}. Ошибки: ${parsed.errors.length}. Нажмите «Сохранить».` : ""}</div></div><div class="panel table-scroll"><h2>Лиды · ${current.leads.length}</h2><table><tr><th>Email</th><th>Имя</th><th>Статус</th><th>Шаг</th><th>Следующее письмо</th></tr>${current.leads
      .slice(0, 200)
      .map(
        (l) =>
          `<tr><td>${escape(l.email)}</td><td>${escape(l.fields.name || l.fields["Имя"])}</td><td>${badge(l.status)}</td><td>${l.step + 1}</td><td>${l.status === "pending" ? date(l.due) : "—"}</td></tr>`,
      )
      .join(
        "",
      )}</table>${current.leads.length > 200 ? '<p class="hint">Показаны первые 200 контактов.</p>' : ""}</div>`;
    document.querySelector("#csv")?.addEventListener(
      "change",
      action(async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 10_000_000)
          throw new Error("Максимальный размер — 10 МБ");
        const csv = await file.text();
        parsed = await api("/import/preview", { csv });
        if (parsed.errors.length) {
          importCSV = "";
          document.querySelector("#import-result").textContent = parsed.errors
            .slice(0, 15)
            .map((r) => `Строка ${r.row}: ${r.error}`)
            .join(" · ");
          return;
        }
        importCSV = csv;
        if (parsed.steps.length)
          current.steps = parsed.steps.map((s) => ({
            ...s,
            format: "markdown",
            includeSignature: true,
          }));
        stepIndex = 0;
        renderCampaign();
      }),
    );
  }
  if (activeTab === "sequence") {
    const s = current.steps[stepIndex] || current.steps[0];
    const variables = [
      ...new Set([
        ...(parsed?.headers || Object.keys(current.leads[0]?.fields || {})),
        "Имя Отправителя",
        "Фамилия Отправителя",
        "Email Отправителя",
        "Подпись Отправителя",
      ]),
    ];
    box.innerHTML = `<div class="steps"><aside>${current.steps.map((s, i) => `<div class="step ${i === stepIndex ? "selected" : ""}"><button data-step="${i}">Письмо ${i + 1}</button><small>${i ? "Через " + s.delay + " дн." : "Начало цепочки"}</small><p>${escape(s.subject || "Тема предыдущего письма")}</p></div>`).join("")}${editable ? '<button id="add-step">+ Добавить письмо</button>' : ""}</aside><div class="panel editor"><fieldset ${editable ? "" : "disabled"}><label>Тема<input id="subject" value="${escape(s.subject)}" placeholder="${stepIndex ? "Пустая — тема предыдущего письма" : "{{Тема цепочки}}"}"></label><label>Задержка после предыдущего письма, дней<input id="delay" type="number" min="0" max="365" value="${s.delay}" ${stepIndex ? "" : "disabled"}></label><label for="body">Текст письма</label><textarea id="body" placeholder="Введите текст или {{Письмо 1}}">${escape(s.body)}</textarea><p class="hint">Переменные подставляются из строки получателя. Отправитель закрепляется за контактом на всю цепочку.</p><div class="variables">${variables.map((v) => `<button type="button" data-variable="${escape(v)}">${escape(v)}</button>`).join("")}</div></fieldset><div class="actions">${editable && current.steps.length > 1 ? '<button id="remove-step" class="danger">Удалить шаг</button>' : ""}<button id="preview" ${current.id ? "" : "disabled"}>Предпросмотр сохранённой версии</button></div></div></div>`;
    const bodyEditor = mountEditor(document.querySelector("#body"), {
      api,
      notify: notice,
      format: s.format || "plain",
      disabled: !editable,
      onFormat: (value) => {
        s.format = value;
      },
      signature: true,
      includeSignature: s.includeSignature !== false,
      onSignature: (value) => {
        s.includeSignature = value;
      },
      previewPayload: () => ({
        mailboxId: current.mailboxIds[0],
        includeSignature: s.includeSignature !== false,
      }),
    });
    document.querySelectorAll("[data-step]").forEach(
      (b) =>
        (b.onclick = () => {
          readEditor();
          stepIndex = Number(b.dataset.step);
          renderCampaign();
        }),
    );
    document.querySelectorAll("[data-variable]").forEach(
      (b) =>
        (b.onclick = () => {
          bodyEditor.insertText("{{" + b.dataset.variable + "}}");
        }),
    );
    click("add-step", () => {
      readEditor();
      if (current.steps.length >= 20) throw new Error("Максимум 20 шагов");
      current.steps.push({
        subject: "",
        body: "",
        delay: 3,
        format: "markdown",
        includeSignature: true,
      });
      stepIndex = current.steps.length - 1;
      renderCampaign();
    });
    click("remove-step", () => {
      readEditor();
      current.steps.splice(stepIndex, 1);
      stepIndex = 0;
      renderCampaign();
    });
    click("preview", preview);
  }
  if (activeTab === "settings") {
    const s = current.schedule;
    box.innerHTML = `<fieldset ${editable ? "" : "disabled"}><div class="panel"><label>Название<input id="campaign-name" value="${escape(current.name)}"></label><h2>Отправители</h2>${state.mailboxes.length ? state.mailboxes.map((m) => `<label class="check"><input name="sender" type="checkbox" value="${m.id}" ${current.mailboxIds.includes(m.id) ? "checked" : ""}>${escape(m.email)} · ${m.verified ? "подключён" : "не проверен"}</label>`).join("") : '<p class="hint">Сначала добавьте почту в разделе «Почты».</p>'}</div><div class="panel"><h2>Расписание</h2><div class="row">${["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"].map((d, i) => `<label class="check"><input type="checkbox" name="weekday" value="${i}" ${s.days.includes(i) ? "checked" : ""}>${d}</label>`).join("")}</div><div class="grid"><label>Начиная с<input id="schedule-start" type="time" value="${s.start}"></label><label>Заканчивая в<input id="schedule-end" type="time" value="${s.end}"></label><label>Часовой пояс<input id="timezone" value="${escape(s.timezone)}"></label><label>Минимум минут между отправками с ящика<input id="interval" type="number" min="1" value="${s.interval}"></label></div><label class="check"><input id="track" type="checkbox" ${current.trackOpens ? "checked" : ""}>Отслеживать открытия</label><p class="hint">Открытие — сигнал загрузки пикселя, а не гарантия прочтения. Лимит ящика общий для всех кампаний, ручных ответов и прогрева, за последние 24 часа.</p></div></fieldset>`;
  }
  if (activeTab === "results") {
    box.innerHTML = current.id
      ? "<p>Загрузка…</p>"
      : "<p>Сохраните кампанию.</p>";
    if (current.id)
      api("/analytics?campaign=" + current.id)
        .then((a) => {
          if (document.querySelector("#campaign-content") === box)
            box.innerHTML = analyticsBody(a);
        })
        .catch((e) => notice(e.message));
  }
}
async function preview() {
  const c = await api("/campaigns/" + current.id);
  dialog(
    `<h2>Предпросмотр</h2><div class="grid"><label>Лид<select id="preview-lead">${options(c.leads, "", "id", "email")}</select></label><label>Отправитель<select id="preview-sender">${options(
      state.mailboxes.filter((m) => c.mailboxIds.includes(m.id)),
      "",
      "id",
      "email",
    )}</select></label></div><button id="preview-update">Показать письмо ${stepIndex + 1}</button><div id="preview-text" class="preview"></div>`,
  );
  click("preview-update", async () => {
    const p = await api("/campaigns/" + c.id + "/preview", {
      leadId: document.querySelector("#preview-lead").value,
      mailboxId: document.querySelector("#preview-sender").value,
      step: stepIndex,
    });
    document.querySelector("#preview-text").innerHTML =
      "<h3>" +
      escape(p.subject) +
      '</h3><div class="mail-preview">' +
      p.html +
      "</div>";
  });
  document.querySelector("#preview-update").click();
}
function dialog(content) {
  document.querySelector("dialog")?.remove();
  const el = document.createElement("dialog");
  el.innerHTML = `<div class="right"><button id="close-dialog" aria-label="Закрыть">Закрыть</button></div>${content}`;
  document.body.append(el);
  el.showModal();
  click("close-dialog", () => el.remove());
  el.addEventListener("close", () => el.remove());
}
function mailboxes() {
  selectedMailboxes = new Set(
    [...selectedMailboxes].filter((id) =>
      state.mailboxes.some((m) => m.id === id),
    ),
  );
  const warmupRows = state.mailboxes.filter((m) =>
    ["warming", "waiting"].includes(m.warmupStatus),
  ).length;
  const averageWarmup = state.mailboxes.length
    ? Math.round(
        state.mailboxes.reduce((sum, m) => sum + m.warmupProgress.score, 0) /
          state.mailboxes.length,
      )
    : 0;
  shell(
    `<div class="top"><div><h1>Почты</h1><p class="hint">Подключения, прогрев и техническое состояние ящиков</p></div><button id="add-mailbox" class="primary">+ Подключить почту</button></div>${
      state.mailboxes.length
        ? `<div class="mailbox-summary" aria-label="Сводка по почтам"><div><span>Всего ящиков</span><strong>${state.mailboxes.length}</strong></div><div><span>Прогрев включён</span><strong>${warmupRows}</strong></div><div><span>Средний прогрев</span><strong>${averageWarmup}%</strong></div></div><div class="alert warmup-note"><strong>Автопрогрев</strong> рассчитан на 14 активных дней: Dmailio сам плавно увеличивает объём с 2 до 10 писем в день. Процент учитывает активные дни, выполнение плана, успешную отправку и получение писем. Это ориентир готовности, а не гарантия попадания во входящие.</div><section class="mailbox-panel"><div class="mailbox-toolbar"><label class="mailbox-search">Поиск<input id="mailbox-search" type="search" placeholder="Имя или адрес почты"></label><div class="bulk-actions"><span id="selected-count">Ничего не выбрано</span><button id="bulk-start" class="primary" disabled>Включить прогрев</button><button id="bulk-pause" disabled>Поставить на паузу</button></div></div><div class="table-scroll"><table class="mailbox-table"><thead><tr><th class="select-cell"><input id="select-all-mailboxes" type="checkbox" aria-label="Выбрать все почты"></th><th>Вкл.</th><th>Ящик</th><th>Прогрето</th><th>Отправлено</th><th>Ответы</th><th>Здоровье</th><th>Действия</th></tr></thead><tbody>${state.mailboxes
            .map(
              (m) =>
                `<tr data-mailbox-row data-search="${escape(`${m.email} ${m.name} ${m.surname}`.toLowerCase())}"><td class="select-cell"><input data-select-mailbox="${m.id}" type="checkbox" aria-label="Выбрать ${escape(m.email)}" ${selectedMailboxes.has(m.id) ? "checked" : ""}></td><td><label class="switch" title="Включить или приостановить прогрев"><input data-warmup-toggle="${m.id}" type="checkbox" ${m.warmup?.enabled ? "checked" : ""} ${!m.verified || !m.enabled ? "disabled" : ""}><span></span><b class="sr-only">Прогрев ${escape(m.email)}</b></label></td><td><button class="mailbox-name" data-mailbox-detail="${m.id}"><strong>${escape(m.email)}</strong><small>${escape([m.name, m.surname].filter(Boolean).join(" ") || "Без имени отправителя")}</small></button></td><td><button class="warmup-score" data-mailbox-detail="${m.id}" aria-label="${escape(m.email)} прогрет на ${m.warmupProgress.score} процентов"><span class="warmup-score-head"><strong>${m.warmupProgress.score}%</strong><b>${escape(m.warmupProgress.label)}</b></span><span class="progress"><span style="width:${m.warmupProgress.score}%"></span></span><small>${m.warmupStatus === "warming" ? `день ${m.warmupProgress.day} из 14 · ${m.currentWarmupLimit} ${mailWord(m.currentWarmupLimit)}/день` : escape(labels[m.warmupStatus] || m.warmupStatus)}</small>${m.error ? `<small class="error-note">${escape(m.error)}</small>` : ""}</button></td><td><strong class="stat-number">${m.warmupStats.sent}</strong><small class="cell-note">за 24 ч.: ${m.warmupStats.sent24h}</small></td><td><strong class="stat-number">${m.warmupStats.replies}</strong><small class="cell-note">за 24 ч.: ${m.warmupStats.replies24h}</small></td><td><button class="health-score ${m.health.score >= 85 ? "healthy" : m.health.score >= 60 ? "warning" : "critical"}" data-mailbox-detail="${m.id}" aria-label="Техническое здоровье ${escape(m.email)}: ${m.health.score} из 100">${m.health.score}<span>/100</span></button></td><td><div class="row-actions"><button data-signature-mailbox="${m.id}">Подпись</button><button data-mailbox-settings="${m.id}">Настройки</button><button data-verify="${m.id}">${m.verified ? "Перепроверить" : "Проверить"}</button></div></td></tr>`,
            )
            .join("")}</tbody></table></div></section>`
        : '<div class="empty"><h2>Подключите первый ящик</h2><p>SMTP отправляет письма, IMAP получает ответы. Потребуется пароль приложения вашего почтового провайдера.</p></div>'
    }`,
  );
  click("add-mailbox", () => mailboxDialog());
  const updateSelection = () => {
    const visible = [...document.querySelectorAll("[data-mailbox-row]")].filter(
      (row) => !row.hidden,
    );
    const visibleIds = visible.map(
      (row) => row.querySelector("[data-select-mailbox]").dataset.selectMailbox,
    );
    const selectedVisible = visibleIds.filter((id) =>
      selectedMailboxes.has(id),
    );
    const count = selectedMailboxes.size;
    const label = document.querySelector("#selected-count");
    if (label)
      label.textContent = count ? `Выбрано: ${count}` : "Ничего не выбрано";
    for (const id of ["bulk-start", "bulk-pause"])
      if (document.getElementById(id))
        document.getElementById(id).disabled = !count;
    const all = document.querySelector("#select-all-mailboxes");
    if (all) {
      all.checked =
        visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
      all.indeterminate =
        selectedVisible.length > 0 &&
        selectedVisible.length < visibleIds.length;
    }
  };
  document.querySelector("#mailbox-search")?.addEventListener("input", (e) => {
    const value = e.target.value.trim().toLowerCase();
    document.querySelectorAll("[data-mailbox-row]").forEach((row) => {
      row.hidden = !row.dataset.search.includes(value);
    });
    updateSelection();
  });
  document.querySelectorAll("[data-select-mailbox]").forEach((input) => {
    input.onchange = () => {
      if (input.checked) selectedMailboxes.add(input.dataset.selectMailbox);
      else selectedMailboxes.delete(input.dataset.selectMailbox);
      updateSelection();
    };
  });
  const all = document.querySelector("#select-all-mailboxes");
  if (all)
    all.onchange = () => {
      document.querySelectorAll("[data-mailbox-row]").forEach((row) => {
        if (row.hidden) return;
        const input = row.querySelector("[data-select-mailbox]");
        input.checked = all.checked;
        if (all.checked) selectedMailboxes.add(input.dataset.selectMailbox);
        else selectedMailboxes.delete(input.dataset.selectMailbox);
      });
      updateSelection();
    };
  const bulk = async (enabled) => {
    if (
      enabled &&
      !confirm(
        "Включить контрольную переписку выбранных ящиков? Вы подтверждаете согласие их владельцев на обмен письмами внутри команды.",
      )
    )
      return;
    await api("/mailboxes/warmup/bulk", {
      ids: [...selectedMailboxes],
      enabled,
    });
    selectedMailboxes.clear();
    await refresh();
    notice(enabled ? "Прогрев включён" : "Прогрев поставлен на паузу");
  };
  click("bulk-start", () => bulk(true));
  click("bulk-pause", () => bulk(false));
  document.querySelectorAll("[data-warmup-toggle]").forEach((input) => {
    input.onchange = action(async () => {
      const m = state.mailboxes.find(
        (row) => row.id === input.dataset.warmupToggle,
      );
      const enabled = input.checked;
      if (
        enabled &&
        !confirm(
          `Включить контрольную переписку для ${m.email}? Вы подтверждаете согласие владельца ящика.`,
        )
      ) {
        input.checked = false;
        return;
      }
      try {
        await api("/mailboxes/" + m.id + "/warmup", {
          ...m.warmup,
          enabled,
          consent: enabled ? true : m.warmup.consent,
        });
      } catch (error) {
        input.checked = !enabled;
        throw error;
      }
      await refresh();
      notice(enabled ? "Прогрев включён" : "Прогрев поставлен на паузу");
    });
  });
  document.querySelectorAll("[data-mailbox-detail]").forEach((button) => {
    button.onclick = action(async () => {
      mailboxDetailId = button.dataset.mailboxDetail;
      mailboxDetailTab = "stats";
      await renderMailboxDetail();
    });
  });
  document.querySelectorAll("[data-mailbox-settings]").forEach((button) => {
    button.onclick = action(async () => {
      mailboxDetailId = button.dataset.mailboxSettings;
      mailboxDetailTab = "settings";
      await renderMailboxDetail();
    });
  });
  document
    .querySelectorAll("[data-signature-mailbox]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          signatureDialog(
            state.mailboxes.find((m) => m.id === b.dataset.signatureMailbox),
          )),
    );
  document
    .querySelectorAll("[data-edit-mailbox]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          mailboxDialog(
            state.mailboxes.find((m) => m.id === b.dataset.editMailbox),
          )),
    );
  document.querySelectorAll("[data-verify]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        b.disabled = true;
        b.textContent = "Проверка…";
        try {
          await api("/mailboxes/" + b.dataset.verify + "/verify", {});
          notice("SMTP и IMAP подключены");
        } finally {
          await refresh();
        }
      })),
  );
  updateSelection();
}

const providerNames = {
  google: "Google / Gmail",
  yandex: "Яндекс",
  mailru: "Mail.ru / VK Workspace",
  other: "Другие SMTP",
};

async function renderMailboxDetail() {
  const detail = await api(`/mailboxes/${mailboxDetailId}/detail`);
  if (mailboxDetailId !== detail.mailbox.id) return;
  const m = detail.mailbox;
  shell(
    `<div class="mailbox-detail-head"><div><button id="mailbox-back" class="back-link">← Все почты</button><h1>${escape(m.email)}</h1><p class="hint">${escape([m.name, m.surname].filter(Boolean).join(" ") || "Имя отправителя не задано")}</p></div><button id="detail-warmup-toggle" class="primary" ${!m.verified || !m.enabled ? "disabled" : ""}>${m.warmup.enabled ? "Поставить прогрев на паузу" : "Запустить прогрев"}</button></div><div class="tabs detail-tabs">${[
      ["stats", "Статистика прогрева"],
      ["dns", "DNS-записи"],
      ["settings", "Настройки"],
    ]
      .map(
        ([id, title]) =>
          `<button data-detail-tab="${id}" class="${mailboxDetailTab === id ? "selected" : ""}">${title}</button>`,
      )
      .join("")}</div><div id="mailbox-detail-content"></div>`,
  );
  click("mailbox-back", () => {
    mailboxDetailId = "";
    mailboxes();
  });
  click("detail-warmup-toggle", async () => {
    const enabled = !m.warmup.enabled;
    if (
      enabled &&
      !confirm(
        "Включить контрольную переписку? Вы подтверждаете согласие владельца ящика.",
      )
    )
      return;
    await api(`/mailboxes/${m.id}/warmup`, {
      ...m.warmup,
      enabled,
      consent: enabled ? true : m.warmup.consent,
    });
    await refresh();
    notice(enabled ? "Прогрев включён" : "Прогрев поставлен на паузу");
  });
  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.onclick = action(async () => {
      mailboxDetailTab = button.dataset.detailTab;
      await renderMailboxDetail();
    });
  });
  if (mailboxDetailTab === "stats") renderMailboxStats(detail);
  if (mailboxDetailTab === "settings") renderMailboxSettings(m);
  if (mailboxDetailTab === "dns") await renderMailboxDNS(m);
}

function renderMailboxStats(detail) {
  const m = detail.mailbox;
  const maxActivity = Math.max(
    1,
    ...detail.activity.flatMap((day) => [
      day.sent + day.replies,
      day.inbox + day.spam + day.promotions + day.unknown,
      day.rescued,
    ]),
  );
  const content = document.querySelector("#mailbox-detail-content");
  content.innerHTML = `<div class="detail-metrics"><div class="detail-metric accent"><span>Прогрето</span><strong>${m.warmupProgress.score}%</strong><small>${escape(m.warmupProgress.label)} · день ${m.warmupProgress.day} из 14</small></div><div class="detail-metric"><span>Здоровье ящика</span><strong>${m.health.score}</strong><small>Техническая оценка из 100</small></div><div class="detail-metric"><span>Отправлено писем</span><strong>${detail.summary.sent}</strong><small>Внутри прогрева</small></div><div class="detail-metric"><span>Получено ответов</span><strong>${detail.summary.replies}</strong><small>Ответы между ящиками</small></div><div class="detail-metric"><span>Спасено из спама</span><strong>${detail.summary.rescued}</strong><small>Перенесено во входящие</small></div></div>${m.error ? `<div class="alert connection-error">${escape(m.error)}</div>` : ""}<section class="panel"><div class="section-head"><div><h2>Активность за 30 дней</h2><p class="hint">Реальные результаты контрольных писем прогрева</p></div><div class="chart-legend"><span class="sent-dot">Отправлено</span><span class="reply-dot">Ответы</span><span class="inbox-dot">Входящие</span><span class="promo-dot">Промоакции</span><span class="spam-dot">Спам</span><span class="unknown-dot">Нет данных</span><span class="rescued-dot">Спасено</span></div></div><div class="activity-chart" aria-label="Активность прогрева за 30 дней">${detail.activity
    .map((day, index) => {
      const traffic = day.sent + day.replies;
      const placement = day.inbox + day.promotions + day.spam + day.unknown;
      const percent = (value, total) =>
        total ? Math.round((value / total) * 100) : 0;
      const bar = (kind, total, parts) =>
        `<div class="activity-bar ${total ? "" : "empty-bar"}" style="height:${Math.max(2, Math.round((total / maxActivity) * 150))}px" aria-label="${kind}">${parts.join("")}</div>`;
      const trafficBar = bar("Отправлено и ответы", traffic, [
        `<span class="bar-sent" style="height:${percent(day.sent, traffic)}%"></span>`,
        `<span class="bar-replies" style="height:${percent(day.replies, traffic)}%"></span>`,
      ]);
      const placementBar = bar("Размещение", placement, [
        `<span class="bar-inbox" style="height:${percent(day.inbox, placement)}%"></span>`,
        `<span class="bar-promotions" style="height:${percent(day.promotions, placement)}%"></span>`,
        `<span class="bar-spam" style="height:${percent(day.spam, placement)}%"></span>`,
        `<span class="bar-unknown" style="height:${percent(day.unknown, placement)}%"></span>`,
      ]);
      const rescuedBar = bar("Спасено", day.rescued, [
        `<span class="bar-rescued" style="height:${day.rescued ? 100 : 0}%"></span>`,
      ]);
      return `<div class="activity-day" title="${escape(day.date)} · отправлено ${day.sent}, ответы ${day.replies}, входящие ${day.inbox}, промоакции ${day.promotions}, спам ${day.spam}, нет данных ${day.unknown}, спасено ${day.rescued}"><div class="activity-pair">${trafficBar}${placementBar}${rescuedBar}</div>${index % 5 === 0 || index === 29 ? `<small>${new Date(day.date).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</small>` : "<small></small>"}</div>`;
    })
    .join(
      "",
    )}</div>${detail.activity.every((day) => !day.sent && !day.replies && !day.inbox && !day.spam && !day.promotions && !day.unknown && !day.rescued) ? '<p class="chart-empty">Данные появятся после первых контрольных писем.</p>' : ""}</section><section class="panel"><h2>Статистика по почтовым провайдерам</h2><p class="hint">Показываем только проверенные Dmailio письма. Личные сообщения не читаются.</p>${
    detail.providers.length
      ? `<div class="provider-list">${detail.providers
          .map((row) => {
            const value = (n) => Math.round((n / row.total) * 100);
            return `<div class="provider-row"><strong>${escape(providerNames[row.provider] || row.provider)}</strong><div class="provider-bar" title="Входящие ${row.inbox}, промоакции ${row.promotions}, спам ${row.spam}, нет данных ${row.unknown}"><span class="bar-inbox" style="width:${value(row.inbox)}%"></span><span class="bar-promotions" style="width:${value(row.promotions)}%"></span><span class="bar-spam" style="width:${value(row.spam)}%"></span><span class="bar-unknown" style="width:${value(row.unknown)}%"></span></div><span>${value(row.inbox)}% входящих · без данных ${row.unknown}</span></div>`;
          })
          .join("")}</div>`
      : '<div class="soft-empty">Пока нет проверенных доставок по провайдерам.</div>'
  }</section><section class="panel"><h2>Как считается здоровье</h2>${healthBody(m)}</section>`;
}

async function renderMailboxDNS(m) {
  const content = document.querySelector("#mailbox-detail-content");
  content.innerHTML =
    '<div class="panel"><p>Проверяем DNS-записи домена…</p></div>';
  const dns = await api(`/mailboxes/${m.id}/dns`);
  if (mailboxDetailTab !== "dns" || mailboxDetailId !== m.id) return;
  const records = [
    ["MX", dns.mx, "Куда почтовые сервисы доставляют входящие письма"],
    ["DMARC", dns.dmarc, "Политика проверки и защиты домена"],
    ["DKIM", dns.dkim, "Криптографическая подпись исходящих писем"],
    ["SPF", dns.spf, "Каким серверам разрешено отправлять письма"],
  ];
  content.innerHTML = `<div class="dns-intro"><strong>${escape(dns.domain)}</strong><span>Проверено ${date(dns.checkedAt)}</span></div><div class="dns-grid">${records
    .map(([name, record, help]) => {
      const ok = record?.status === "ok";
      const text =
        record?.values?.length > 0
          ? record.values.join("\n")
          : record?.status === "unavailable"
            ? record.error || "Проверка временно недоступна"
            : "Запись не найдена";
      return `<article class="dns-card"><div class="section-head"><h2>${name}</h2><span class="dns-status ${ok ? "ok" : record?.status || "missing"}">${ok ? "Всё хорошо" : record?.status === "unavailable" ? "Не удалось проверить" : "Нужно настроить"}</span></div><p class="hint">${help}</p><pre>${escape(text)}</pre>${name === "DKIM" && record?.selector ? `<small>Селектор: ${escape(record.selector)}</small>` : ""}</article>`;
    })
    .join("")}</div>`;
}

function renderMailboxSettings(m) {
  const content = document.querySelector("#mailbox-detail-content");
  const custom = m.warmup.mode === "custom";
  content.innerHTML = `<section class="panel"><div class="section-head"><div><h2>Настройки ящика</h2><p class="hint">Имя отправителя и общий суточный лимит кампаний, ответов и прогрева</p></div><button id="connection-settings">Подключение SMTP / IMAP</button></div><form id="mailbox-profile-form"><div class="grid"><label>Имя отправителя<input name="name" maxlength="100" value="${escape(m.name)}"></label><label>Фамилия отправителя<input name="surname" maxlength="100" value="${escape(m.surname)}"></label></div><div class="grid"><label>Лимит отправки за 24 часа <span class="recommended">рекомендуется 30</span><input name="limit" type="number" min="1" max="10000" value="${m.limit}" required></label><label>Селектор DKIM <span class="recommended">если известен</span><input name="dkimSelector" value="${escape(m.dkimSelector || "")}" placeholder="default"></label></div><div class="actions"><button class="primary">Сохранить настройки</button></div></form></section><section class="panel"><h2>Подпись</h2><p class="hint">Она автоматически добавляется к письмам этого ящика. Поддерживаются Markdown, ссылки, картинки и загрузка .md.</p><form id="detail-signature-form"><label for="detail-signature-body">Текст подписи</label><textarea id="detail-signature-body" maxlength="20000" placeholder="С уважением,&#10;Ваше имя&#10;Telegram и другие контакты">${escape(m.signature || "")}</textarea><label class="check"><input id="detail-signature-enabled" type="checkbox" ${m.signatureEnabled !== false ? "checked" : ""}>Автоматически добавлять подпись</label><div class="actions"><button type="button" id="detail-signature-example">Вставить пример</button><button class="primary">Сохранить подпись</button></div></form></section><section class="panel warmup-settings-panel"><div class="section-head"><div><h2>Настройки прогрева</h2><p class="hint">Автоматический прогрев уже полностью настроен. Меняйте параметры только если нужен свой сценарий.</p></div><button id="reset-warmup">Сбросить к автоматическим</button></div><form id="detail-warmup-form"><label class="check"><input name="enabled" type="checkbox" ${m.warmup.enabled ? "checked" : ""} ${!m.verified || !m.enabled ? "disabled" : ""}>Прогрев включён</label><label class="check"><input id="custom-warmup" name="custom" type="checkbox" ${custom ? "checked" : ""}>Настроить объём вручную</label><div id="warmup-fields" class="grid ${custom ? "" : "fields-disabled"}"><label>Начинать с, писем/день<input name="start" type="number" min="1" max="100" value="${m.warmup.start}" ${custom ? "" : "disabled"}></label><label>Увеличивать на, писем/день<input name="increase" type="number" min="1" max="100" value="${m.warmup.increase}" ${custom ? "" : "disabled"}></label><label>Максимум, писем/день<input name="max" type="number" min="1" max="100" value="${m.warmup.max}" ${custom ? "" : "disabled"}></label><fieldset class="provider-options"><legend>Почтовые сервисы</legend>${Object.entries(
    providerNames,
  )
    .map(
      ([id, name]) =>
        `<label class="check"><input name="provider" type="checkbox" value="${id}" ${m.warmup.providers.includes(id) ? "checked" : ""} ${custom ? "" : "disabled"}>${name}</label>`,
    )
    .join(
      "",
    )}</fieldset></div><p class="hint">Автоматический план: 14 активных дней, старт 2 письма, рост на 1 до максимума 10. Сброс не стирает уже набранный прогресс.</p><div class="actions"><button class="primary">Сохранить прогрев</button></div></form></section>`;
  click("connection-settings", () => mailboxDialog(m));
  document.querySelector("#mailbox-profile-form").onsubmit = action(
    async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      await api(`/mailboxes/${m.id}/settings`, {
        name: data.get("name"),
        surname: data.get("surname"),
        limit: Number(data.get("limit")),
        dkimSelector: data.get("dkimSelector"),
      });
      await refresh();
      notice("Настройки ящика сохранены");
    },
  );
  let signatureFormat = m.signatureFormat || "markdown";
  const signatureArea = document.querySelector("#detail-signature-body");
  const signatureEditor = mountEditor(signatureArea, {
    api,
    notify: notice,
    format: signatureFormat,
    onFormat: (value) => {
      signatureFormat = value;
    },
  });
  click("detail-signature-example", async () => {
    if (signatureArea.value.trim() && !confirm("Заменить подпись примером?"))
      return;
    signatureArea.value = `С уважением,\n**${[m.name, m.surname].filter(Boolean).join(" ") || "Ваше имя"}**\n\n[${m.email}](mailto:${m.email}) · [Telegram](https://t.me/username)`;
    await signatureEditor.setContent(signatureArea.value);
  });
  document.querySelector("#detail-signature-form").onsubmit = action(
    async (event) => {
      event.preventDefault();
      await api(`/mailboxes/${m.id}/signature`, {
        body: signatureArea.value,
        format: signatureFormat,
        enabled: document.querySelector("#detail-signature-enabled").checked,
      });
      await refresh();
      notice("Подпись сохранена");
    },
  );
  const customInput = document.querySelector("#custom-warmup");
  customInput.onchange = () => {
    const enabled = customInput.checked;
    document
      .querySelector("#warmup-fields")
      .classList.toggle("fields-disabled", !enabled);
    document
      .querySelectorAll("#warmup-fields input")
      .forEach((input) => (input.disabled = !enabled));
  };
  document.querySelector("#detail-warmup-form").onsubmit = action(
    async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      const enabled = data.has("enabled");
      if (
        enabled &&
        !m.warmup.enabled &&
        !confirm("Включить реальную контрольную переписку этого ящика?")
      )
        return;
      await api(`/mailboxes/${m.id}/warmup`, {
        enabled,
        consent: enabled ? true : m.warmup.consent,
        mode: data.has("custom") ? "custom" : "automatic-v1",
        start: Number(data.get("start") || 2),
        increase: Number(data.get("increase") || 1),
        max: Number(data.get("max") || 10),
        providers: data.getAll("provider").length
          ? data.getAll("provider")
          : m.warmup.providers,
      });
      await refresh();
      notice("Настройки прогрева сохранены");
    },
  );
  click("reset-warmup", async () => {
    if (!confirm("Вернуть автоматический план 2 → +1 → максимум 10?")) return;
    await api(`/mailboxes/${m.id}/warmup`, {
      enabled: m.warmup.enabled,
      consent: m.warmup.consent,
      reset: true,
    });
    await refresh();
    notice("Автоматические настройки восстановлены");
  });
}

function healthBody(m) {
  const parts = [
    ["Подключение", m.health.parts.connection, 40],
    ["Синхронизация IMAP", m.health.parts.sync, 25],
    ["Успешная отправка", m.health.parts.sending, 20],
    ["Получение прогревочных писем", m.health.parts.receiving, 15],
  ];
  return `<div class="health-total"><strong>${m.health.score}</strong><span>из 100</span></div><div class="health-parts">${parts.map(([name, value, max]) => `<div><div class="row spaced"><span>${name}</span><strong>${value}/${max}</strong></div><div class="progress"><span style="width:${Math.round((value / max) * 100)}%"></span></div></div>`).join("")}</div><p class="hint">Это техническая оценка Dmailio: подключение, свежесть синхронизации и результаты контрольного обмена. Она не измеряет репутацию домена и не гарантирует попадание во входящие.</p>`;
}

function healthDialog(m) {
  dialog(
    `<h2>Здоровье · ${escape(m.email)}</h2>${m.error ? `<div class="alert connection-error"><strong>Ошибка подключения</strong><br>${escape(m.error)}</div>` : ""}${healthBody(m)}`,
  );
}

function warmupProgressBody(m) {
  const parts = [
    ["Активные дни", m.warmupProgress.parts.duration, 40],
    ["Выполнение плана", m.warmupProgress.parts.plan, 25],
    ["Успешная отправка", m.warmupProgress.parts.sending, 20],
    ["Получение писем", m.warmupProgress.parts.receiving, 15],
  ];
  return `<div class="readiness-total"><strong>${m.warmupProgress.score}%</strong><div><b>${escape(m.warmupProgress.label)}</b><span>День ${m.warmupProgress.day} из ${m.warmupProgress.totalDays} · план на сегодня ${m.warmupProgress.target} ${mailWord(m.warmupProgress.target)}</span></div></div><div class="health-parts">${parts.map(([name, value, max]) => `<div><div class="row spaced"><span>${name}</span><strong>${value}/${max}</strong></div><div class="progress"><span style="width:${Math.round((value / max) * 100)}%"></span></div></div>`).join("")}</div><div class="warmup-scale"><span><b>0–19%</b> Старт</span><span><b>20–39%</b> Набирает историю</span><span><b>40–59%</b> Прогревается</span><span><b>60–79%</b> Хорошая динамика</span><span><b>80–94%</b> Хорошо прогрет</span><span><b>95–100%</b> Высокий прогрев</span></div><p class="hint">Процент растёт только при реальной отправке по автоматическому плану. Пауза останавливает день программы. Оценка не гарантирует доставку будущих кампаний во входящие.</p>`;
}

function warmupDialog(m) {
  dialog(
    `<h2>Прогрев · ${escape(m.email)}</h2><div class="warmup-dialog-summary"><div><span>Режим</span><strong>Автоматический</strong></div><div><span>Отправлено</span><strong>${m.warmupStats.sent}</strong></div><div><span>Ответы</span><strong>${m.warmupStats.replies}</strong></div></div>${warmupProgressBody(m)}<form id="warmup-settings-form"><label class="check"><input name="enabled" type="checkbox" ${m.warmup.enabled ? "checked" : ""} ${!m.verified || !m.enabled ? "disabled" : ""}>Автоматический прогрев включён</label><p class="hint">Dmailio сам задаёт объём: 2 письма в день на старте и плавный рост до 10 писем к концу двух недель.</p><div class="actions"><button class="primary">Сохранить</button></div></form>`,
  );
  document.querySelector("#warmup-settings-form").onsubmit = action(
    async (e) => {
      e.preventDefault();
      const data = new FormData(e.target);
      const enabled = data.has("enabled");
      if (
        enabled &&
        !m.warmup.enabled &&
        !confirm(
          "Включить реальную контрольную переписку этого ящика с другими участниками прогрева?",
        )
      )
        return;
      await api("/mailboxes/" + m.id + "/warmup", {
        enabled,
        consent: enabled ? true : m.warmup.consent,
      });
      document.querySelector("dialog").remove();
      await refresh();
      notice("Настройки прогрева сохранены");
    },
  );
}
function signatureDialog(m) {
  let format = m.signatureFormat || (m.signature ? "plain" : "markdown");
  dialog(
    `<h2>Подпись · ${escape(m.email)}</h2><p class="hint">Добавляется в кампании и ответы от этого ящика. Внутри письма её можно отключить.</p><form id="signature-form"><label for="signature-body">Текст подписи</label><textarea id="signature-body" maxlength="20000" placeholder="С уважением,&#10;Ваше имя&#10;Контакты и ссылки">${escape(m.signature)}</textarea><label class="check"><input id="signature-enabled" type="checkbox" ${m.signatureEnabled !== false ? "checked" : ""}>Автоматически добавлять подпись</label><div class="actions"><button type="button" id="signature-example">Вставить пример</button><button class="primary">Сохранить подпись</button></div></form>`,
  );
  const area = document.querySelector("#signature-body");
  const signatureEditor = mountEditor(area, {
    api,
    notify: notice,
    format,
    onFormat: (value) => {
      format = value;
    },
  });
  click("signature-example", async () => {
    if (area.value.trim() && !confirm("Заменить подпись примером?")) return;
    area.value = `С уважением,\n**${[m.name, m.surname].filter(Boolean).join(" ") || "Ваше имя"}**\n\n[${m.email}](mailto:${m.email}) · [Telegram](https://t.me/username)\n[Сайт](https://example.com)`;
    await signatureEditor.setContent(area.value);
  });
  document.querySelector("#signature-form").onsubmit = action(async (e) => {
    e.preventDefault();
    await api("/mailboxes/" + m.id + "/signature", {
      body: area.value,
      format,
      enabled: document.querySelector("#signature-enabled").checked,
    });
    document.querySelector("dialog").remove();
    await refresh();
    notice("Подпись сохранена. Подключение почты не изменилось.");
  });
}
function mailboxDialog(
  m = {
    email: "",
    name: "",
    surname: "",
    signature: "",
    limit: 30,
    smtp: { host: "", port: 465, user: "", secure: true },
    imap: { host: "", port: 993, user: "", secure: true },
  },
) {
  dialog(
    `<h2>${m.id ? "Настройки ящика" : "Подключить почту"}</h2><form id="mailbox-form"><label>Провайдер<select id="provider"><option value="custom">Другой / IMAP + SMTP</option value="yandex">Яндекс 360</option><option value="google">Google Workspace</option><option value="vk">VK Workspace</option></select></label><div class="grid"><label>Email<input name="email" type="email" required value="${escape(m.email)}"></label><label>Лимит за 24 часа<input name="limit" type="number" min="1" max="10000" value="${m.limit}" required></label><label>Имя<input name="name" value="${escape(m.name)}"></label><label>Фамилия<input name="surname" value="${escape(m.surname)}"></label></div><p class="hint">Оформление подписи доступно отдельно: «Почты → Подпись».</p>${["smtp", "imap"].map((t) => `<h3>${t.toUpperCase()}</h3><div class="grid"><label>Сервер<input name="${t}Host" required value="${escape(m[t].host)}"></label><label>Порт<input name="${t}Port" type="number" required value="${m[t].port}"></label><label>Логин<input name="${t}User" value="${escape(m[t].user)}" placeholder="По умолчанию email"></label><label>Пароль приложения<input name="${t}Password" type="password" autocomplete="new-password" ${m.id ? "" : "required"} placeholder="${m.id ? "Пусто — сохранить текущий" : ""}"></label></div><label class="check"><input name="${t}Secure" type="checkbox" ${m[t].secure ? "checked" : ""}>TLS сразу при подключении (без галочки — обязательный STARTTLS)</label>`).join("")}<p class="hint">Пресет заполняет серверы. Пароль приложения и доступ IMAP нужно включить у провайдера. OAuth пока не поддерживается.</p><div class="actions"><button class="primary">Сохранить подключение</button></div></form>`,
  );
  document.querySelector("#provider").onchange = (e) => {
    const presets = {
      yandex: ["smtp.yandex.ru", "imap.yandex.ru"],
      google: ["smtp.gmail.com", "imap.gmail.com"],
      vk: ["smtp.mail.ru", "imap.mail.ru"],
    };
    const p = presets[e.target.value];
    if (p)
      for (const [i, t] of ["smtp", "imap"].entries()) {
        document.querySelector(`[name=${t}Host]`).value = p[i];
        document.querySelector(`[name=${t}Port]`).value = i ? 993 : 465;
        document.querySelector(`[name=${t}Secure]`).checked = true;
      }
  };
  document.querySelector("#mailbox-form").onsubmit = action(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const input = {
      id: m.id,
      email: f.get("email"),
      name: f.get("name"),
      surname: f.get("surname"),
      limit: Number(f.get("limit")),
    };
    for (const t of ["smtp", "imap"])
      input[t] = {
        host: f.get(t + "Host"),
        port: Number(f.get(t + "Port")),
        user: f.get(t + "User"),
        password: f.get(t + "Password"),
        secure: f.has(t + "Secure"),
      };
    await api("/mailboxes", input);
    document.querySelector("dialog").remove();
    await refresh();
    notice("Сохранено. Нажмите «Проверить» перед отправкой.");
  });
}
async function inbox() {
  const threads = await api("/inbox?campaign=" + inboxCampaign);
  shell(
    `<div class="top"><div><h1>Инбокс</h1><p class="hint">Ответы на ваши кампании и история переписки</p></div><select id="inbox-filter"><option value="">Все кампании</option>${options(state.campaigns, inboxCampaign)}</select></div><div class="inbox"><aside>${threads.length ? threads.map((t) => `<button class="thread-button" data-thread="${t.id}"><strong>${escape(t.email)}</strong><small>${escape(t.campaign)}</small><small>${date(t.updated)} · ${escape(labels[t.label])}</small></button>`).join("") : '<div class="panel"><h2>Ответов пока нет</h2><p class="hint">Связанные с кампаниями ответы появятся после синхронизации почт.</p></div>'}</aside><div id="thread"><div class="empty"><h2>Выберите диалог</h2></div></div></div>`,
  );
  document.querySelector("#inbox-filter").onchange = action(async (e) => {
    inboxCampaign = e.target.value;
    threadId = "";
    await inbox();
  });
  document.querySelectorAll("[data-thread]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        threadId = b.dataset.thread;
        await showThread(threads.find((t) => t.id === threadId));
      })),
  );
  if (threadId && threads.some((t) => t.id === threadId))
    await showThread(threads.find((t) => t.id === threadId));
}
async function showThread(t) {
  const messages = await api("/threads/" + t.id);
  document.querySelector("#thread").innerHTML =
    `<div class="panel row spaced"><strong>${escape(t.email)}</strong><select id="thread-label">${options(
      Object.entries(labels)
        .filter(([id]) =>
          ["new", "interested", "closed", "not_interested"].includes(id),
        )
        .map(([id, name]) => ({ id, name })),
      t.label,
    )}</select></div>${messages.map((m) => `<article class="message ${m.direction}"><div class="row spaced"><strong>${escape(m.direction === "in" ? m.recipient : m.sender)}</strong><span class="hint">${date(m.created)} · ${escape(labels[m.kind] || m.kind)}</span></div><h3>${escape(m.subject)}</h3><div class="mail-preview">${m.html}</div>${badge(m.status)}</article>`).join("")}<form id="reply" class="panel"><h2>Ответить</h2><label for="reply-body">Текст ответа</label><textarea id="reply-body" name="body" required></textarea><div class="actions"><button class="primary">Отправить ответ</button></div></form>`;
  let replyFormat = "markdown",
    replySignature = true;
  mountEditor(document.querySelector("#reply-body"), {
    api,
    notify: notice,
    format: replyFormat,
    onFormat: (value) => {
      replyFormat = value;
    },
    signature: true,
    onSignature: (value) => {
      replySignature = value;
    },
    previewPayload: () => ({
      mailboxId: messages[0]?.mailbox_id,
      includeSignature: replySignature,
    }),
  });
  document.querySelector("#thread-label").onchange = action(async (e) => {
    await api("/threads/" + t.id + "/label", { status: e.target.value });
    notice("Статус обновлён");
  });
  document.querySelector("#reply").onsubmit = action(async (e) => {
    e.preventDefault();
    if (!confirm("Отправить этот ответ адресату " + t.email + "?")) return;
    const result = await api("/threads/" + t.id + "/reply", {
      body: new FormData(e.target).get("body"),
      format: replyFormat,
      includeSignature: replySignature,
    });
    notice(result.status === "sent" ? "Ответ отправлен" : result.error);
    await showThread(t);
  });
}
function analyticsBody(a) {
  return `<div class="metrics">${[
    ["Связались", a.contacted],
    ["Отправлено", a.sent],
    ["Ответили", a.replies],
    ["Открытия", a.opens],
    ["Недоставки", a.bounces],
  ]
    .map(
      ([label, n]) =>
        `<div class="metric"><span class="hint">${label}</span><strong>${n}</strong></div>`,
    )
    .join(
      "",
    )}</div>${a.uncertain ? `<div class="alert">${a.uncertain} отправок с неизвестным результатом. Сверьтесь с журналом почтового провайдера. Затем подтвердите отправку или остановите цепочку в журнале ниже. Повторной отправки этого письма не будет.</div>` : ""}<div class="panel"><h2>Результаты шагов</h2><table><tr><th>Письмо</th><th>Отправлено</th><th>Ответы на шаг</th></tr>${a.steps.map((s) => `<tr><td>Письмо ${s.step}</td><td>${s.sent}</td><td>${s.replies}</td></tr>`).join("")}</table></div><div class="panel table-scroll"><h2>Журнал · последние 200 событий</h2><table><tr><th>Время</th><th>Получатель</th><th>Тип</th><th>Результат</th></tr>${a.events.map((e) => `<tr><td>${date(e.created)}</td><td>${escape(e.recipient)}</td><td>${escape(labels[e.kind] || e.kind)}</td><td>${badge(e.status)}${e.status === "unknown" ? `<p><button data-resolve='${e.id}' data-outcome='sent'>Подтвердить отправку</button> <button data-resolve='${e.id}' data-outcome='cancel'>Остановить</button></p>` : ""}<p class="hint">${escape(e.error)}</p></td></tr>`).join("")}</table></div><p class="hint">«Связались» и «Ответили» — уникальные контакты кампаний. «Отправлено» — сообщения, принятые SMTP. Открытия — уникальные сообщения с загрузкой пикселя. Прогрев исключён.</p>`;
}
async function analytics() {
  const a = await api("/analytics?campaign=" + analyticsCampaign);
  shell(
    `<div class="top"><h1>Аналитика</h1><div class="row"><select id="analytics-filter"><option value="">Все кампании</option>${options(state.campaigns, analyticsCampaign)}</select><button id="export">Экспорт JSON</button></div></div>${analyticsBody(a)}`,
  );
  document.querySelector("#analytics-filter").onchange = action(async (e) => {
    analyticsCampaign = e.target.value;
    await analytics();
  });
  click("export", () => {
    const blob = new Blob([JSON.stringify(a, null, 2)], {
      type: "application/json",
    });
    const aTag = document.createElement("a");
    aTag.href = URL.createObjectURL(blob);
    aTag.download = "dmailio-analytics.json";
    aTag.click();
    setTimeout(() => URL.revokeObjectURL(aTag.href), 1000);
  });
}
refresh().catch((e) => {
  if (!document.querySelector(".login")) notice(e.message);
});

root.addEventListener(
  "click",
  action(async (e) => {
    const b = e.target.closest("[data-resolve]");
    if (!b) return;
    const text =
      b.dataset.outcome === "sent"
        ? "Вы проверили журнал провайдера и подтверждаете отправку? Следующие шаги будут отсчитываться от момента подтверждения."
        : "Остановить эту цепочку без повторной отправки?";
    if (!confirm(text)) return;
    await api("/messages/" + b.dataset.resolve + "/resolve", {
      outcome: b.dataset.outcome,
    });
    await refresh();
    notice("Результат сверки сохранён");
  }),
);
