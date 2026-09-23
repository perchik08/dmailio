import test from "node:test";
import assert from "node:assert/strict";
import { renderContent, validateImage } from "../content.mjs";
test("plain fragments preserve indentation and repeated spaces", () => {
  assert.match(
    renderContent({ body: "  text    spaced\n\tindented" }).html,
    /white-space:pre-wrap/,
  );
});
test("inline signature retains rich format inside a legacy plain message", () => {
  const marker = "11111111-1111-1111-1111-111111111111";
  const p = renderContent({
    body: `**literal**\n${marker}\nPS`,
    format: "plain",
    signature: "**Иван**",
    signature_format: "markdown",
    signature_marker: marker,
  });
  assert.match(p.html, /\*\*literal\*\*/);
  assert.match(p.html, /<strong>Иван<\/strong>/);
  assert.equal(p.text, "**literal**\nИван\nPS");
  assert.doesNotMatch(p.html, /11111111/);
});

test("Markdown supports formatted email, tables, links and readable plain alternative", () => {
  const p = renderContent({
    body: "# Привет\n\n**Важно** и [Telegram](https://t.me/example)\n\n| Имя | Роль |\n| --- | --- |\n| Иван | CEO |",
    format: "markdown",
    signature: "С уважением,\n**Иван**",
    signature_format: "markdown",
  });
  assert.match(p.html, /<strong>Важно<\/strong>/);
  assert.match(p.html, /<table/);
  assert.match(p.html, /href="https:\/\/t.me\/example"/);
  assert.match(p.text, /С уважением/);
  assert.doesNotMatch(p.text, /\*\*Иван/);
});
test("rich editor HTML preserves safe text styles and strips executable markup", () => {
  const p = renderContent({
    body: '<p style="text-align:center"><span style="font-family:Arial;font-size:16px;color:#334455;background-color:#ffeeaa">Привет</span> <strong>друг</strong></p><ul><li>Пункт</li></ul><script>alert(1)</script>',
    format: "markdown",
  });
  assert.match(p.html, /text-align:center/);
  assert.match(p.html, /<span[^>]*font-family:Arial/);
  assert.match(p.html, /font-size:16px/);
  assert.match(p.html, /<strong>друг<\/strong>/);
  assert.match(p.html, /<ul><li>Пункт<\/li><\/ul>/);
  assert.doesNotMatch(p.html, /<script|alert\(1\)/);
});
test("untrusted HTML and URL schemes cannot execute or load local files", () => {
  const p = renderContent({
    body: '<script>alert(1)</script><img src="file:///secret" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><iframe src="https://evil.example"></iframe><div style="position:fixed;color:red">text</div>',
    format: "markdown",
  });
  assert.doesNotMatch(
    p.html,
    /script|onerror|file:|javascript:|iframe|position:fixed/i,
  );
});
test("existing plain messages remain literal and keep their line breaks", () => {
  const p = renderContent({ body: "**literal**\n<script>text</script>" });
  assert.match(p.html, /\*\*literal\*\*<br/);
  assert.match(p.html, /&lt;script&gt;/);
  assert.equal(p.text, "**literal**\n<script>text</script>");
});
test("uploaded images use authenticated preview URLs and deduplicated CID attachments in email", () => {
  const id = "a".repeat(32);
  const resolver = () => ({ mime: "image/png", data: Buffer.from("test") });
  const content = {
    body: `![Logo](/api/images/${id})`,
    format: "markdown",
    signature: `![Logo](/api/images/${id})`,
    signature_format: "markdown",
  };
  assert.match(renderContent(content, resolver).html, /src="\/api\/images\//);
  const p = renderContent(content, resolver, true);
  assert.match(p.html, /src="cid:/);
  assert.equal(p.attachments.length, 1);
  assert.equal(p.attachments[0].content.toString(), "test");
});
test("image uploads accept raster signatures and reject SVG, spoofing and excessive size", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  assert.equal(validateImage(png, "image/png"), "image/png");
  assert.throws(() => validateImage(Buffer.from("<svg/>"), "image/svg+xml"));
  assert.throws(() => validateImage(png, "image/jpeg"));
  assert.throws(() => validateImage(Buffer.alloc(2_000_001), "image/png"));
});
