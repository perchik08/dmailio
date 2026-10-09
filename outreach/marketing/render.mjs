import { createHash } from "node:crypto";
import { marked } from "marked";
import sanitize from "sanitize-html";
import postcss from "postcss";
import { convert } from "html-to-text";
import { render, escapeHTML } from "../core.mjs";
import { invalid } from "./contracts.mjs";
import { builderHTML, builderResponsiveCSS } from "./builder.mjs";
const size = /^(?:0|\d{1,4}(?:\.\d{1,4})?(?:px|pt|em|rem|%)|auto)$/;
const color = /^(?:#[a-f\d]{3,8}|[a-z]{1,20}|rgba?\([\d\s.,%]+\))$/i;
const spacing =
  /^(?:0|auto|\d{1,4}(?:\.\d{1,4})?(?:px|pt|em|rem|%))(?:\s+(?:0|auto|\d{1,4}(?:\.\d{1,4})?(?:px|pt|em|rem|%))){0,3}$/;
const safeStyles = {
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
    "line-height": [/^(?:\d{1,4}(?:\.\d{1,4})?(?:px|pt|em|rem|%)?|normal)$/],
    "text-align": [/^(left|right|center|justify)$/],
    "text-decoration": [/^(none|underline|line-through)$/],
    padding: [spacing],
    margin: [spacing],
    "padding-top": [size],
    "padding-bottom": [size],
    "padding-left": [size],
    "padding-right": [size],
    border: [/^\d{1,2}px\s+(solid|dashed|dotted)\s+(#[a-f\d]{3,8}|[a-z]+)$/i],
    "border-radius": [size],
    "border-collapse": [/^(collapse|separate)$/],
    "vertical-align": [/^(top|middle|bottom)$/],
    display: [/^(block|inline|inline-block|none)$/],
  },
};
export function compileSource(source, editorMode) {
  if (typeof source !== "string" || source.length > 220000)
    throw invalid("Исходник письма слишком большой");
  if (!["html", "markdown"].includes(editorMode))
    throw invalid("Неизвестный редактор");
  const html =
    editorMode === "markdown"
      ? marked.parse(source, { gfm: true, breaks: true, async: false })
      : source;
  const sheets = [];
  const markup = html.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
    (_, css) => {
      try {
        const tree = postcss.parse(css);
        tree.walkAtRules((rule) => {
          if (
            rule.name.toLowerCase() !== "media" ||
            !/^(?:(?:only\s+)?screen\s+and\s+)?\((?:min|max)-width:\s*\d{1,4}px\)$/i.test(
              rule.params,
            )
          )
            rule.remove();
        });
        tree.walkRules((rule) => {
          if (!/^[a-zA-Z0-9_.#,:>+~*\s()-]{1,300}$/.test(rule.selector))
            rule.remove();
        });
        tree.walkDecls((decl) => {
          const validators = safeStyles["*"][decl.prop.toLowerCase()];
          if (
            !validators?.some((pattern) => pattern.test(decl.value)) ||
            decl.parent.type !== "rule"
          )
            decl.remove();
        });
        tree.walkComments((comment) => comment.remove());
        const safe = tree.toString().replace(/</g, "");
        if (safe) sheets.push(`<style>${safe}</style>`);
      } catch {}
      return "";
    },
  );
  return (
    sheets.join("") +
    sanitize(markup, {
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
      allowedStyles: safeStyles,
      allowedSchemes: ["https", "http", "mailto", "tel"],
      allowedClasses: { "*": [/^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/] },
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
          return {
            tagName: tag,
            attribs: { ...attrs, src: allowed ? src : "" },
          };
        },
      },
    })
  );
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
  preheader = "",
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
  if (typeof preheader !== "string" || preheader.length > 500)
    throw invalid("Проверьте прехедер");
  const variables = {};
  const headerVariables = {};
  for (const match of (source + "\n" + preheader).matchAll(
    /\{\{\s*([^{}]+?)\s*\}\}/g,
  )) {
    const token = match[1],
      separator = token.indexOf("|"),
      key = (separator < 0 ? token : token.slice(0, separator)).trim();
    const value = fields[key];
    const fallback =
      separator < 0 ? undefined : token.slice(separator + 1).trim();
    const resolved =
      value !== undefined && String(value).trim() !== "" ? value : fallback;
    if (resolved !== undefined) {
      Object.defineProperty(headerVariables, token, {
        value: String(resolved),
        enumerable: true,
        configurable: true,
      });
      Object.defineProperty(variables, token, {
        value: literalValue(resolved, editorMode),
        enumerable: true,
        configurable: true,
      });
    }
  }
  let count = 0;
  const choose = (limit) =>
    createHash("sha256")
      .update(`${rotationSeed}:${count++}`)
      .digest()
      .readUInt32BE(0) % limit;
  let expanded, expandedHeader;
  try {
    expanded = render(source, variables, {}, new Set(), {
      choose,
      html: editorMode === "html",
      literalVariables: true,
    });
    expandedHeader = render(preheader, headerVariables, {}, new Set(), {
      choose,
      literalVariables: true,
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
  const header = expandedHeader
    ? `<div data-preheader style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHTML(expandedHeader)}</div>`
    : "";
  const body = `${content}<div style="margin:24px 0;font-size:12px;color:#667085">${escapeHTML(context.organization || "Отправитель рассылки")}<br>${footer}</div>`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${builder ? builderResponsiveCSS : ""}</head><body>${header}${body}</body></html>`;
  return { html, text: convert(body, { wordwrap: 100 }), warnings };
}
