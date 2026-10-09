import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../core.mjs";
test("phrase rotation chooses groups independently and expands nested contact templates", () => {
  const picks = [1, 0];
  assert.equal(
    core.render(
      "{{letter}}",
      {
        letter: "{{name}}, { привет | здравствуйте }! {Первое|Второе}",
        name: "Иван",
      },
      {},
      new Set(),
      { choose: () => picks.shift() },
    ),
    "Иван, здравствуйте! Первое",
  );
  assert.equal(
    core.render("{обычный текст} и {{name}}", { name: "Иван" }),
    "{обычный текст} и Иван",
  );
  for (const literal of [
    "{",
    "{{",
    "{текст",
    "{a{b}",
    "Текст | текст",
    "{a: 1}",
  ])
    assert.equal(core.render(literal), literal);
});
test("rotation validates every alternative before choosing and rejects broken groups", () => {
  for (const body of ["{a|}", "{|b}", "{a|b", "{a|{b|c}}", "{a|{{missing}}}"])
    assert.throws(() =>
      core.render(body, {}, {}, new Set(), { choose: () => 0 }),
    );
  assert.throws(
    () => core.render("{ok|{{loop}}}", { loop: "{{loop}}" }),
    /цикл/,
  );
  assert.equal(
    core.render("{a|{{name}}}", { name: "Иван" }, {}, new Set(), {
      choose: () => 1,
    }),
    "Иван",
  );
});
test("only selected alternatives count as inserted sender signatures", () => {
  const used = new Set();
  assert.equal(
    core.render(
      "{{{Подпись Отправителя}}|Привет}",
      {},
      { signature: "Подпись" },
      used,
      { choose: () => 1 },
    ),
    "Привет",
  );
  assert.equal(used.has("Подпись Отправителя"), false);
});
test("validation visits every branch without consuming random choices", () => {
  assert.equal(
    core.render("{коротко|намного длиннее}", {}, {}, new Set(), {
      validateOnly: true,
      choose: () => {
        throw new Error("random during validation");
      },
    }),
    "намного длиннее",
  );
  assert.throws(
    () => core.render("{ok|{{blank}}}", { blank: " " }),
    /переменная/,
  );
});
test("rotation preserves rich editor emphasis spanning alternatives", () => {
  for (const [choice, expected] of [
    [0, "<p><strong>Hello</strong></p>"],
    [1, "<p><strong>Goodbye</strong></p>"],
  ])
    assert.equal(
      core.render(
        "<p>{<strong>Hello|Goodbye</strong>}</p>",
        {},
        {},
        new Set(),
        { choose: () => choice, html: true },
      ),
      expected,
    );
  assert.equal(core.render("{".repeat(100)), "{".repeat(100));
});
test("rich rotation bounds formatting depth and generated alternatives", () => {
  assert.throws(
    () =>
      core.render(
        "{" + "<b>".repeat(100) + "a|b" + "</b>".repeat(100) + "}",
        {},
        {},
        new Set(),
        { html: true },
      ),
    /Ротация/,
  );
});
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
test("legacy CSV import accepts the expanded 25 MB file limit", () => {
  assert.throws(() => core.parseContacts("x".repeat(25_000_001)), /25 МБ/);
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
