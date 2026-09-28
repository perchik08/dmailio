import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  renderSequenceSidebar,
  updateSequenceDelay,
} from "../public/sequence.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

test("first email has no delay row and each later email has a delay before its card", () => {
  const html = renderSequenceSidebar(
    [
      { subject: "First", delay: 0 },
      { subject: "Second", delay: 3 },
      { subject: "Third", delay: 5 },
    ],
    0,
    true,
    escape,
  );

  assert.equal((html.match(/class="step-delay"/g) || []).length, 2);
  assert.ok(
    html.indexOf('data-step="0"') < html.indexOf('data-step-delay="1"'),
  );
  assert.ok(
    html.indexOf('data-step-delay="1"') < html.indexOf('data-step="1"'),
  );
  assert.ok(
    html.indexOf('data-step="1"') < html.indexOf('data-step-delay="2"'),
  );
  assert.match(html, /data-step-delay="1"[^>]*value="3"/);
  assert.match(html, /data-step-delay="2"[^>]*value="5"/);
});

test("delay values are disabled in read-only mode and the editor has no old delay field", () => {
  const html = renderSequenceSidebar(
    [
      { subject: "First", delay: 0 },
      { subject: "Second", delay: 1 },
    ],
    1,
    false,
    escape,
  );

  assert.match(html, /data-step-delay="1"[^>]*disabled/);
  return readFile(new URL("../public/app.js", import.meta.url), "utf8").then(
    (app) => {
      assert.doesNotMatch(app, /id="delay"/);
      assert.doesNotMatch(app, /Задержка после предыдущего письма/);
    },
  );
});

test("delay changes update only a valid follow-up step", () => {
  const steps = [
    { subject: "First", delay: 0 },
    { subject: "Second", delay: 3 },
  ];

  assert.equal(updateSequenceDelay(steps, 1, "7"), true);
  assert.equal(steps[1].delay, 7);
  assert.equal(updateSequenceDelay(steps, 0, "9"), false);
  assert.equal(updateSequenceDelay(steps, 1, "366"), false);
  assert.equal(updateSequenceDelay(steps, 1, "1.5"), false);
  assert.equal(steps[0].delay, 0);
  assert.equal(steps[1].delay, 7);
});

test("delay label uses the correct Russian form for days", () => {
  const html = renderSequenceSidebar(
    [
      { subject: "First", delay: 0 },
      { subject: "Second", delay: 1 },
      { subject: "Third", delay: 4 },
      { subject: "Fourth", delay: 5 },
    ],
    0,
    true,
    escape,
  );

  assert.match(html, />день<\/span>/);
  assert.match(html, />дня<\/span>/);
  assert.match(html, />дней<\/span>/);
});
