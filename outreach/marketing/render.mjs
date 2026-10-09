import { createHash } from "node:crypto";
import { marked } from "marked";
import sanitize from "sanitize-html";
import { convert } from "html-to-text";
import { render, escapeHTML } from "../core.mjs";
import { invalid } from "./contracts.mjs";
import { builderHTML, builderResponsiveCSS } from "./builder.mjs";
const size = /^(?:\d{1,4}(?:px|pt|em|rem|%)|auto)$/;
const color = /^(?:#[a-f\d]{3,8}|[a-z]{1,20}|rgba?\([\d\s.,%]+\))$/i;
const spacing =
  /^\d{1,4}(?:px|pt|em|rem|%)(?:\s+\d{1,4}(?:px|pt|em|rem|%)){0,3}$/;
export function compileSource(source, editorMode) {
  if (typeof source !== "string" || source.length > 220000)
    throw invalid("Исходник письма слишком большой");
  if (!["html", "markdown"].includes(editorMode))
    throw invalid("Неизвестный редактор");
  const html =
    editorMode === "markdown"
      ? marked.parse(source, { gfm: true, breaks: true, async: false })
      : source;
  return sanitize(html, {
    allowedTags: [
      "p",
      "br",
      "b",
      "strong",
      "em",
      "i",
      "u",
      "s",
      "del",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "hr",
      "a",
      "img",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "td",
      "th",
      "div",
      "span",
      "center",
    ],
    allowedAttributes: {
      "*": ["style", "align", "dir", "lang", "class"],
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      table: [
        "width",
        "height",
        "border",
        "cellpadding",
        "cellspacing",
        "role",
        "bgcolor",
      ],
      td: ["width", "height", "colspan", "rowspan", "valign", "bgcolor"],
      th: ["width", "height", "colspan", "rowspan", "valign", "bgcolor"],
    },
    allowedStyles: {
      "*": {
        color: [color],
        "background-color": [color],
        width: [size],
        "max-width": [size],
        "min-width": [size],
        height: [size],
        "font-size": [size],
        "font-family": [/^[a-z\s,'"-]{1,120}$/i],
        "font-weight": [/^(normal|bold|[1-9]00)$/],
        "font-style": [/^(normal|italic)$/],
        "line-height": [/^(?:\d{1,4}(?:px|pt|em|rem|%)?|normal)$/],
        "text-align": [/^(left|right|center|justify)$/],
        "text-decoration": [/^(none|underline|line-through)$/],
        padding: [spacing],
        margin: [spacing],
        "padding-top": [size],
        "padding-bottom": [size],
        "padding-left": [size],
        "padding-right": [size],
        border: [
          /^\d{1,2}px\s+(solid|dashed|dotted)\s+(#[a-f\d]{3,8}|[a-z]+)$/i,
        ],
        "border-radius": [size],
        "border-collapse": [/^(collapse|separate)$/],
        "vertical-align": [/^(top|middle|bottom)$/],
        display: [/^(block|inline|inline-block|none)$/],
      },
    },
    allowedSchemes: ["https", "http", "mailto", "tel"],
    allowedClasses: { "*": ["mk-column", "mk-row", "mk-reverse"] },
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tag, attrs) => ({
        tagName: tag,
        attribs: { ...attrs, target: "_blank", rel: "noopener noreferrer" },
      }),
      img: (tag, attrs) => {
        const src = attrs.src || "";
        const allowed =
          /^https:\/\//i.test(src) ||
          /^\/marketing-media\/[a-f\d]{64}$/.test(src) ||
          /^\/marketing-countdown\/\d{13}-[a-f\d]{6}-[a-f\d]{6}\.gif$/i.test(
            src,
          );
        return { tagName: tag, attribs: { ...attrs, src: allowed ? src : "" } };
      },
    },
  });
}
const literalValue = (value, mode) => {
  let result = escapeHTML(String(value))
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("|", "&#124;");
  if (mode === "markdown")
    result = result.replace(/[\\`*_[\]()#+.!-]/g, "\\$&");
  return result;
};
export function renderLetter({
  source,
  editorMode,
  contact = {},
  rotationSeed = "preview",
  context = {},
}) {
  const builder = editorMode === "builder";
  if (builder) {
    source = builderHTML(source);
    editorMode = "html";
  }
  if (typeof source !== "string") throw invalid("Проверьте исходник письма");
  const fields = {
    ...contact.fields,
    email: contact.email,
    name: contact.name,
  };
  const variables = {};
  for (const match of source.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const token = match[1],
      separator = token.indexOf("|"),
      key = (separator < 0 ? token : token.slice(0, separator)).trim();
    const value = fields[key];
    const fallback =
      separator < 0 ? undefined : token.slice(separator + 1).trim();
    const resolved =
      value !== undefined && String(value).trim() !== "" ? value : fallback;
    if (resolved !== undefined)
      Object.defineProperty(variables, token, {
        value: literalValue(resolved, editorMode),
        enumerable: true,
      });
  }
  let count = 0;
  const choose = (limit) =>
    createHash("sha256")
      .update(`${rotationSeed}:${count++}`)
      .digest()
      .readUInt32BE(0) % limit;
  let expanded;
  try {
    expanded = render(source, variables, {}, new Set(), {
      choose,
      html: editorMode === "html",
    });
  } catch (error) {
    throw invalid(error.message);
  }
  let content = compileSource(expanded, editorMode);
  if (context.publicURL) {
    const base = new URL(context.publicURL);
    if (
      !["https:", "http:"].includes(base.protocol) ||
      base.username ||
      base.password
    )
      throw invalid("Проверьте публичный адрес сервиса");
    content = content.replace(
      /src="(\/(?:marketing-media\/[a-f\d]{64}|marketing-countdown\/\d{13}-[a-f\d]{6}-[a-f\d]{6}\.gif))"/g,
      (_, path) => `src="${escapeHTML(new URL(path, base.origin).href)}"`,
    );
  } else if (
    context.type === "production" &&
    /src="\/marketing-(?:media|countdown)\//.test(content)
  )
    throw invalid("Для изображений требуется публичный адрес сервиса");
  const warnings = [];
  if (/<script\b|\son\w+\s*=|javascript:/i.test(source))
    warnings.push("Опасная HTML-разметка удалена из результата");
  let footer = "<span>Отписка (предпросмотр, действие недоступно)</span>";
  if (context.type === "production") {
    let url;
    try {
      url = new URL(context.unsubscribeUrl);
    } catch {
      throw invalid("Для отправки требуется рабочая ссылка отписки");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      throw invalid("Проверьте ссылку отписки");
    footer = `<a href="${escapeHTML(url.href)}">Отписаться от рассылки</a>`;
  }
  const body = `${content}<div style="margin:24px 0;font-size:12px;color:#667085">${escapeHTML(context.organization || "Отправитель рассылки")}<br>${footer}</div>`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${builder ? builderResponsiveCSS : ""}</head><body>${body}</body></html>`;
  return { html, text: convert(body, { wordwrap: 100 }), warnings };
}
