import test from "node:test";
import assert from "node:assert/strict";
import { renderLetter } from "../marketing/render.mjs";
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
