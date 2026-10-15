import test from "node:test";
import assert from "node:assert/strict";
import { letterInput } from "../marketing/letters.mjs";
test("letter source modes remain independent and headers reject newline injection", () => {
  const value = letterInput({
    title: "Тест",
    subject: "Тема",
    editorMode: "html",
    source: "<p>HTML</p>",
    sources: { markdown: "# Markdown" },
  });
  assert.equal(value.sources.html, "<p>HTML</p>");
  assert.equal(value.sources.markdown, "# Markdown");
  assert.throws(() =>
    letterInput({ ...value, subject: "Hello\r\nBcc: attack@example.com" }),
  );
  assert.throws(() => letterInput({ ...value, editorMode: "unknown" }));
  assert.throws(() => letterInput({ ...value, source: "x".repeat(220001) }));
});
