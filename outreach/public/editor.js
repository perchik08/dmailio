const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Shared Markdown composer for campaign steps, signatures and inbox replies.
export function mountEditor(
  area,
  {
    api,
    notify,
    format = "markdown",
    onFormat = () => {},
    disabled = false,
    previewPayload = () => ({}),
    signature = false,
    includeSignature = true,
    onSignature = () => {},
  },
) {
  const tools = document.createElement("div");
  tools.className = "compose-tools";
  tools.innerHTML = `<div class="compose-toolbar" role="toolbar" aria-label="Оформление текста"><label>Формат<select data-format ${disabled ? "disabled" : ""}><option value="plain">Обычный текст</option><option value="markdown">Markdown</option></select></label>${[
    ["bold", "Жирный"],
    ["italic", "Курсив"],
    ["heading", "Заголовок"],
    ["list", "Список"],
    ["link", "Ссылка"],
    ["image", "Картинка"],
    ["md", "Загрузить .md"],
  ]
    .map(
      ([id, title]) =>
        `<button type="button" data-tool="${id}" ${disabled ? "disabled" : ""}>${title}</button>`,
    )
    .join(
      "",
    )}<button type="button" data-tool="preview">Предпросмотр оформления</button><input data-md type="file" accept=".md,.markdown,text/markdown,text/plain" hidden><input data-image type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden></div><div data-insert-panel></div>${signature ? `<label class="check"><input data-signature type="checkbox" ${includeSignature ? "checked" : ""} ${disabled ? "disabled" : ""}>Добавлять подпись отправителя</label>` : ""}<p class="hint">Markdown: **жирный**, *курсив*, [ссылка](https://…), списки и таблицы. Можно вставить безопасную HTML-разметку.</p>`;
  area.before(tools);
  tools.querySelector("[data-format]").value = format;
  const pane = document.createElement("div");
  pane.className = "mail-preview";
  pane.hidden = true;
  area.after(pane);
  let revision = 0,
    timer;
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (err) {
      notify(err.message);
    }
  };
  const refresh = async () => {
    const version = ++revision;
    if (pane.hidden || !pane.isConnected) return;
    try {
      const p = await api("/content/preview", {
        body: area.value,
        format,
        ...previewPayload(),
      });
      if (version === revision && pane.isConnected) pane.innerHTML = p.html;
    } catch (err) {
      if (version === revision) pane.textContent = err.message;
    }
  };
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  };
  const markdown = () => {
    format = "markdown";
    tools.querySelector("[data-format]").value = format;
    onFormat(format);
  };
  const insert = (before, after = "", placeholder = "текст") => {
    markdown();
    const selected =
      area.value.slice(area.selectionStart, area.selectionEnd) || placeholder;
    area.setRangeText(
      before + selected + after,
      area.selectionStart,
      area.selectionEnd,
      "end",
    );
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.focus();
  };
  tools.querySelector("[data-format]").onchange = (e) => {
    format = e.target.value;
    onFormat(format);
    changed();
  };
  tools.querySelector("[data-signature]")?.addEventListener("change", (e) => {
    onSignature(e.target.checked);
    changed();
  });
  area.addEventListener("input", changed);
  const panel = tools.querySelector("[data-insert-panel]");
  const openInsert = (kind) => {
    const image = kind === "image";
    const start = area.selectionStart,
      end = area.selectionEnd;
    panel.innerHTML = `<div class="insert-panel"><label>${image ? "Описание картинки" : "Текст ссылки"}<input data-caption value="${esc(area.value.slice(start, end))}" placeholder="${image ? "Логотип" : "Telegram"}"></label><label>${image ? "HTTPS-ссылка на картинку" : "Адрес ссылки"}<input data-url placeholder="https://${image ? "example.com/logo.png" : "t.me/username"}"></label>${image ? '<label>Ширина, px<input data-width type="number" min="24" max="1200" value="160"></label>' : ""}<button type="button" data-confirm>Вставить</button>${image ? '<button type="button" data-upload>Загрузить с компьютера</button>' : ""}<button type="button" data-cancel>Закрыть</button></div>`;
    const put = (url) => {
      markdown();
      const caption =
        panel.querySelector("[data-caption]").value ||
        (image ? "Изображение" : "Ссылка");
      let text;
      if (image) {
        const width = Number(panel.querySelector("[data-width]").value);
        if (!Number.isInteger(width) || width < 24 || width > 1200)
          throw new Error("Ширина картинки: 24–1200 px");
        text = `<img src="${esc(url)}" alt="${esc(caption)}" width="${width}">`;
      } else
        text = `[${caption.replace(/[\[\]\\]/g, "\\$&")}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
      area.setRangeText(text, start, end, "end");
      area.dispatchEvent(new Event("input", { bubbles: true }));
      panel.innerHTML = "";
      area.focus();
    };
    panel.querySelector("[data-confirm]").onclick = safe(() => {
      const url = panel.querySelector("[data-url]").value.trim();
      if (!(image ? /^https:\/\//i : /^(https?:\/\/|mailto:|tel:)/i).test(url))
        throw new Error(
          image
            ? "Нужна HTTPS-ссылка"
            : "Нужна ссылка https://, mailto: или tel:",
        );
      put(url);
    });
    panel.querySelector("[data-cancel]").onclick = () => {
      panel.innerHTML = "";
    };
    if (image) {
      const fileInput = tools.querySelector("[data-image]");
      fileInput.value = "";
      panel.querySelector("[data-upload]").onclick = () => fileInput.click();
      fileInput.onchange = safe(async () => {
        const file = fileInput.files[0];
        if (!file) return;
        if (file.size > 2_000_000) throw new Error("Картинка: максимум 2 МБ");
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () =>
            reject(new Error("Не удалось прочитать картинку"));
          reader.readAsDataURL(file);
        });
        const uploaded = await api("/images", { base64, mime: file.type });
        if (panel.querySelector("[data-caption]")) put(uploaded.url);
      });
    }
  };
  tools.querySelectorAll("[data-tool]").forEach(
    (button) =>
      (button.onclick = safe(async () => {
        const kind = button.dataset.tool;
        if (kind === "bold") insert("**", "**");
        if (kind === "italic") insert("*", "*");
        if (kind === "heading") insert("\n## ", "\n", "Заголовок");
        if (kind === "list") insert("\n- ", "\n", "Пункт списка");
        if (["link", "image"].includes(kind)) openInsert(kind);
        if (kind === "md") {
          tools.querySelector("[data-md]").value = "";
          tools.querySelector("[data-md]").click();
        }
        if (kind === "preview") {
          pane.hidden = !pane.hidden;
          button.textContent = pane.hidden
            ? "Предпросмотр оформления"
            : "Скрыть предпросмотр";
          await refresh();
        }
      })),
  );
  tools.querySelector("[data-md]").onchange = safe(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 100000) throw new Error("Markdown-файл: максимум 100 КБ");
    if (
      area.value.trim() &&
      !confirm("Заменить текущий текст содержимым Markdown-файла?")
    )
      return;
    area.value = (await file.text()).replace(/^\uFEFF/, "");
    markdown();
    area.dispatchEvent(new Event("input", { bubbles: true }));
    notify("Markdown загружен. Проверьте оформление и сохраните изменения.");
  });
  return { refresh, getFormat: () => format };
}
