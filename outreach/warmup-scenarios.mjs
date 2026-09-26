import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const bankPath = new URL("./warmup-scenarios.json", import.meta.url);
const requiredScenarioFields = [
  "id",
  "category",
  "situation",
  "tone",
  "thread_subject",
  "messages",
  "used_variables",
  "uniqueness_key",
];

function validateScenario(scenario) {
  if (!scenario || typeof scenario !== "object")
    throw new Error("Банк прогрева содержит некорректный сценарий");
  for (const field of requiredScenarioFields)
    if (!(field in scenario))
      throw new Error(`В сценарии прогрева отсутствует поле ${field}`);
  if (
    !Array.isArray(scenario.messages) ||
    scenario.messages.length < 2 ||
    scenario.messages.length > 5
  )
    throw new Error(`Сценарий ${scenario.id} должен содержать 2–5 писем`);
  for (let i = 0; i < scenario.messages.length; i += 1) {
    const message = scenario.messages[i];
    if (!message || !["sender", "recipient"].includes(message.from))
      throw new Error(`Некорректный отправитель в сценарии ${scenario.id}`);
    if (
      !String(message.subject || "").trim() ||
      !String(message.body || "").trim()
    )
      throw new Error(`Пустая тема или текст в сценарии ${scenario.id}`);
    if (i > 0 && message.from === scenario.messages[i - 1].from)
      throw new Error(
        `Два письма подряд отправляет один участник в ${scenario.id}`,
      );
  }
  return scenario;
}

export function loadWarmupScenarios() {
  const parsed = JSON.parse(readFileSync(bankPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error("Банк сценариев прогрева пуст");
  const ids = new Set();
  const keys = new Set();
  return parsed.map((scenario) => {
    validateScenario(scenario);
    if (ids.has(scenario.id))
      throw new Error(`Повторяется id сценария ${scenario.id}`);
    if (keys.has(scenario.uniqueness_key))
      throw new Error(`Повторяется ключ сценария ${scenario.uniqueness_key}`);
    ids.add(scenario.id);
    keys.add(scenario.uniqueness_key);
    return scenario;
  });
}

function stableIndex(value, size) {
  const hash = createHash("sha256").update(String(value)).digest();
  return hash.readUInt32BE(0) % size;
}

export function pickWarmupScenario(
  scenarios,
  usedIds = new Set(),
  pairKey = "",
) {
  const available = scenarios.filter((scenario) => !usedIds.has(scenario.id));
  if (!available.length) return null;
  return available[stableIndex(pairKey, available.length)];
}

export function renderWarmupText(text, variables = {}) {
  return String(text).replace(/{{([\w]+)}}/g, (_, name) =>
    variables[name] === undefined ? `{{${name}}}` : String(variables[name]),
  );
}
