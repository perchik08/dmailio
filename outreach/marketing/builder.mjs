import { escapeHTML } from "../core.mjs";
import { marked } from "marked";
import { invalid } from "./contracts.mjs";
import {
  advancedTypes,
  advancedHTML,
} from "../public/marketing/builder-blocks.js";
const types = new Set([
  "EmailLayout",
  "ColumnsContainer",
  "Container",
  "Text",
  "Heading",
  "Image",
  "Button",
  "Divider",
  "Spacer",
  "Html",
  "Avatar",
  ...advancedTypes,
]);
const esc = (value) => escapeHTML(String(value ?? ""));
const number = (value, fallback, min = 0, max = 1200) =>
  Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Number(value)))
    : fallback;
export const emptyBuilder = () => ({
  schemaVersion: 1,
  document: { root: { type: "EmailLayout", data: { childrenIds: [] } } },
});
export function parseBuilder(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw invalid("Проверьте JSON конструктора");
  }
  if (value?.schemaVersion !== 1)
    throw invalid("Неизвестная версия конструктора");
  const doc = value.document;
  if (
    !doc ||
    typeof doc !== "object" ||
    Array.isArray(doc) ||
    Object.keys(doc).length > 1000 ||
    doc.root?.type !== "EmailLayout"
  )
    throw invalid("Проверьте корневой блок");
  for (const [id, block] of Object.entries(doc)) {
    if (
      !/^[\w-]{1,100}$/.test(id) ||
      !block ||
      !types.has(block.type) ||
      !block.data ||
      typeof block.data !== "object"
    )
      throw invalid("Неизвестный блок конструктора");
    const columns = block.data.props?.columns;
    if (
      block.type === "ColumnsContainer" &&
      (!Array.isArray(columns) || ![1, 2, 3, 4, 6].includes(columns.length))
    )
      throw invalid("Выберите 1, 2, 3, 4 или 6 колонок");
  }
  const visited = new Set(),
    active = new Set();
  function visit(id, depth) {
    if (!doc[id]) throw invalid("Не найден блок " + id);
    if (active.has(id) || depth > 30)
      throw invalid("Обнаружен цикл или слишком глубокая вложенность");
    if (visited.has(id))
      throw invalid("Блок повторно используется в документе");
    active.add(id);
    visited.add(id);
    const block = doc[id],
      data = block.data;
    const children =
      block.type === "EmailLayout"
        ? data.childrenIds
        : block.type === "Container"
          ? data.props?.childrenIds
          : block.type === "ColumnsContainer"
            ? data.props.columns.flatMap((c) => c.childrenIds || [])
            : [];
    if (children != null && !Array.isArray(children))
      throw invalid("Проверьте дочерние блоки");
    for (const child of children || []) visit(child, depth + 1);
    active.delete(id);
  }
  visit("root", 0);
  return value;
}
function style(data) {
  const s = data.style || {},
    values = [];
  const keys = {
    color: "color",
    backgroundColor: "background-color",
    textAlign: "text-align",
    fontWeight: "font-weight",
    fontFamily: "font-family",
  };
  for (const [key, css] of Object.entries(keys))
    if (s[key] != null) values.push(`${css}:${s[key]}`);
  if (s.fontSize != null)
    values.push(`font-size:${number(s.fontSize, 16, 8, 100)}px`);
  if (s.padding)
    values.push(
      `padding:${["top", "right", "bottom", "left"].map((k) => number(s.padding[k], 0, 0, 200) + "px").join(" ")}`,
    );
  return esc(values.join(";"));
}
// Compile the persisted Waypoint document on the server. Never trust HTML from an iframe.
export function builderHTML(source) {
  const { document: doc } = parseBuilder(source);
  const children = (ids) => (ids || []).map(render).join("");
  function render(id) {
    const { type, data } = doc[id],
      p = data.props || {},
      s = style(data);
    let html = "";
    switch (type) {
      case "EmailLayout": {
        const fonts = {
          MODERN_SANS: "Arial, sans-serif",
          MONOSPACE: "Courier New, monospace",
          BOOK_SERIF: "Georgia, serif",
        };
        return `<div style="background-color:${esc(data.backdropColor || "#f5f5f5")};padding:24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${number(data.width, 600, 320, 1000)}px;margin:0 auto;background-color:${esc(data.canvasColor || "#fff")};color:${esc(data.textColor || "#262626")};font-family:${esc(fonts[data.fontFamily] || fonts.MODERN_SANS)};font-size:16px"><tbody><tr><td>${children(data.childrenIds)}</td></tr></tbody></table></div>`;
      }
      case "Container":
        html = children(p.childrenIds);
        break;
      case "ColumnsContainer": {
        const columns = p.columns;
        const ratios = columns.map((_, i) => number(p.ratios?.[i], 1, 1, 12));
        const sum = ratios.reduce((a, b) => a + b, 0);
        html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody><tr class="${p.mobileReverse ? "mk-reverse" : "mk-row"}">${columns.map((c, i) => `<td class="mk-column" width="${(100 * ratios[i]) / sum}%" valign="top">${children(c.childrenIds)}</td>`).join("")}</tr></tbody></table>`;
        break;
      }
      case "Text":
        html = marked.parse(String(p.text || ""), {
          async: false,
          breaks: true,
        });
        break;
      case "Heading": {
        const level = ["h1", "h2", "h3"].includes(p.level) ? p.level : "h2";
        html = `<${level}>${esc(p.text)}</${level}>`;
        break;
      }
      case "Button":
        html = `<a href="${esc(p.url)}" style="display:inline-block;background-color:${esc(p.buttonBackgroundColor || "#535ff4")};color:${esc(p.buttonTextColor || "#fff")};padding:12px 24px;border-radius:${number(p.borderRadius, 4)}px;text-decoration:none">${esc(p.text)}</a>`;
        break;
      case "Image":
        html = `<img src="${esc(p.url)}" alt="${esc(p.alt)}" ${p.width ? `width="${number(p.width, 600)}"` : ""} style="max-width:100%;height:auto">`;
        if (p.linkHref) html = `<a href="${esc(p.linkHref)}">${html}</a>`;
        break;
      case "Avatar":
        html = `<img src="${esc(p.imageUrl)}" alt="${esc(p.alt)}" width="64" style="border-radius:32px">`;
        break;
      case "Divider":
        html = `<hr style="border:1px solid ${esc(p.lineColor || "#ccc")}">`;
        break;
      case "Spacer":
        html = `<div style="height:${number(p.height, 24, 0, 500)}px">&nbsp;</div>`;
        break;
      case "Html":
        html = String(p.contents || "");
        break;
      default:
        try {
          html = advancedHTML(type, p);
        } catch (error) {
          throw invalid(error.message);
        }
    }
    return `<div style="${s}">${html}</div>`;
  }
  return render("root");
}
export const builderResponsiveCSS =
  "<style>@media(max-width:600px){.mk-column{display:block!important;width:100%!important}.mk-reverse{display:flex!important;flex-direction:column-reverse}.mk-reverse>.mk-column{box-sizing:border-box}}</style>";
