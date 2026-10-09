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
import { mountPreview } from "./editor-preview.js";
export async function letters(root, params, refresh) {
  root.disposeLetter?.();
  const result = await api(`/letters?${params}`);
  root.innerHTML =
    heading(
      "Письма",
      "Черновики и сохранённые письма. Запуски рассылок будут храниться отдельно.",
      '<button data-create class="primary">Письмо с нуля</button>',
    ) +
    `
  <form data-filter class="panel mk-filters">${input("search", "Поиск писем", params.get("search"), "search")}<label>Редактор<select name="mode"><option value="">Все</option><option value="html" ${params.get("mode") === "html" ? "selected" : ""}>HTML</option><option value="markdown" ${params.get("mode") === "markdown" ? "selected" : ""}>Markdown</option></select></label><label>Показывать<select name="archived">${[
    ["false", "Активные"],
    ["true", "Архивные"],
    ["all", "Все"],
  ]
    .map(
      ([key, label]) =>
        `<option value="${key}" ${params.get("archived") === key ? "selected" : ""}>${label}</option>`,
    )
    .join("")}</select></label><button>Применить</button></form>
  <div class="panel table-scroll"><table><thead><tr><th>Письмо</th><th>Редактор</th><th>Версия</th><th>Запусков</th><th>Изменено</th><th>Действия</th></tr></thead><tbody>${result.items.map((row) => `<tr><td><a href="#marketing/letters/${row.id}">${escape(row.title)}</a><p class="hint">${escape(row.subject)}</p></td><td>${row.editorMode === "html" ? "HTML" : "Markdown"}</td><td>${row.version}</td><td>${row.runCount}</td><td>${date(row.updatedAt)}</td><td><button data-copy="${row.id}">Копировать</button><button data-archive="${row.id}">${row.archived ? "Восстановить" : "В архив"}</button></td></tr>`).join("") || '<tr><td colspan="6">Писем пока нет. Создайте письмо с нуля.</td></tr>'}</tbody></table></div>${pager(result)}`;
  const on = (selector, event, fn) =>
    root
      .querySelectorAll(selector)
      .forEach((element) => element.addEventListener(event, guard(fn, root)));
  on("[data-create]", "click", () =>
    dialog(
      "Письмо с нуля",
      `${input("title", "Название письма", "Новое письмо", "text", 'required maxlength="200"')}<label>Редактор<select name="editorMode"><option value="html">HTML-редактор</option><option value="markdown">Markdown</option></select></label>`,
      async (data) => {
        const letter = await api("/letters", {
          title: data.get("title"),
          editorMode: data.get("editorMode"),
          source: "",
        });
        navigate(`letters/${letter.id}`);
      },
      { save: "Создать" },
    ),
  );
  on("[data-filter]", "submit", (event) => {
    event.preventDefault();
    const filter = new URLSearchParams();
    for (const [key, value] of new FormData(event.target))
      if (value) filter.set(key, value);
    navigate("letters", filter);
  });
  on("[data-page]", "click", (event) => {
    const values = new URLSearchParams(params);
    values.set("page", event.currentTarget.dataset.page);
    navigate("letters", values);
  });
  on("[data-copy]", "click", async (event) => {
    const copy = await api(
      `/letters/${event.currentTarget.dataset.copy}/copy`,
      {},
    );
    navigate(`letters/${copy.id}`);
  });
  on("[data-archive]", "click", (event) => {
    const row = result.items.find(
      (row) => row.id === event.currentTarget.dataset.archive,
    );
    dialog(
      row.archived ? "Восстановить письмо" : "Архивировать письмо",
      "<p>Версии письма и история запусков сохранятся.</p>",
      async () => {
        await api(
          `/letters/${row.id}`,
          { expectedVersion: row.version, archived: !row.archived },
          "PUT",
        );
        await refresh();
      },
    );
  });
}
export async function letterEditor(root, id) {
  root.disposeLetter?.();
  let closed = false;
  let letter = await api(`/letters/${id}`),
    revision = 0,
    savedRevision = 0,
    timer = null,
    inflight = null,
    conflict = false;
  const key = `dmailio-letter-${id}`;
  root.innerHTML =
    heading(
      "Редактор письма",
      "Исходники HTML и Markdown сохраняются отдельно.",
      '<button data-library>Все письма</button><button data-versions>Версии</button><button data-copy>Сохранить копию</button><button data-save class="primary">Сохранить</button>',
    ) +
    `
    <div class="panel mk-letter-fields">${input("title", "Название письма", letter.title, "text", 'required maxlength="200"')}${input("subject", "Тема письма", letter.subject, "text", 'maxlength="998"')}${input("preheader", "Прехедер", letter.preheader, "text", 'maxlength="500"')}
    <label>Редактор<select data-mode><option value="html" ${letter.editorMode === "html" ? "selected" : ""}>HTML</option><option value="markdown" ${letter.editorMode === "markdown" ? "selected" : ""}>Markdown</option></select></label></div>
    <p data-save-status role="status">Сохранено · версия ${letter.version}</p><div data-recovery></div><div data-conflict hidden><p role="alert">Письмо изменено в другой вкладке. Ваш ввод сохранён в этой вкладке. Сохраните копию или загрузите серверную версию.</p><button data-reload>Загрузить серверную версию</button></div>
    <div class="mk-editor-layout"><div class="panel mk-source"><label for="mk-letter-source">Исходник письма</label><textarea id="mk-letter-source" data-source spellcheck="false" maxlength="220000">${escape(letter.source)}</textarea></div><div data-editor-preview></div></div>`;
  const status = root.querySelector("[data-save-status]"),
    source = root.querySelector("[data-source]");
  const capture = () => {
    letter = {
      ...letter,
      title: root.querySelector("[name=title]").value,
      subject: root.querySelector("[name=subject]").value,
      preheader: root.querySelector("[name=preheader]").value,
      source: source.value,
      sources: { ...letter.sources, [letter.editorMode]: source.value },
    };
    return { ...letter, expectedVersion: letter.version };
  };
  const remember = () => {
    try {
      sessionStorage.setItem(key, JSON.stringify(capture()));
    } catch {
      status.textContent =
        "Не удалось сохранить локальный черновик. Сохраните письмо или скачайте исходник.";
    }
  };
  const mark = () => {
    revision++;
    remember();
    status.textContent = "Есть несохранённые изменения";
    clearTimeout(timer);
    timer = setTimeout(() => save(), 900);
    root.dispatchEvent(new CustomEvent("letter-change", { detail: capture() }));
  };
  const save = async () => {
    clearTimeout(timer);
    if (closed || !root.isConnected || conflict) return;
    if (inflight) {
      await inflight;
      if (savedRevision !== revision) return save();
      return;
    }
    if (savedRevision === revision) return;
    const at = revision,
      payload = capture();
    status.textContent = "Сохранение…";
    inflight = (async () => {
      try {
        const saved = await api(`/letters/${id}`, payload, "PUT");
        letter.version = saved.version;
        savedRevision = at;
        status.textContent = `Сохранено · версия ${letter.version}`;
        if (revision === at) sessionStorage.removeItem(key);
        else remember();
      } catch (error) {
        remember();
        status.textContent = `Не сохранено: ${error.message}`;
        if (error.code === "VERSION_CONFLICT") {
          conflict = true;
          root.querySelector("[data-conflict]").hidden = false;
        }
      }
    })().finally(() => {
      inflight = null;
    });
    await inflight;
    if (revision !== at && !conflict && !closed && root.isConnected)
      timer = setTimeout(() => save(), 900);
  };
  root
    .querySelectorAll(
      "[name=title],[name=subject],[name=preheader],[data-source]",
    )
    .forEach((element) => element.addEventListener("input", mark));
  root.querySelector("[data-mode]").onchange = () => {
    capture();
    letter.editorMode = root.querySelector("[data-mode]").value;
    source.value = letter.sources[letter.editorMode] || "";
    mark();
  };
  root.querySelector("[data-save]").onclick = () => {
    if (savedRevision === revision) revision++;
    return save();
  };
  root.querySelector("[data-library]").onclick = async () => {
    await save();
    navigate("letters");
  };
  root.querySelector("[data-copy]").onclick = guard(async () => {
    const copy = await api(`/letters/${id}/copy`, capture());
    sessionStorage.removeItem(key);
    navigate(`letters/${copy.id}`);
  }, root);
  root.querySelector("[data-reload]").onclick = () =>
    dialog(
      "Загрузить серверную версию",
      "<p>Текущий ввод будет заменён. Чтобы его сохранить, сначала нажмите «Сохранить копию».</p>",
      async () => {
        sessionStorage.removeItem(key);
        await letterEditor(root, id);
      },
      { save: "Загрузить" },
    );
  root.querySelector("[data-versions]").onclick = guard(async () => {
    const versions = await api(`/letters/${id}/versions`);
    dialog(
      "Версии письма",
      `<label>Версия<select name="version">${versions
        .map(
          (row) =>
            `<option value="${row.version}">${row.version} · ${date(row.created_at)}</option>`,
        )
        .reverse()
        .join(
          "",
        )}</select></label><p>Создать новое письмо из выбранной версии. Текущее письмо не изменится.</p>`,
      async (data) => {
        const version = versions.find(
          (row) => row.version === Number(data.get("version")),
        );
        const copy = await api(`/letters/${id}/copy`, version.data);
        navigate(`letters/${copy.id}`);
      },
      { save: "Создать копию версии" },
    );
  }, root);
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) || "null");
    if (stored) {
      root.querySelector("[data-recovery]").innerHTML =
        "<p>Есть локальный несохранённый черновик.</p><button data-restore>Восстановить локальный ввод</button>";
      root.querySelector("[data-restore]").onclick = () => {
        letter = {
          ...stored,
          version: stored.expectedVersion ?? stored.version,
        };
        for (const name of ["title", "subject", "preheader"])
          root.querySelector(`[name=${name}]`).value = letter[name];
        root.querySelector("[data-mode]").value = letter.editorMode;
        source.value = letter.source;
        root.querySelector("[data-recovery]").innerHTML = "";
        mark();
      };
    }
  } catch {}
  root.getLetter = capture;
  const editor = { capture, source, save };
  const disposePreview = mountPreview(root, id, editor);
  root.disposeLetter = () => {
    closed = true;
    clearTimeout(timer);
    disposePreview();
  };
  return editor;
}
