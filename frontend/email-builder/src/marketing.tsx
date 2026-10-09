import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, CssBaseline } from "@mui/material";
import theme from "./theme";
import EditorBlock from "./documents/editor/EditorBlock";
import {
  useDocument,
  useSelectedBlockId,
  resetDocument,
  setSelectedBlockId,
  subscribeDocument,
} from "./documents/editor/EditorContext";
import "./marketing.css";
import {
  advancedPalette,
  advancedTypes,
} from "../../../outreach/public/marketing/builder-blocks.js";
const nonce = location.hash.slice(1),
  origin = location.origin;
const post = (type: string, extra: any = {}) =>
  parent.postMessage(
    { channel: "dmailio-builder", schemaVersion: 1, nonce, type, ...extra },
    origin,
  );
const palette: any = {
  Text: ["Текст", { text: "Новый текст" }],
  Heading: ["Заголовок", { text: "Заголовок", level: "h2" }],
  List: ["Список", { text: "- Первый пункт\n- Второй пункт" }],
  Image: ["Изображение", { url: "", alt: "Описание картинки" }],
  Button: ["Кнопка", { text: "Перейти", url: "https://example.com" }],
  Divider: ["Разделитель", { lineColor: "#cccccc" }],
  Spacer: ["Отступ", { height: 24 }],
  Html: ["HTML", { contents: "<p>Ваш HTML</p>" }],
  ...advancedPalette,
};
const clone = (v: any) => JSON.parse(JSON.stringify(v));
function refs(block: any): string[][] {
  if (block.type === "EmailLayout") return [block.data.childrenIds || []];
  if (block.type === "Container") return [block.data.props?.childrenIds || []];
  if (block.type === "ColumnsContainer")
    return block.data.props.columns.map((c: any) => c.childrenIds);
  return [];
}
function Builder() {
  const doc = useDocument(),
    selected = useSelectedBlockId();
  const [tab, setTab] = useState("content"),
    [mobile, setMobile] = useState(false),
    [error, setError] = useState("");
  const history = useRef<string[]>([]),
    cursor = useRef(-1),
    replaying = useRef(false);
  const [, refresh] = useState(0);
  useEffect(() => {
    post("selection", { blockId: selected });
  }, [selected]);
  useEffect(
    () =>
      subscribeDocument((next) => {
        const json = JSON.stringify(next);
        if (!replaying.current) {
          history.current = history.current.slice(0, cursor.current + 1);
          history.current.push(json);
          if (history.current.length > 100) history.current.shift();
          cursor.current = history.current.length - 1;
        }
        refresh((n) => n + 1);
        post("change", { source: JSON.stringify({ schemaVersion: 1, document: next }) });
      }),
    [],
  );
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const msg = event.data;
      if (
        event.source !== parent ||
        event.origin !== origin ||
        msg?.channel !== "dmailio-builder" ||
        msg.schemaVersion !== 1 ||
        msg.nonce !== nonce ||
        msg.type !== "load"
      )
        return;
      try {
        const value = JSON.parse(msg.source);
        if (value.schemaVersion !== 1 || !value.document?.root) throw Error("Неизвестный документ");
        history.current = [];
        cursor.current = -1;
        resetDocument(value.document);
        setError("");
      } catch {
        setError("Не удалось загрузить документ конструктора");
      }
    };
    window.addEventListener("message", receive);
    post("ready");
    return () => window.removeEventListener("message", receive);
  }, []);
  function commit(next: any) {
    resetDocument(next);
    if (selected && next[selected]) setSelectedBlockId(selected);
  }
  function add(type: string, count?: number) {
    const next = clone(doc),
      id = crypto.randomUUID();
    let block: any;
    if (type === "ColumnsContainer")
      block = {
        type,
        data: {
          props: {
            columns: Array.from({ length: count }, () => ({ childrenIds: [] })),
            ratios: Array(count).fill(1),
          },
        },
      };
    else {
      const [label, props] = palette[type];
      block = {
        type: type === "List" ? "Text" : type,
        data: {
          props: clone(props),
          style: { padding: { top: 16, right: 24, bottom: 16, left: 24 } },
        },
      };
    }
    next[id] = block;
    next.root.data.childrenIds = [...(next.root.data.childrenIds || []), id];
    commit(next);
    setSelectedBlockId(id);
  }
  function patch(key: string, value: any, root = false) {
    const next = clone(doc),
      id = root ? "root" : selected;
    if (!id || !next[id]) return;
    const block = next[id];
    if (root) block.data[key] = value;
    else {
      block.data.props = { ...block.data.props, [key]: value };
    }
    commit(next);
  }
  function style(key: string, value: any) {
    if (!selected) return;
    const next = clone(doc);
    next[selected].data.style = { ...next[selected].data.style, [key]: value };
    commit(next);
  }
  function locate(next: any, id: string) {
    for (const b of Object.values(next))
      for (const ids of refs(b)) if (ids.includes(id)) return ids;
    return null;
  }
  function removeTree(next: any, id: string) {
    for (const ids of refs(next[id])) for (const child of [...ids]) removeTree(next, child);
    delete next[id];
  }
  function action(type: string) {
    if (!selected || selected === "root") return;
    const next = clone(doc),
      ids = locate(next, selected);
    if (!ids) return;
    const index = ids.indexOf(selected);
    if (type === "delete") {
      ids.splice(index, 1);
      removeTree(next, selected);
      setSelectedBlockId(null);
    } else if (type === "copy") {
      function duplicate(id: string): string {
        const copy = crypto.randomUUID();
        next[copy] = clone(next[id]);
        for (const children of refs(next[copy]))
          children.splice(0, children.length, ...children.map(duplicate));
        return copy;
      }
      ids.splice(index + 1, 0, duplicate(selected));
    } else {
      const destination = index + (type === "up" ? -1 : 1);
      if (destination < 0 || destination >= ids.length) return;
      ids.splice(index, 1);
      ids.splice(destination, 0, selected);
    }
    commit(next);
  }
  function undo(delta: number) {
    const at = cursor.current + delta;
    if (at < 0 || at >= history.current.length) return;
    replaying.current = true;
    cursor.current = at;
    resetDocument(JSON.parse(history.current[at]));
    replaying.current = false;
    setSelectedBlockId(null);
  }
  const block = selected ? doc[selected] : null,
    p: any = block?.data?.props || {},
    s: any = block?.data?.style || {};
  const field = (label: string, key: string, kind = "text", root = false) => {
    const value = root ? (doc.root.data as any)[key] : p[key];
    return (
      <div key={key}>
        <label htmlFor={`property-${key}`}>{label}</label>
        {kind === "textarea" ? (
          <textarea
            id={`property-${key}`}
            value={value ?? ""}
            onChange={(e) => patch(key, e.target.value, root)}
          />
        ) : (
          <input
            id={`property-${key}`}
            type={kind}
            value={value ?? ""}
            onChange={(e) =>
              patch(key, kind === "number" ? Number(e.target.value) : e.target.value, root)
            }
          />
        )}
      </div>
    );
  };
  return (
    <>
      <header>
        <strong>Конструктор письма</strong>
        <button onClick={() => undo(-1)} disabled={cursor.current < 1}>
          Отменить
        </button>
        <button onClick={() => undo(1)} disabled={cursor.current >= history.current.length - 1}>
          Повторить
        </button>
        <button onClick={() => setMobile(!mobile)}>{mobile ? "Компьютер" : "Телефон"}</button>
      </header>
      {error && <p role="alert">{error}</p>}
      <div className="builder-grid">
        <aside>
          <nav>
            {[
              ["content", "Содержимое"],
              ["rows", "Строки"],
              ["settings", "Настройки"],
            ].map(([value, label]) => (
              <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
                {label}
              </button>
            ))}
          </nav>
          {tab === "content" && (
            <>
              <div className="palette">
                {Object.entries(palette).map(([type, [label]]: any) => (
                  <button
                    key={type}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", type)}
                    onClick={() => add(type)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p>
                Добавьте блок кнопкой или перетащите на письмо. Внутри колонок используйте кнопку
                «+».
              </p>
            </>
          )}
          {tab === "rows" && (
            <div className="palette">
              {[1, 2, 3, 4, 6].map((count) => (
                <button key={count} onClick={() => add("ColumnsContainer", count)}>
                  Строка: {count} колонок
                </button>
              ))}
            </div>
          )}
          {tab === "settings" && (
            <>
              {field("Ширина письма, px", "width", "number", true)}
              {field("Фон страницы", "backdropColor", "color", true)}
              {field("Фон письма", "canvasColor", "color", true)}
              {field("Цвет текста", "textColor", "color", true)}
              <label>
                Шрифт
                <select
                  value={(doc.root.data as any).fontFamily || "MODERN_SANS"}
                  onChange={(e) => patch("fontFamily", e.target.value, true)}
                >
                  <option value="MODERN_SANS">Arial</option>
                  <option value="BOOK_SERIF">Georgia</option>
                  <option value="MONOSPACE">Courier New</option>
                </select>
              </label>
            </>
          )}
          <h3>Блоки</h3>
          {Object.entries(doc)
            .filter(([id]) => id !== "root")
            .map(([id, b]: any) => (
              <button
                className="block-select"
                key={id}
                aria-pressed={selected === id}
                onClick={() => setSelectedBlockId(id)}
              >
                {palette[b.type]?.[0] || "Строка"} ·{" "}
                {String(b.data.props?.text || b.data.props?.alt || "").slice(0, 24)}
              </button>
            ))}
        </aside>
        <main
          className={mobile ? "mobile" : ""}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData("text/plain");
            if (palette[type]) add(type);
          }}
        >
          <EditorBlock id="root" />
        </main>
        <aside>
          <h3>Свойства блока</h3>
          {block && selected !== "root" ? (
            <>
              <div className="actions">
                {[
                  ["copy", "Дублировать"],
                  ["up", "Выше"],
                  ["down", "Ниже"],
                  ["delete", "Удалить"],
                ].map(([key, label]) => (
                  <button key={key} onClick={() => action(key)}>
                    {label}
                  </button>
                ))}
              </div>
              {["Text", "Heading", "Button"].includes(block.type) &&
                field("Текст блока", "text", "textarea")}
              {block.type === "Heading" && (
                <label>
                  Уровень
                  <select value={p.level || "h2"} onChange={(e) => patch("level", e.target.value)}>
                    {["h1", "h2", "h3"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              )}
              {["Image", "Button"].includes(block.type) && field("Ссылка HTTPS", "url")}
              {block.type === "Image" && (
                <>
                  {field("Описание изображения", "alt")}
                  {field("Ширина изображения", "width", "number")}
                  <button onClick={() => post("image", { blockId: selected })}>
                    Загрузить / выбрать картинку
                  </button>
                </>
              )}
              {block.type === "Html" && field("HTML блока", "contents", "textarea")}
              {block.type === "Spacer" && field("Высота, px", "height", "number")}
              {block.type === "Divider" && field("Цвет линии", "lineColor", "color")}
              {block.type === "Table" && (
                <>
                  {field("Строки таблицы (колонки через Tab)", "rows", "textarea")}
                  <p>До 100 строк и 10 колонок. Первая строка — заголовки.</p>
                </>
              )}
              {["Social", "Menu"].includes(block.type) &&
                field("Ссылки: название|https://адрес (по одной в строке)", "links", "textarea")}
              {block.type === "Icons" && field("Символы иконок", "text")}
              {["Sticker", "Gif", "Video"].includes(block.type) && (
                <>
                  {field("Адрес HTTPS", "url")}
                  {field("Описание", "alt")}
                  <button onClick={() => post("image", { blockId: selected })}>
                    Выбрать изображение блока
                  </button>
                </>
              )}
              {block.type === "Video" && (
                <>
                  {field("Картинка превью HTTPS", "thumbnail")}
                  <p>Видео откроется по ссылке. Плеер в письмо не вставляется.</p>
                </>
              )}
              {block.type === "Gallery" && (
                <>
                  {field("Адреса изображений HTTPS (по одному в строке)", "images", "textarea")}
                  {field("Описание", "alt")}
                  <button onClick={() => post("image", { blockId: selected })}>
                    Добавить картинку галереи
                  </button>
                  <p>До 12 изображений; в письме показываются последовательно для совместимости.</p>
                </>
              )}
              {block.type === "Countdown" && (
                <>
                  {field("Дата ISO с часовым поясом", "deadline")}
                  {field("Часовой пояс отображения", "timezone")}
                  {field("Цвет цифр", "foreground", "color")}
                  {field("Фон таймера", "background", "color")}
                  <p>
                    Например, 2026-12-31T18:00:00+03:00. Отсчёт определяется смещением в дате. После
                    срока — нули. GIF обновляется при загрузке и отсчитывает 60 секунд; почтовые
                    клиенты могут кэшировать картинку.
                  </p>
                </>
              )}
              {block.type === "ColumnsContainer" && (
                <>
                  {p.columns.map((_: any, index: number) => (
                    <label key={index}>
                      Доля колонки {index + 1}
                      <input
                        type="number"
                        min="1"
                        max="12"
                        value={p.ratios?.[index] || 1}
                        onChange={(e) => {
                          const ratios = p.columns.map((_: any, i: number) => p.ratios?.[i] || 1);
                          ratios[index] = Math.max(1, Math.min(12, Number(e.target.value)));
                          patch("ratios", ratios);
                        }}
                      />
                    </label>
                  ))}
                  <label>
                    <input
                      type="checkbox"
                      checked={!!p.mobileReverse}
                      onChange={(e) => patch("mobileReverse", e.target.checked)}
                    />
                    Обратный порядок на телефоне
                  </label>
                </>
              )}
              <label>
                Цвет блока
                <input
                  type="color"
                  value={s.backgroundColor || "#ffffff"}
                  onChange={(e) => style("backgroundColor", e.target.value)}
                />
              </label>
              <label>
                Размер шрифта
                <input
                  type="number"
                  min="8"
                  max="100"
                  value={s.fontSize || 16}
                  onChange={(e) => style("fontSize", Number(e.target.value))}
                />
              </label>
              <label>
                Выравнивание
                <select
                  value={s.textAlign || "left"}
                  onChange={(e) => style("textAlign", e.target.value)}
                >
                  {["left", "center", "right"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Отступы, px
                <input
                  type="number"
                  min="0"
                  max="200"
                  value={s.padding?.top || 0}
                  onChange={(e) =>
                    style("padding", {
                      top: Number(e.target.value),
                      right: Number(e.target.value),
                      bottom: Number(e.target.value),
                      left: Number(e.target.value),
                    })
                  }
                />
              </label>
            </>
          ) : (
            <p>Выберите блок в письме или в списке слева.</p>
          )}
        </aside>
      </div>
    </>
  );
}
createRoot(document.getElementById("builder")!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <Builder />
  </ThemeProvider>,
);
