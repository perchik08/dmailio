const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Keep the existing textarea as the form value. Rich HTML uses the existing
// Markdown transport so old drafts stay readable without a data migration.
export function mountEditor(
  area,
  {
    api,
    notify,
    format = "markdown",
    onFormat = () => {},
    disabled = false,
    signature = false,
    includeSignature = true,
    onSignature = () => {},
  },
) {
  const editorLabel =
    area.previousElementSibling?.textContent?.trim() || "Текст письма";
  const Quill = window.Quill;
  if (!Quill) throw new Error("Не удалось загрузить редактор писем");
  const Font = Quill.import("attributors/style/font");
  Font.whitelist = ["Arial", "Georgia", "Times New Roman", "Courier New"];
  Quill.register(Font, true);
  const Size = Quill.import("attributors/style/size");
  Size.whitelist = ["12px", "14px", "16px", "18px", "24px"];
  Quill.register(Size, true);
  Quill.register(Quill.import("attributors/style/align"), true);
  const tools = document.createElement("div");
  tools.className = "compose-tools";
  tools.innerHTML = `<div class="compose-toolbar" role="toolbar" aria-label="Оформление текста">
    <span class="ql-formats"><button type="button" data-tool="undo" title="Отменить" aria-label="Отменить">↶</button><button type="button" data-tool="redo" title="Повторить" aria-label="Повторить">↷</button></span>
    <span class="ql-formats"><button type="button" class="ql-bold" title="Жирный" aria-label="Жирный"></button><button type="button" class="ql-italic" title="Курсив" aria-label="Курсив"></button><button type="button" class="ql-underline" title="Подчёркнутый" aria-label="Подчёркнутый"></button><button type="button" class="ql-strike" title="Зачёркнутый" aria-label="Зачёркнутый"></button></span>
    <span class="ql-formats"><select class="ql-font" title="Шрифт" aria-label="Шрифт"><option value="Arial" selected>Arial</option><option value="Georgia">Georgia</option><option value="Times New Roman">Times New Roman</option><option value="Courier New">Courier New</option></select><select class="ql-size" title="Размер" aria-label="Размер"><option value="12px">12</option><option value="14px" selected>14</option><option value="16px">16</option><option value="18px">18</option><option value="24px">24</option></select></span>
    <span class="ql-formats"><select class="ql-background" title="Цвет выделения" aria-label="Цвет выделения"></select><select class="ql-color" title="Цвет текста" aria-label="Цвет текста"></select><button type="button" class="ql-clean" title="Очистить оформление" aria-label="Очистить оформление"></button></span>
    <span class="ql-formats"><button type="button" data-tool="emoji" title="Эмодзи" aria-label="Эмодзи">☺</button><button type="button" data-tool="link" title="Вставить ссылку" aria-label="Вставить ссылку">🔗</button><button type="button" data-tool="unlink" title="Удалить ссылку" aria-label="Удалить ссылку">⌫</button><button type="button" data-tool="image" title="Вставить картинку" aria-label="Вставить картинку"></button><button type="button" class="ql-blockquote" title="Цитата" aria-label="Цитата"></button></span>
    <span class="ql-formats"><select class="ql-align" title="Выравнивание" aria-label="Выравнивание"></select><button type="button" class="ql-list" value="bullet" title="Маркированный список" aria-label="Маркированный список"></button><button type="button" class="ql-list" value="ordered" title="Нумерованный список" aria-label="Нумерованный список"></button></span>
    <span class="ql-formats"><button type="button" data-tool="md" title="Загрузить Markdown" aria-label="Загрузить Markdown">MD</button></span>
  </div><div data-insert-panel></div><input data-md type="file" accept=".md,.markdown,text/markdown,text/plain" hidden><input data-image type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>${signature ? `<label class="check"><input data-signature type="checkbox" ${includeSignature ? "checked" : ""} ${disabled ? "disabled" : ""}>Добавлять подпись отправителя</label>` : ""}`;
  area.before(tools);
  tools.querySelector('[data-tool="image"]').innerHTML =
    Quill.import("ui/icons").image;
  const host = document.createElement("div");
  host.className = "rich-editor";
  area.after(host);
  const signatureInput = tools.querySelector("[data-signature]");
  const signatureLabel = signatureInput?.closest("label");
  if (signatureLabel) host.after(signatureLabel);
  area.classList.add("rich-source");
  area.removeAttribute("required");
  const quill = new Quill(host, {
    theme: "snow",
    modules: {
      toolbar: tools.querySelector(".compose-toolbar"),
      history: { delay: 500, maxStack: 100 },
    },
    placeholder: area.placeholder || "Введите текст письма…",
    readOnly: disabled,
  });
  quill.root.setAttribute("aria-label", editorLabel);
  if (disabled)
    tools.querySelectorAll("button,select").forEach((el) => {
      el.disabled = true;
    });
  const panel = tools.querySelector("[data-insert-panel]");
  let loading = false,
    edited = false;
  const sync = () => {
    if (loading) return;
    edited = true;
    const hasContent = quill
      .getContents()
      .ops.some((op) => typeof op.insert !== "string" || op.insert.trim());
    area.value = hasContent
      ? quill.getSemanticHTML().replace(/&nbsp;|\u00a0/g, " ")
      : "";
    format = "markdown";
    onFormat(format);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  };
  quill.on("text-change", sync);
  const render = (body, bodyFormat) =>
    api("/content/preview", {
      body,
      format: bodyFormat,
      includeSignature: false,
    });
  if (area.value)
    render(area.value, format)
      .then((p) => {
        if (!host.isConnected || edited) return;
        loading = true;
        quill.clipboard.dangerouslyPasteHTML(p.html || "", "silent");
        quill.history.clear();
        loading = false;
      })
      .catch((e) => notify(e.message))
      .finally(() => {
        loading = false;
      });
  else loading = false;
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (err) {
      notify(err.message);
    }
  };
  const insert = (value, embed) => {
    const range = quill.getSelection(true) || {
      index: quill.getLength() - 1,
      length: 0,
    };
    if (embed) quill.insertEmbed(range.index, embed, value, "user");
    else quill.insertText(range.index, value, "user");
    quill.setSelection(range.index + (embed ? 1 : value.length), 0);
    sync();
  };
  const openInsert = (kind) => {
    const image = kind === "image";
    const selected = quill.getSelection() || {
      index: quill.getLength() - 1,
      length: 0,
    };
    const caption = selected.length
      ? quill.getText(selected.index, selected.length)
      : "";
    panel.innerHTML = `<div class="insert-panel"><label>${image ? "Описание картинки" : "Текст ссылки"}<input data-caption value="${esc(caption)}" placeholder="${image ? "Логотип" : "Telegram"}"></label><label>${image ? "HTTPS-ссылка на картинку" : "Адрес ссылки"}<input data-url placeholder="https://${image ? "example.com/logo.png" : "t.me/username"}"></label><button type="button" data-confirm>Вставить</button>${image ? '<button type="button" data-upload>Загрузить с компьютера</button>' : ""}<button type="button" data-cancel>Закрыть</button></div>`;
    const put = (url) => {
      const label =
        panel.querySelector("[data-caption]").value.trim() ||
        (image ? "Изображение" : url);
      if (image) {
        const range = quill.getSelection(true) || {
          index: quill.getLength() - 1,
          length: 0,
        };
        quill.insertEmbed(range.index, "image", url, "user");
        quill.formatText(range.index, 1, "alt", label, "user");
        quill.setSelection(range.index + 1, 0);
      } else {
        quill.deleteText(selected.index, selected.length, "user");
        quill.insertText(selected.index, label, { link: url }, "user");
        quill.setSelection(selected.index + label.length, 0);
      }
      panel.replaceChildren();
      sync();
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
    panel.querySelector("[data-cancel]").onclick = () =>
      panel.replaceChildren();
    if (image)
      panel.querySelector("[data-upload]").onclick = () =>
        tools.querySelector("[data-image]").click();
    tools.querySelector("[data-image]").onchange = safe(async (e) => {
      const file = e.target.files[0];
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
  };
  tools.querySelectorAll("[data-tool]").forEach(
    (button) =>
      (button.onclick = safe(() => {
        if (disabled) return;
        const kind = button.dataset.tool;
        if (kind === "undo") quill.history.undo();
        if (kind === "redo") quill.history.redo();
        if (kind === "link" || kind === "image") openInsert(kind);
        if (kind === "unlink") {
          const range = quill.getSelection(true);
          if (range)
            quill.formatText(
              range.index,
              range.length || 1,
              "link",
              false,
              "user",
            );
        }
        if (kind === "emoji") {
          panel.innerHTML = `<div class="emoji-panel" role="group" aria-label="Эмодзи">${["🙂", "😊", "👋", "👍", "❤️", "✨", "🎉", "📩"].map((s) => `<button type="button" data-emoji="${s}">${s}</button>`).join("")}</div>`;
          panel.querySelectorAll("[data-emoji]").forEach(
            (b) =>
              (b.onclick = () => {
                insert(b.dataset.emoji);
                panel.replaceChildren();
              }),
          );
        }
        if (kind === "md") {
          const input = tools.querySelector("[data-md]");
          input.value = "";
          input.click();
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
    const body = (await file.text()).replace(/^\uFEFF/, "");
    const result = await render(body, "markdown");
    quill.clipboard.dangerouslyPasteHTML(result.html || "", "user");
    sync();
    notify("Markdown загружен. Проверьте оформление и сохраните изменения.");
  });
  signatureInput?.addEventListener("change", (e) =>
    onSignature(e.target.checked),
  );
  return {
    insertText: (value) => insert(value),
    setContent: async (body, bodyFormat = "markdown") => {
      const result = await render(body, bodyFormat);
      quill.clipboard.dangerouslyPasteHTML(result.html || "", "user");
      sync();
    },
    getFormat: () => format,
    focus: () => quill.focus(),
  };
}
