const MAX_ATTACHMENTS = 8 * 1024 * 1024;

export function parseRecipients(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[;,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function replyRecipients(message, mailboxEmail, all = false) {
  const addresses = (value) =>
    (Array.isArray(value) ? value : [value]).filter(Boolean);
  const own = String(mailboxEmail || "")
    .trim()
    .toLowerCase();
  const key = (s) =>
    String(s)
      .match(/<([^>]+)>/)?.[1]
      ?.trim()
      .toLowerCase() || String(s).trim().toLowerCase();
  const unique = (values) => [
    ...new Set(values.map(key).filter((s) => s && s !== own)),
  ];
  const to =
    message.direction === "out"
      ? unique(addresses(message.to))
      : unique([
          ...addresses(
            message.replyTo?.length ? message.replyTo : message.from,
          ),
          ...(all ? addresses(message.to) : []),
        ]);
  return {
    to,
    cc: all
      ? unique(addresses(message.cc)).filter(
          (s) => !to.some((t) => key(t) === key(s)),
        )
      : [],
  };
}

export async function mountFullInbox({
  api,
  root,
  mailboxes = [],
  campaigns = [],
  escape,
  date,
  notice,
}) {
  const e = escape;
  const state = {
    view: "inbox",
    mailboxId: "",
    folder: "",
    campaign: "",
    kind: "",
    search: "",
    page: 1,
    pageSize: 30,
  };
  let folders = [],
    loadVersion = 0,
    detailVersion = 0,
    compose = null;
  const label = {
    draft: "Черновик",
    sent: "Отправлено",
    unknown: "Результат отправки неизвестен",
    pending: "В очереди",
    sending: "Отправляется",
    failed: "Ошибка отправки",
    received: "Получено",
    mail: "Обычное",
    warmup: "Прогрев",
    campaign: "Кампания",
    reply: "Ответ",
    bounce: "Недоставка",
  };
  const opts = (items, selected) =>
    items
      .map(
        ([value, text]) =>
          `<option value="${e(value)}" ${String(value) === String(selected) ? "selected" : ""}>${e(text)}</option>`,
      )
      .join("");
  const error = (err) => notice(err.message || String(err));
  const run = (fn) => async (event) => {
    try {
      await fn(event);
    } catch (err) {
      error(err);
    }
  };
  root.innerHTML = `<div class="full-inbox"><div class="top"><div><h1>Почта</h1><p class="hint">Все письма подключённых ящиков, включая прогрев</p></div><button class="primary" data-new>Написать письмо</button></div><div class="actions" data-views>${[
    ["inbox", "Полученные"],
    ["sent", "Отправленные"],
    ["drafts", "Черновики"],
  ]
    .map(
      ([v, t]) =>
        `<button data-view="${v}" aria-pressed="${v === state.view}">${t}</button>`,
    )
    .join(
      "",
    )}<button data-refresh>Обновить</button></div><div class="panel full-mail-filters"><label>Ящик<select data-filter="mailboxId">${opts([["", "Все ящики"], ...mailboxes.map((m) => [m.id, m.email])], "")}</select></label><label>Папка<select data-filter="folder"><option value="">Все папки</option></select></label><label>Кампания<select data-filter="campaign">${opts([["", "Все кампании"], ...campaigns.map((c) => [c.id, c.name])], "")}</select></label><label>Тип<select data-filter="kind">${opts(
    [
      ["", "Все типы"],
      ["mail", "Обычные"],
      ["campaign", "Кампании"],
      ["reply", "Ответы"],
      ["warmup", "Прогрев"],
      ["bounce", "Недоставка"],
    ],
    "",
  )}</select></label><form data-search><label>Поиск<input name="search" type="search" placeholder="Отправитель, тема, текст"></label><button>Найти</button></form></div><div data-warnings role="status"></div><div class="full-mail-layout"><section class="panel full-mail-list" aria-label="Список писем"><div data-list></div><div class="actions" data-pages></div></section><section data-detail aria-label="Письмо"><div class="empty">Выберите письмо</div></section></div><section data-compose></section></div>`;
  const find = (s) => root.querySelector(s);
  const list = find("[data-list]"),
    detail = find("[data-detail]");

  async function reload() {
    const version = ++loadVersion;
    list.textContent = "Загрузка…";
    try {
      const result = await api(
        "/mailbox/messages?" + new URLSearchParams(state),
      );
      if (version !== loadVersion || !root.isConnected) return;
      const items = Array.isArray(result)
        ? result
        : result.items || result.drafts || [];
      folders = result.folders || folders;
      find('[data-filter="folder"]').innerHTML = opts(
        [
          ["", "Все папки"],
          ...folders.map((f) =>
            typeof f === "string"
              ? [f, f]
              : [f.folder || f.name, f.folder || f.name],
          ),
        ],
        state.folder,
      );
      find("[data-warnings]").innerHTML = (result.warnings || [])
        .map(
          (w) =>
            `<div class="alert">${e(typeof w === "string" ? w : w.error || w.message || JSON.stringify(w))}</div>`,
        )
        .join("");
      list.innerHTML = items.length
        ? items
            .map(
              (m) =>
                `<button class="thread-button ${m.read || state.view === "drafts" ? "" : "full-mail-unread"}" data-message="${e(m.id)}"><strong>${m.starred ? "★ " : ""}${e(m.subject || "Без темы")}</strong><small>${e(m.from || m.to?.join(", ") || "")} · ${e(m.mailboxEmail || mailboxes.find((b) => b.id === m.mailboxId)?.email || "")}</small><small>${e(date(m.created || m.updated))} · ${e(label[m.kind] || m.kind || "")}${m.status ? ` · ${e(label[m.status] || m.status)}` : ""}${(Array.isArray(m.attachments) ? m.attachments.length : m.attachments) ? " · 📎" : ""}</small><small>${(m.folders || []).map((f) => `<span class="badge">${e(f)}</span>`).join(" ")}${m.campaignId ? ` <span class="badge">${e(campaigns.find((c) => c.id === m.campaignId)?.name || m.campaignId)}</span>` : ""}</small></button>`,
            )
            .join("")
        : '<p class="hint">Писем нет</p>';
      const total = result.total ?? items.length,
        pageSize = result.pageSize || state.pageSize;
      find("[data-pages]").innerHTML =
        `<button data-prev ${state.page <= 1 ? "disabled" : ""}>Назад</button><span class="hint">${e(state.page)} / ${Math.max(1, Math.ceil(total / pageSize))} · ${e(total)} ${state.view === "drafts" ? "черновиков" : "писем"}</span><button data-next ${state.page * pageSize >= total ? "disabled" : ""}>Далее</button>`;
      list.querySelectorAll("[data-message]").forEach(
        (button) =>
          (button.onclick = run(async () => {
            if (state.view === "drafts") {
              const draft = items.find(
                (m) => String(m.id) === button.dataset.message,
              );
              openCompose({ ...draft, draftId: draft.id });
            } else await showMessage(button.dataset.message);
          })),
      );
      const prev = find("[data-prev]"),
        next = find("[data-next]");
      if (prev)
        prev.onclick = run(async () => {
          state.page--;
          await reload();
        });
      if (next)
        next.onclick = run(async () => {
          state.page++;
          await reload();
        });
    } catch (err) {
      if (version === loadVersion) {
        list.innerHTML = `<div class="alert">${e(err.message)}</div>`;
        find("[data-pages]").innerHTML = "";
      }
    }
  }

  async function showMessage(id, autoMarkRead = true) {
    const version = ++detailVersion;
    detail.textContent = "Загрузка письма…";
    const m = await api(`/mailbox/messages/${encodeURIComponent(id)}`);
    if (version !== detailVersion) return;
    const outgoing = m.direction === "out";
    detail.innerHTML = `<article class="panel"><h2>${e(m.subject || "Без темы")}</h2><p><strong>От:</strong> ${e(m.from || m.mailboxEmail || "")}<br><strong>Кому:</strong> ${e((m.to || []).join(", "))}${m.cc?.length ? `<br><strong>Копия:</strong> ${e(m.cc.join(", "))}` : ""}</p><p class="hint">${e(date(m.created))} · ${e(m.mailboxEmail || "")} · ${e((m.folders || []).join(", "))}${m.status ? ` · ${e(label[m.status] || m.status)}` : ""}</p>${m.status === "unknown" ? '<div class="alert">Результат SMTP неизвестен. Проверьте отправку у почтового провайдера. Автоматического повтора нет.</div>' : ""}${m.sentCopyError ? `<div class="alert">Письмо отправлено, но копия в папке отправленных не сохранена: ${e(m.sentCopyError)}</div>` : ""}<div class="actions"><button data-mail-action="${m.read ? "unread" : "read"}">${m.read ? "Не прочитано" : "Прочитано"}</button><button data-mail-action="${m.starred ? "unstar" : "star"}">${m.starred ? "Убрать звезду" : "Отметить звездой"}</button>${!outgoing ? '<button data-mail-action="archive">В архив</button><button data-mail-action="spam">В спам</button><button data-mail-action="trash">В корзину</button>' : ""}</div><div data-body></div><div class="actions">${(m.attachments || []).map((a) => `<a href="/api/mailbox/attachments/${encodeURIComponent(a.id)}" download="${e(a.name)}">${e(a.name)} (${Math.ceil(a.size / 1024)} КБ)</a>`).join(" ")}</div><div class="actions"><button data-reply>Ответить</button><button data-reply-all>Ответить всем</button><button data-forward>Переслать</button></div></article>`;
    const body = detail.querySelector("[data-body]");
    if (m.deliveryWarning) {
      const warning = document.createElement("div");
      warning.className = "alert";
      warning.textContent = "Частичная отправка: " + m.deliveryWarning;
      body.before(warning);
    }
    if (m.html) {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "");
      frame.title = "Текст письма";
      frame.className = "full-mail-body";
      frame.srcdoc =
        "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'\"><style>body{font:14px system-ui;overflow-wrap:anywhere;color:#20242b}img{max-width:100%}</style>" +
        m.html;
      body.append(frame);
    } else
      body.innerHTML = `<div class="full-mail-text">${e(m.text || "Письмо без текста")}</div>`;
    detail.querySelectorAll("[data-mail-action]").forEach(
      (button) =>
        (button.onclick = run(async () => {
          button.disabled = true;
          try {
            await api(`/mailbox/messages/${encodeURIComponent(id)}/action`, {
              action: button.dataset.mailAction,
            });
            await reload();
            await showMessage(id, false);
          } finally {
            button.disabled = false;
          }
        })),
    );
    const respond = (all) => {
      const recipients = replyRecipients(
        m,
        mailboxes.find((b) => b.id === m.mailboxId)?.email,
        all,
      );
      openCompose({
        mailboxId: m.mailboxId,
        ...recipients,
        subject: /^re:/i.test(m.subject || "")
          ? m.subject
          : `Re: ${m.subject || ""}`,
        replyToId: m.id,
        replyAll: all,
      });
    };
    detail.querySelector("[data-reply]").onclick = () => respond(false);
    detail.querySelector("[data-reply-all]").onclick = () => respond(true);
    detail.querySelector("[data-forward]").onclick = () =>
      openCompose({
        mailboxId: m.mailboxId,
        forwardId: m.id,
        subject: /^fwd:/i.test(m.subject || "")
          ? m.subject
          : `Fwd: ${m.subject || ""}`,
        body: `\n\n---------- Пересылаемое письмо ----------\nОт: ${m.from || ""}\nТема: ${m.subject || ""}\n\n${m.text || ""}`,
      });
    if (autoMarkRead && !m.read && !outgoing) {
      try {
        await api(`/mailbox/messages/${encodeURIComponent(id)}/action`, {
          action: "read",
        });
        const readButton = detail.querySelector('[data-mail-action="read"]');
        if (version === detailVersion && readButton) {
          readButton.dataset.mailAction = "unread";
          readButton.textContent = "Не прочитано";
        }
        await reload();
      } catch (err) {
        error(err);
      }
    }
  }

  function openCompose(initial = {}) {
    if (compose) {
      notice(
        "Сохраните или закройте открытое письмо перед созданием следующего.",
      );
      return;
    }
    compose = {
      mailboxId: "",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: "",
      format: "plain",
      attachments: [],
      ...initial,
      requestId: null,
      locked: false,
    };
    const host = find("[data-compose]");
    host.innerHTML = `<form class="panel full-mail-compose"><h2>${initial.draftId ? "Черновик" : "Новое письмо"}</h2><label>Отправитель<select name="mailboxId" required>${opts([["", "Выберите ящик"], ...mailboxes.map((m) => [m.id, m.email])], compose.mailboxId)}</select></label>${["to", "cc", "bcc"].map((name) => `<label>${{ to: "Кому", cc: "Копия", bcc: "Скрытая копия" }[name]}<input name="${name}" value="${e((Array.isArray(compose[name]) ? compose[name] : parseRecipients(compose[name])).join(", "))}" ${name === "to" ? "required" : ""} placeholder="email@example.com, второй адрес"></label>`).join("")}<label>Тема<input name="subject" value="${e(compose.subject)}" maxlength="998"></label><label>Формат<select name="format">${opts(
      [
        ["plain", "Обычный текст"],
        ["markdown", "Markdown"],
      ],
      compose.format,
    )}</select></label><label>Письмо<textarea name="body" rows="12" required maxlength="200000">${e(compose.body)}</textarea></label><label>Вложения (до 8 МБ суммарно, до 20 файлов)<input type="file" multiple data-files></label><div data-attachments></div><div data-send-status role="status"></div><div class="actions"><button class="primary" type="submit" data-send>Отправить</button><button type="button" data-save>Сохранить черновик</button>${compose.draftId ? '<button type="button" data-delete>Удалить черновик</button>' : ""}<button type="button" data-close>Закрыть</button></div></form>`;
    const form = host.querySelector("form"),
      status = form.querySelector("[data-send-status]");
    const read = () => {
      for (const name of ["mailboxId", "subject", "body", "format"])
        compose[name] = form.elements[name].value;
      for (const name of ["to", "cc", "bcc"])
        compose[name] = parseRecipients(form.elements[name].value);
      return { ...compose };
    };
    const renderAttachments = () => {
      form.querySelector("[data-attachments]").innerHTML = compose.attachments
        .map(
          (a, i) =>
            `<span>${e(a.name)} <button type="button" data-remove="${i}" ${compose.locked ? "disabled" : ""}>Убрать</button></span>`,
        )
        .join(" ");
      form.querySelectorAll("[data-remove]").forEach(
        (b) =>
          (b.onclick = () => {
            compose.attachments.splice(Number(b.dataset.remove), 1);
            renderAttachments();
          }),
      );
    };
    renderAttachments();
    let uploading = false;
    form.querySelector("[data-files]").onchange = run(async (event) => {
      const files = Array.from(event.target.files || []);
      const existing = compose.attachments.reduce(
        (sum, a) => sum + Math.floor(((a.data || "").length * 3) / 4),
        0,
      );
      if (
        compose.attachments.length + files.length > 20 ||
        existing + files.reduce((n, f) => n + f.size, 0) > MAX_ATTACHMENTS
      ) {
        event.target.value = "";
        throw new Error("Вложения превышают лимит: 8 МБ суммарно и 20 файлов.");
      }
      uploading = true;
      for (const element of form.querySelectorAll(
        "[data-send],[data-save],[data-close],[data-files],[data-delete]",
      ))
        element.disabled = true;
      try {
        const added = await Promise.all(
          files.map(
            (file) =>
              new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () =>
                  resolve({
                    name: file.name,
                    type: file.type || "application/octet-stream",
                    data: String(reader.result).split(",")[1],
                  });
                reader.onerror = () =>
                  reject(new Error(`Не удалось прочитать ${file.name}`));
                reader.readAsDataURL(file);
              }),
          ),
        );
        compose.attachments.push(...added);
        renderAttachments();
      } finally {
        uploading = false;
        event.target.value = "";
        for (const element of form.querySelectorAll(
          "[data-send],[data-save],[data-close],[data-files],[data-delete]",
        ))
          element.disabled = false;
      }
    });
    const close = () => {
      compose = null;
      host.innerHTML = "";
    };
    form.querySelector("[data-close]").onclick = close;
    form.querySelector("[data-save]").onclick = run(async () => {
      if (compose.locked || uploading) return;
      const payload = { ...read(), id: compose.draftId };
      compose.locked = true;
      Array.from(form.elements).forEach((element) => {
        element.disabled = true;
      });
      try {
        const draft = await api("/mailbox/drafts", payload);
        compose.draftId = draft.id || draft.draft?.id || compose.draftId;
        notice("Черновик сохранён");
        await reload();
      } finally {
        compose.locked = false;
        Array.from(form.elements).forEach((element) => {
          element.disabled = false;
        });
      }
    });
    if (compose.draftId)
      form.querySelector("[data-delete]").onclick = run(async () => {
        if (compose.locked || uploading) return;
        const draftId = compose.draftId;
        compose.locked = true;
        Array.from(form.elements).forEach((element) => {
          element.disabled = true;
        });
        try {
          await api(
            `/mailbox/drafts/${encodeURIComponent(draftId)}/delete`,
            {},
          );
          close();
          await reload();
        } finally {
          if (host.contains(form)) {
            compose.locked = false;
            Array.from(form.elements).forEach((element) => {
              element.disabled = false;
            });
          }
        }
      });
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (compose.locked || uploading || !form.reportValidity()) return;
      const payload = read();
      compose.requestId ||= crypto.randomUUID();
      payload.requestId = compose.requestId;
      compose.locked = true;
      Array.from(form.elements).forEach((element) => {
        element.disabled = true;
      });
      status.textContent = "Отправляется…";
      try {
        const result = await api("/mailbox/send", payload),
          message = result.message || result;
        if (message.status === "sent") {
          notice(
            result.deliveryWarning || message.deliveryWarning
              ? "Письмо отправлено частично. Откройте его в отправленных, чтобы проверить отклонённых получателей."
              : result.sentCopyError || message.sentCopyError
                ? "Письмо отправлено. Копия в папке отправленных не сохранена."
                : "Письмо отправлено",
          );
          close();
          state.view = "sent";
          state.folder = "";
          state.page = 1;
          root
            .querySelectorAll("[data-view]")
            .forEach((button) =>
              button.setAttribute(
                "aria-pressed",
                String(button.dataset.view === "sent"),
              ),
            );
          await reload();
        } else
          status.innerHTML = `<div class="alert">${e(label[message.status] || message.status || "Результат отправки неизвестен")}. Повторная отправка отключена. Проверьте журнал отправленных и почтового провайдера.</div>`;
      } catch (err) {
        status.innerHTML = `<div class="alert">${e(err.message)}. Результат отправки может быть неизвестен. Повторная отправка отключена; проверьте отправленные письма у провайдера. Код запроса: ${e(compose.requestId)}</div>`;
      } finally {
        if (host.contains(form))
          form.querySelector("[data-close]").disabled = false;
      }
    };
    host.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  find("[data-new]").onclick = () => openCompose();
  find("[data-refresh]").onclick = run(reload);
  find("[data-search]").onsubmit = run(async (event) => {
    event.preventDefault();
    state.search = new FormData(event.target).get("search");
    state.page = 1;
    await reload();
  });
  root.querySelectorAll("[data-filter]").forEach(
    (input) =>
      (input.onchange = run(async () => {
        state[input.dataset.filter] = input.value;
        if (input.dataset.filter === "mailboxId") state.folder = "";
        state.page = 1;
        await reload();
      })),
  );
  root.querySelectorAll("[data-view]").forEach(
    (button) =>
      (button.onclick = run(async () => {
        state.view = button.dataset.view;
        state.page = 1;
        detailVersion++;
        detail.innerHTML = '<div class="empty">Выберите письмо</div>';
        root
          .querySelectorAll("[data-view]")
          .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
        await reload();
      })),
  );
  await reload();
  return { reload };
}
