import { parse } from "csv-parse/sync";

export const defaultSchedule = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
  timezone: "Europe/Moscow",
  interval: 12,
};
export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
export function email(value) {
  const result = String(value || "")
    .trim()
    .toLowerCase();
  requireValue(
    !/[\x00-\x20\x7f"()\[\]\\:]/.test(result),
    "Введите один email без имени и комментариев",
  );
  requireValue(
    result.length <= 254 &&
      /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(result),
    "Некорректный email",
  );
  return result;
}
export function parseContacts(csv) {
  requireValue(
    typeof csv === "string" && Buffer.byteLength(csv) <= 10_000_000,
    "CSV: максимум 10 МБ",
  );
  const first = csv.replace(/^\uFEFF/, "").split(/\r?\n/)[0];
  const delimiter = first.includes(";")
    ? ";"
    : first.includes("\t")
      ? "\t"
      : ",";
  const rows = parse(csv, {
    bom: true,
    delimiter,
    skip_empty_lines: true,
    max_record_size: 200_000,
  });
  requireValue(
    rows.length > 1 && rows.length <= 10001,
    "CSV: от 1 до 10 000 контактов",
  );
  const headers = rows.shift().map((h) => h.trim());
  requireValue(
    headers.every(
      (h) => h && !["__proto__", "prototype", "constructor"].includes(h),
    ) && new Set(headers).size === headers.length,
    "Проверьте названия столбцов: пустые или повторяющиеся",
  );
  const emailColumn = headers.find((h) => h.toLowerCase() === "email");
  requireValue(emailColumn, "Нужен столбец email");
  const seen = new Set();
  const contacts = [];
  const errors = [];
  rows.forEach((values, idx) => {
    try {
      const fields = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
      const address = email(fields[emailColumn]);
      requireValue(!seen.has(address), "Повторный email");
      seen.add(address);
      fields.email = address;
      contacts.push({ email: address, fields });
    } catch (e) {
      errors.push({ row: idx + 2, error: e.message });
    }
  });
  return { headers, contacts, errors, steps: inferSteps(headers) };
}
export function inferSteps(headers) {
  return headers
    .filter((h) => /^Письмо\s+\d+$/.test(h))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((h, i) => ({
      subject: i
        ? ""
        : headers.includes("Тема цепочки")
          ? "{{Тема цепочки}}"
          : "",
      body: `{{${h}}}`,
      delay: i ? 3 : 0,
    }));
}
export function render(template, fields = {}, sender = {}, used = new Set()) {
  const variables = {
    ...fields,
    "Имя Отправителя": sender.name,
    "Фамилия Отправителя": sender.surname,
    "Email Отправителя": sender.email,
    "Подпись Отправителя": sender.signature,
  };
  let budget = 400_000;
  const expand = (text, stack = []) => {
    requireValue(
      (budget -= String(text).length) >= 0,
      "Письмо слишком большое",
    );
    return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => {
      requireValue(
        stack.length < 8 && !stack.includes(key),
        `Переменные: цикл ${key}`,
      );
      requireValue(
        Object.hasOwn(variables, key) &&
          variables[key] !== undefined &&
          String(variables[key]).trim() !== "",
        `Не заполнена переменная: ${key}`,
      );
      used.add(key);
      return expand(variables[key], [...stack, key]);
    });
  };
  const result = expand(template);
  requireValue(result.length <= 200_000, "Письмо слишком большое");
  return result;
}
export function validateSchedule(s) {
  requireValue(
    s &&
      Array.isArray(s.days) &&
      s.days.length &&
      s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    "Выберите дни отправки",
  );
  requireValue(
    /^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(s.end) &&
      s.start < s.end,
    "Рабочее окно: начало должно быть раньше конца",
  );
  requireValue(
    Number.isInteger(s.interval) && s.interval >= 1 && s.interval <= 1440,
    "Интервал: 1–1440 минут",
  );
  new Intl.DateTimeFormat("en", { timeZone: s.timezone }).format();
  return s;
}
export function inWindow(date, s) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: s.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return (
    s.days.includes(
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
    ) &&
    `${parts.hour}:${parts.minute}` >= s.start &&
    `${parts.hour}:${parts.minute}` < s.end
  );
}
export const escapeHTML = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
