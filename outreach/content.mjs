import { marked } from "marked";
import sanitize from "sanitize-html";
import { convert } from "html-to-text";
import { escapeHTML, requireValue } from "./core.mjs";

export function contentFormat(value = "plain") {
  requireValue(
    ["plain", "markdown"].includes(value),
    "Формат: обычный текст или Markdown",
  );
  return value;
}
export function validateImage(data, mime) {
  requireValue(
    Buffer.isBuffer(data) && data.length > 0 && data.length <= 2_000_000,
    "Изображение: максимум 2 МБ",
  );
  let detected = "";
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    detected = "image/png";
  else if (data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")))
    detected = "image/jpeg";
  else if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString()))
    detected = "image/gif";
  else if (
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP"
  )
    detected = "image/webp";
  requireValue(
    detected && detected === mime,
    "Поддерживаются PNG, JPEG, GIF и WebP; формат файла должен совпадать",
  );
  return detected;
}
// One renderer is used for previews and SMTP. No file reads or remote URL fetches.
export function renderContent(
  message,
  resolveImage = () => null,
  forEmail = false,
) {
  const attachments = new Map();
  const part = (body = "", format = "plain") => {
    requireValue(
      typeof body === "string" && body.length <= 220_000,
      "Письмо слишком большое",
    );
    if (contentFormat(format) === "plain")
      return {
        html: `<div style="white-space:pre-wrap;">${escapeHTML(body).replace(/\r?\n/g, "<br>")}</div>`,
        text: body,
      };
    const html = sanitize(
      marked.parse(body, { gfm: true, breaks: true, async: false }),
      {
        allowedTags: [
          "p",
          "br",
          "strong",
          "b",
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
          "tr",
          "td",
          "th",
          "div",
          "span",
        ],
        allowedAttributes: {
          "*": ["style"],
          a: ["href", "title", "target", "rel"],
          img: ["src", "alt", "title", "width", "height"],
          td: ["align", "colspan", "rowspan"],
          th: ["align", "colspan", "rowspan"],
        },
        allowedStyles: {
          "*": {
            color: [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i],
            "background-color": [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i],
            "text-align": [/^(left|right|center)$/],
            "font-weight": [/^(normal|bold|[1-9]00)$/],
            "font-style": [/^(normal|italic)$/],
            "font-size": [/^\d{1,2}(px|pt)$/],
            "text-decoration": [/^(none|underline|line-through)$/],
          },
        },
        allowedSchemes: ["https", "http", "mailto", "tel"],
        allowedSchemesByTag: { img: ["https", "cid"] },
        allowProtocolRelative: false,
        transformTags: {
          a: (tag, attrs) => ({
            tagName: tag,
            attribs: {
              ...attrs,
              href: /^(https?:|mailto:|tel:)/i.test(attrs.href || "")
                ? attrs.href
                : "",
              target: "_blank",
              rel: "noopener noreferrer",
            },
          }),
          img: (tag, attrs) => {
            const match = String(attrs.src || "").match(
              /^\/api\/images\/([a-f0-9]{32})$/,
            );
            let src = "";
            if (match) {
              const asset = resolveImage(match[1]);
              requireValue(asset, "Картинка не найдена. Загрузите её заново.");
              src = forEmail ? `cid:${match[1]}@dmailio` : attrs.src;
              if (forEmail)
                attachments.set(match[1], {
                  filename: `image.${asset.mime.split("/")[1]}`,
                  content: Buffer.from(asset.data),
                  contentType: asset.mime,
                  cid: `${match[1]}@dmailio`,
                  contentDisposition: "inline",
                });
            } else if (/^https:\/\//i.test(attrs.src || "")) src = attrs.src;
            const dimension = (v) =>
              /^\d{1,4}$/.test(v || "")
                ? String(Math.min(1200, Math.max(1, Number(v))))
                : undefined;
            return {
              tagName: tag,
              attribs: {
                src,
                alt: attrs.alt || "",
                title: attrs.title || "",
                width: dimension(attrs.width),
                height: dimension(attrs.height),
              },
            };
          },
        },
      },
    );
    return {
      html,
      text: convert(html, {
        wordwrap: false,
        selectors: [
          { selector: "img", format: "skip" },
          { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
        ],
      }),
    };
  };
  const main = part(message.body || "", message.format || "plain");
  const signature = part(
    message.signature || "",
    message.signature_format || "plain",
  );
  if (message.signature_marker) {
    requireValue(
      message.format === "plain" &&
        /^[a-f0-9-]{36}$/.test(message.signature_marker),
      "Некорректная вставка подписи",
    );
    main.html = main.html.replaceAll(
      message.signature_marker,
      `<div style="white-space:normal;">${signature.html}</div>`,
    );
    main.text = main.text.replaceAll(message.signature_marker, signature.text);
  }
  const append = message.signature && !message.signature_marker;
  let html = main.html + (append ? `<br><br><div>${signature.html}</div>` : "");
  // Portable inline layout for mail clients; user CSS cannot override positioning.
  html = html
    .replace(/<img /g, '<img style="max-width:100%;height:auto;" ')
    .replace(
      /<table>/g,
      '<table style="border-collapse:collapse;" cellpadding="8">',
    )
    .replace(/<(td|th)(?=[ >])/g, '<$1 style="border:1px solid #dfe3e8;"');
  return {
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;overflow-wrap:anywhere;">${html}</div>`,
    text: main.text + (append ? "\n\n" + signature.text : ""),
    attachments: [...attachments.values()],
  };
}
