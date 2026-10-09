import test from "node:test";
import assert from "node:assert/strict";
import { renderLetter, compileSource } from "../marketing/render.mjs";
test("HTML and Markdown use stable rotation, safe literal variables, fallback and inert preview footer", () => {
  const request = {
    source:
      '<table style="width:600px"><tr><td style="padding:20px">{Привет|Здравствуйте}, {{firstName|коллега}}!</td></tr></table><script>alert(1)</script>',
    editorMode: "html",
    contact: { fields: { firstName: "<img src=x onerror=evil()> {{other}}" } },
    rotationSeed: "fixed",
  };
  const first = renderLetter(request);
  assert.equal(renderLetter(request).html, first.html);
  assert.match(first.html, /padding:20px/);
  assert.match(first.html, /&lt;img/);
  assert.doesNotMatch(first.html, /<script/);
  assert.match(first.html, /Отписка.*предпросмотр/);
  assert.doesNotMatch(first.html, /href=.*unsubscribe/);
  const markdown = renderLetter({
    source: "# Заголовок\n\n{{missing|коллега}}",
    editorMode: "markdown",
  });
  assert.match(markdown.html, /<h1/);
  assert.match(markdown.text, /коллега/);
  assert.throws(
    () => renderLetter({ source: "{{missing}}", editorMode: "html" }),
    /missing/,
  );
  assert.throws(
    () =>
      renderLetter({
        source: "Body",
        editorMode: "html",
        context: { type: "production" },
      }),
    /отписк/,
  );
});
test("safe email spacing, decimal line height and responsive stylesheet survive sanitization", () => {
  const html = compileSource(
    '<style>@import "https://evil.invalid";@media screen and (max-width:600px){.mobile{width:100%;padding:0;background:url(https://evil.invalid/x)}}.spacing{margin:0 auto;line-height:1.5}</style><p class="mobile spacing" style="margin:0 auto;padding:24px 0;line-height:1.5">Hi</p>',
    "html",
  );
  assert.match(html, /margin:0 auto/);
  assert.match(html, /line-height:1.5/);
  assert.match(html, /padding:24px 0/);
  assert.match(html, /@media/);
  assert.match(html, /class="mobile spacing"/);
  assert.doesNotMatch(html, /evil\.invalid|@import|url\(/);
});
test("preheader is included, hidden and safely personalized in every editor mode", () => {
  const rendered = renderLetter({
    source: "<p>Body</p>",
    editorMode: "html",
    preheader: "Для {{name}} {сегодня|сейчас}",
    contact: { name: "<script>alert(1)</script> {{missing}}" },
    rotationSeed: "fixed",
  });
  assert.match(rendered.html, /data-preheader/);
  assert.match(rendered.html, /display:none/);
  assert.match(rendered.html, /Для &lt;script&gt;/);
  assert.match(rendered.html, /\{\{missing\}\}/);
  assert.doesNotMatch(rendered.html, /<script/);
});

test("stylesheet survives final HTML export alongside fallback personalization", () => {
  const rendered = renderLetter({
    source:
      '<style>@media screen and (max-width:600px){.mobile{width:100%;padding:0}}</style><p class="mobile">{{firstName|Коллега}}</p>',
    editorMode: "html",
  });
  assert.match(rendered.html, /@media/);
  assert.match(rendered.html, /class="mobile"/);
  assert.match(rendered.html, /Коллега/);
});

test("repeated variables in body and preheader stay literal", () => {
  const result = renderLetter({
    source: "{{name}} / {{name}}",
    preheader: "{{name}}",
    editorMode: "html",
    contact: { name: "Анна {{other}}" },
  });
  assert.match(result.html, /data-preheader/);
  assert.match(result.text, /Анна \{\{other\}\}/);
});
