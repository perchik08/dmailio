import { api, request, escape, guard, dialog, input } from "./common.js";
function insert(source, value) {
  const start = source.selectionStart,
    end = source.selectionEnd;
  source.setRangeText(value, start, end, "end");
  source.dispatchEvent(new Event("input", { bubbles: true }));
  source.focus();
}
export function mountPreview(root, id, editor) {
  const panel = root.querySelector("[data-editor-preview]");
  let seed = "preview",
    ticket = 0,
    timer = null,
    closed = false;
  panel.className = "panel mk-preview";
  panel.innerHTML = `<h2>Предпросмотр</h2><p class="hint">Тестовые данные, без реальных отписок. Переменные: {{firstName}}; запасное значение: {{firstName|коллега}}; ротация: {Привет|Здравствуйте}.</p>
 <div class="mk-actions"><button data-preview>Обновить</button><button data-rotate>Другой вариант фраз</button><button data-export-html>Скачать HTML</button></div>
 <label>Поиск контакта для проверки<input data-contact-search type="search" placeholder="Email или имя"></label><button data-find>Найти контакт</button>
 <label>Контакт для проверки<select data-contact><option value="">Пример: Анна, Пример компании</option></select></label>
 <label class="mk-check"><input type="checkbox" data-external>Показывать внешние изображения</label>
 <label>Ширина<select data-width><option value="100%">Компьютер</option><option value="375px">Телефон · 375 px</option></select></label>
 <div data-render-status role="status"></div><iframe data-frame title="Предпросмотр письма" sandbox="" referrerpolicy="no-referrer"></iframe>
 <div class="mk-actions"><button data-image>Вставить изображение</button><button data-variable>Вставить переменную</button><button data-download-source>Скачать исходник</button></div>`;
  const state = panel.querySelector("[data-render-status]"),
    frame = panel.querySelector("[data-frame]");
  const payload = () => ({
    ...editor.capture(),
    contactId: panel.querySelector("[data-contact]").value || undefined,
    rotationSeed: seed,
  });
  const update = async () => {
    if (closed || !panel.isConnected) return;
    const current = ++ticket;
    state.textContent = "Подготовка предпросмотра…";
    try {
      const result = await api(`/letters/${id}/preview`, payload());
      if (current !== ticket || !root.isConnected) return;
      const imagePolicy = panel.querySelector("[data-external]").checked
        ? "https: " + location.origin
        : location.origin;
      frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imagePolicy}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">${result.html}`;
      state.textContent = result.warnings.join(". ") || "Предпросмотр готов";
      state.removeAttribute("data-failed");
    } catch (error) {
      if (current !== ticket) return;
      frame.srcdoc = "";
      state.textContent = error.message;
      state.setAttribute("data-failed", "true");
    }
  };
  const on = (selector, event, fn) =>
    panel.querySelector(selector).addEventListener(event, guard(fn, root));
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 500);
  };
  root.addEventListener("letter-change", changed);
  on("[data-preview]", "click", update);
  on("[data-rotate]", "click", () => {
    seed = crypto.randomUUID();
    return update();
  });
  on("[data-external]", "change", update);
  on("[data-contact]", "change", update);
  on("[data-width]", "change", (event) => {
    frame.style.width = event.target.value;
  });
  const download = async (path, body, name) => {
    const response = await request(path, body);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  on("[data-export-html]", "click", () =>
    download(`/letters/${id}/export`, payload(), `letter-${id}.html`),
  );
  on("[data-download-source]", "click", () => {
    const value = editor.capture();
    const url = URL.createObjectURL(
      new Blob([value.source], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `letter-${id}.${value.editorMode === "builder" ? "json" : value.editorMode === "html" ? "html" : "md"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  on("[data-find]", "click", async () => {
    const result = await api(
      `/contacts?perPage=100&search=${encodeURIComponent(panel.querySelector("[data-contact-search]").value)}`,
    );
    panel.querySelector("[data-contact]").innerHTML =
      '<option value="">Пример: Анна, Пример компании</option>' +
      result.items
        .map(
          (row) =>
            `<option value="${row.id}">${escape(row.email)} — ${escape(row.name)}</option>`,
        )
        .join("");
    state.textContent = `Найдено: ${result.total}. Показано до 100 контактов; уточните поиск.`;
  });
  on("[data-variable]", "click", () =>
    dialog(
      "Вставить переменную",
      `${input("name", "Название переменной", "", "text", 'required maxlength="80"')}${input("fallback", "Запасное значение")}`,
      async (data) => {
        const name = String(data.get("name")).trim(),
          fallback = String(data.get("fallback")).trim();
        if (!/^[\p{L}\p{N}_ -]{1,80}$/u.test(name) || /[{}|]/.test(fallback))
          throw new Error("Проверьте название и запасное значение");
        const token = `{{${name}${fallback ? "|" + fallback : ""}}}`;
        if (editor.capture().editorMode === "builder")
          editor.builderVariable(token);
        else insert(editor.source, token);
      },
      { save: "Вставить" },
    ),
  );
  on("[data-image]", "click", async () => {
    const assets = await api("/assets");
    const form = dialog(
      "Вставить изображение",
      `<label>Источник<select name="method"><option value="file">Загрузить файл</option><option value="library">Из библиотеки</option><option value="url">Импортировать по HTTPS-ссылке</option></select></label>
   <label data-kind="file">Картинка PNG, JPEG, GIF или WebP · до 2 МБ<input name="file" type="file" accept="image/png,image/jpeg,image/gif,image/webp"></label>
   <label data-kind="library" hidden>Картинка из библиотеки<select name="asset"><option value="">Выберите картинку</option>${assets.map((asset) => `<option value="${asset.id}">${escape(asset.name)} · ${Math.round(asset.size / 1024)} КБ</option>`).join("")}</select></label>
   <label data-kind="url" hidden>HTTPS-ссылка<input name="url" type="url"></label>${input("alt", "Описание картинки", "", "text", 'required maxlength="1000"')}<p>Картинки письма доступны получателям по публичной ссылке.</p>`,
      async (data) => {
        const alt = String(data.get("alt"));
        let asset;
        if (data.get("method") === "library") {
          asset = assets.find((asset) => asset.id === data.get("asset"));
          if (!asset) throw new Error("Выберите картинку");
        } else if (data.get("method") === "url")
          asset = await api("/assets/remote", { url: data.get("url"), alt });
        else {
          const file = data.get("file");
          if (!file?.size || file.size > 2000000)
            throw new Error("Выберите картинку до 2 МБ");
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 32768)
            binary += String.fromCharCode(
              ...bytes.subarray(offset, offset + 32768),
            );
          asset = await api("/assets", {
            content: btoa(binary),
            mime: file.type,
            name: file.name,
            alt,
          });
        }
        const mode = editor.capture().editorMode;
        if (mode === "builder") {
          editor.builderImage(asset, alt);
          return;
        }
        const publicURL = asset.url;
        const markup =
          mode === "html"
            ? `<img src="${escape(publicURL)}" alt="${escape(alt)}" style="max-width:100%;height:auto">`
            : `![${alt.replace(/[\[\]\\]/g, "\\$&")}](${publicURL})`;
        insert(editor.source, markup);
      },
      { save: "Вставить" },
    );
    form.querySelector("[name=method]").onchange = (event) =>
      form.querySelectorAll("[data-kind]").forEach((element) => {
        element.hidden = element.dataset.kind !== event.target.value;
      });
  });
  update();
  return () => {
    closed = true;
    ticket++;
    clearTimeout(timer);
    root.removeEventListener("letter-change", changed);
  };
}
