import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../core.mjs";
test("addresses reject display names, comments and multiple recipients", () => {
  for (const value of [
    "a(comment)@example.com",
    '"a"@example.com',
    "a@example.com,b@example.com",
    "Name <a@example.com>",
  ])
    assert.throws(() => core.email(value));
  assert.equal(core.email("USER+tag@example.com"), "user+tag@example.com");
});
test("nested expansion is bounded before allocating an enormous result", () => {
  const vars = {
    a: "x".repeat(10000),
    b: "{{a}}".repeat(100),
    c: "{{b}}".repeat(100),
  };
  assert.throws(() => core.render("{{c}}", vars), /большое/);
});

test("CSV preserves Cyrillic, quoted newlines and separates invalid and duplicate rows", () => {
  assert.equal(typeof core.parseContacts, "function");
  const result = core.parseContacts(
    '\uFEFFemail;name;Тема цепочки;Письмо 1;Письмо 2\r\na@example.com;Иван;Вопрос;"Привет,\nИван";Пинг\r\nA@example.com;Иван;X;X;Y\r\nwrong;Иван;X;X;Y',
  );
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].fields["Письмо 1"], "Привет,\nИван");
  assert.equal(result.errors.length, 2);
  assert.deepEqual(
    core.inferSteps(result.headers).map((s) => s.body),
    ["{{Письмо 1}}", "{{Письмо 2}}"],
  );
});
test("ambiguous CSV headers and missing email are rejected", () => {
  assert.equal(typeof core.parseContacts, "function");
  assert.throws(
    () => core.parseContacts("email,email\na@example.com,b@example.com"),
    /столб/,
  );
  assert.throws(() => core.parseContacts("name\nИван"), /email/);
});
test("variables are literal, nested sender fields work, missing and cycles fail", () => {
  assert.equal(typeof core.render, "function");
  assert.equal(
    core.render(
      "{{Письмо 1}}",
      { "Письмо 1": "{{name}}, я {{Имя Отправителя}}", name: "Иван" },
      { name: "Даниил" },
    ),
    "Иван, я Даниил",
  );
  assert.throws(() => core.render("{{missing}}", {}, {}), /missing/);
  assert.throws(() => core.render("{{x}}", { x: "{{x}}" }, {}), /цикл/);
  assert.throws(() => core.render("{{process.exit()}}", {}, {}), /process/);
});
test("schedule uses selected timezone, weekdays and overnight windows are rejected", () => {
  assert.equal(typeof core.inWindow, "function");
  const schedule = {
    days: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "18:00",
    timezone: "Europe/Moscow",
    interval: 12,
  };
  assert.equal(core.inWindow(new Date("2026-09-21T06:00:00Z"), schedule), true);
  assert.equal(
    core.inWindow(new Date("2026-09-21T15:00:00Z"), schedule),
    false,
  );
  assert.equal(
    core.inWindow(new Date("2026-09-20T09:00:00Z"), schedule),
    false,
  );
  assert.throws(() => core.validateSchedule({ ...schedule, end: "08:00" }));
  assert.throws(() =>
    core.validateSchedule({ ...schedule, timezone: "invalid" }),
  );
});
