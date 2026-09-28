import { email } from "./core.mjs";

const FIELD_TARGETS = new Set([
  "email",
  "first_name",
  "last_name",
  "middle_name",
  "full_name",
  "company",
  "position",
  "department",
  "phone",
  "website",
  "industry",
  "region",
  "country",
]);
const FIELD_VARIABLES = {
  email: "Email",
  first_name: "Имя",
  last_name: "Фамилия",
  middle_name: "Отчество",
  full_name: "Полное имя",
  company: "Компания",
  position: "Должность",
  department: "Отдел",
  phone: "Телефон",
  website: "Сайт",
  industry: "Отрасль",
  region: "Регион",
  country: "Страна",
};
const FORBIDDEN_VARIABLES = new Set(
  [
    "__proto__",
    "prototype",
    "constructor",
    "Имя Отправителя",
    "Фамилия Отправителя",
    "Email Отправителя",
    "Подпись Отправителя",
    ...Object.values(FIELD_VARIABLES),
    "Тема цепочки",
  ].map((name) => name.toLocaleLowerCase("ru-RU")),
);

function normalizedHeader(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/[ё]/g, "е")
    .replace(/[\s_.-]+/g, "");
}

const HEADER_ALIASES = new Map([
  ["email", "email"],
  ["e-mail", "email"],
  ["почта", "email"],
  ["электроннаяпочта", "email"],
  ["адреспочты", "email"],
  ["mail", "email"],
  ["имя", "first_name"],
  ["firstname", "first_name"],
  ["first", "first_name"],
  ["name", "first_name"],
  ["фамилия", "last_name"],
  ["lastname", "last_name"],
  ["surname", "last_name"],
  ["отчество", "middle_name"],
  ["middlename", "middle_name"],
  ["полноеимя", "full_name"],
  ["fullname", "full_name"],
  ["контактноелицо", "full_name"],
  ["фио", "full_name"],
  ["компания", "company"],
  ["company", "company"],
  ["organization", "company"],
  ["организация", "company"],
  ["должность", "position"],
  ["position", "position"],
  ["title", "position"],
  ["отдел", "department"],
  ["department", "department"],
  ["телефон", "phone"],
  ["phone", "phone"],
  ["мобильный", "phone"],
  ["сайт", "website"],
  ["website", "website"],
  ["url", "website"],
  ["отрасль", "industry"],
  ["industry", "industry"],
  ["регион", "region"],
  ["region", "region"],
  ["город", "region"],
  ["city", "region"],
  ["страна", "country"],
  ["country", "country"],
]);

export function suggestColumnMappings(columns) {
  const usedTargets = new Set();
  const mappings = [];
  for (const column of columns) {
    const header = String(column.header || "").trim();
    const key = normalizedHeader(header);
    const stepMatch = header.match(/^Письмо\s*(\d+)$/i);
    if (stepMatch) {
      let step = Number(stepMatch[1]);
      if (!Number.isInteger(step) || step < 1 || step > 20) {
        mappings.push({ columnId: column.id, target: "skip" });
        continue;
      }
      while (usedTargets.has(`step:${step}`) && step < 20) step += 1;
      if (usedTargets.has(`step:${step}`)) {
        mappings.push({ columnId: column.id, target: "skip" });
        continue;
      }
      usedTargets.add(`step:${step}`);
      mappings.push({
        columnId: column.id,
        target: { kind: "sequence_step", step },
      });
      continue;
    }
    if (/^(темацепочки|тема|subject|emailsubject)$/.test(key)) {
      if (!usedTargets.has("sequence_subject")) {
        usedTargets.add("sequence_subject");
        mappings.push({ columnId: column.id, target: "sequence_subject" });
      } else mappings.push({ columnId: column.id, target: "skip" });
      continue;
    }
    const target = HEADER_ALIASES.get(key);
    const identity = target || "";
    if (target && !usedTargets.has(identity)) {
      usedTargets.add(identity);
      mappings.push({ columnId: column.id, target });
    } else if (target) {
      mappings.push({
        columnId: column.id,
        target: "custom",
        variableName: header,
      });
    } else if (header) {
      mappings.push({
        columnId: column.id,
        target: "custom",
        variableName: header,
      });
    } else {
      mappings.push({ columnId: column.id, target: "skip" });
    }
  }
  return mappings;
}

function validateMappings(table, mappings) {
  if (!Array.isArray(mappings))
    throw new Error("Настройте сопоставление колонок");
  const columnIds = new Set(table.columns.map((column) => column.id));
  const mappedColumns = new Set();
  const targetCounts = new Map();
  const variableNames = new Set();
  let emailCount = 0;
  let subjectCount = 0;
  const steps = new Set();
  for (const mapping of mappings) {
    if (
      !mapping ||
      !columnIds.has(mapping.columnId) ||
      mappedColumns.has(mapping.columnId)
    )
      throw new Error(
        "Сопоставление содержит неизвестную или повторную колонку",
      );
    mappedColumns.add(mapping.columnId);
    const { target } = mapping;
    if (target === "skip") continue;
    let identity;
    if (typeof target === "string" && FIELD_TARGETS.has(target)) {
      identity = target;
      if (target === "email") emailCount += 1;
    } else if (target === "custom") {
      const name = String(mapping.variableName || "").trim();
      if (
        !name ||
        name.length > 64 ||
        !/^[\p{L}\p{N}_][\p{L}\p{N} _.-]*$/u.test(name) ||
        FORBIDDEN_VARIABLES.has(name.toLocaleLowerCase("ru-RU")) ||
        /^Письмо\s+\d+$/.test(name)
      )
        throw new Error(
          "Проверьте название пользовательской переменной (до 64 символов)",
        );
      identity = `custom:${name.toLocaleLowerCase("ru-RU")}`;
      if (variableNames.has(identity))
        throw new Error(`Переменная «${name}» назначена дважды`);
      variableNames.add(identity);
    } else if (target === "sequence_subject") {
      identity = target;
      subjectCount += 1;
    } else if (
      target &&
      typeof target === "object" &&
      target.kind === "sequence_step"
    ) {
      const step = Number(target.step);
      if (!Number.isInteger(step) || step < 1 || step > 20)
        throw new Error("Номер шага цепочки должен быть от 1–20");
      identity = `step:${step}`;
      steps.add(step);
    } else {
      throw new Error("Выберите, куда импортировать каждую колонку");
    }
    targetCounts.set(identity, (targetCounts.get(identity) || 0) + 1);
  }
  if (emailCount !== 1)
    throw new Error("Нужно назначить ровно один столбец Email");
  for (const [identity, count] of targetCounts)
    if (count > 1)
      throw new Error(
        `Поле «${identity.replace(/^custom:/, "")}» назначено дважды`,
      );
  if (subjectCount > 1) throw new Error("Тема цепочки назначена дважды");
  return { steps: [...steps].sort((a, b) => a - b) };
}

function addressSet(values) {
  return new Set(
    [...(values || [])].map((value) => String(value).trim().toLowerCase()),
  );
}

export function previewImport(table, mappings, options = {}) {
  const { steps: stepNumbers } = validateMappings(table, mappings);
  const existingEmails = addressSet(options.existingEmails);
  const campaignEmails = addressSet(options.campaignEmails);
  const skipExisting = options.skipExisting !== false;
  const columns = new Map(
    table.columns.map((column) => [column.id, column.position]),
  );
  const fieldMappings = mappings.filter(
    ({ target }) => typeof target === "string" && FIELD_TARGETS.has(target),
  );
  const variables = new Set();
  for (const mapping of mappings) {
    if (mapping.target === "custom")
      variables.add(String(mapping.variableName).trim());
    else if (FIELD_TARGETS.has(mapping.target)) {
      variables.add(FIELD_VARIABLES[mapping.target]);
      const sourceHeader =
        table.columns[columns.get(mapping.columnId)]?.header?.trim();
      if (sourceHeader) variables.add(sourceHeader);
    } else if (mapping.target === "sequence_subject")
      variables.add("Тема цепочки");
    else if (mapping.target?.kind === "sequence_step")
      variables.add(`Письмо ${mapping.target.step}`);
  }

  const contacts = [];
  const errors = [];
  const skipped = [];
  const seen = new Set();
  for (const row of table.rows) {
    const fields = {};
    for (const mapping of mappings) {
      const value = String(row.values[columns.get(mapping.columnId)] ?? "");
      if (!value.trim()) continue;
      const target = mapping.target;
      if (typeof target === "string" && FIELD_TARGETS.has(target)) {
        const key = FIELD_VARIABLES[target];
        fields[key] = value.trim();
        const sourceHeader =
          table.columns[columns.get(mapping.columnId)]?.header?.trim();
        if (sourceHeader && sourceHeader !== key && sourceHeader !== "email")
          fields[sourceHeader] = value.trim();
        if (target === "email") fields.email = value.trim();
      } else if (target === "custom") {
        fields[String(mapping.variableName).trim()] = value;
      } else if (target === "sequence_subject") {
        fields["Тема цепочки"] = value;
      } else if (target?.kind === "sequence_step") {
        fields[`Письмо ${target.step}`] = value;
      }
    }
    try {
      const emailMapping = fieldMappings.find(
        ({ target }) => target === "email",
      );
      const rawEmail = String(
        row.values[columns.get(emailMapping.columnId)] ?? "",
      ).trim();
      const address = email(rawEmail);
      fields.email = address;
      for (const step of stepNumbers)
        if (!String(fields[`Письмо ${step}`] || "").trim())
          throw new Error(`Не заполнено письмо ${step}`);
      const subjectMapping = mappings.find(
        ({ target }) => target === "sequence_subject",
      );
      if (
        subjectMapping &&
        !String(row.values[columns.get(subjectMapping.columnId)] ?? "").trim()
      )
        throw new Error("Не заполнена тема цепочки");
      if (seen.has(address)) {
        skipped.push({
          sourceRow: row.sourceRow,
          email: address,
          reason: "Дубликат: этот email уже есть в загруженном файле",
        });
        continue;
      }
      seen.add(address);
      if (campaignEmails.has(address)) {
        skipped.push({
          sourceRow: row.sourceRow,
          email: address,
          reason: "Контакт уже есть в этой кампании",
        });
        continue;
      }
      if (skipExisting && existingEmails.has(address)) {
        skipped.push({
          sourceRow: row.sourceRow,
          email: address,
          reason: "Контакт уже есть в кампании или другой кампании",
        });
        continue;
      }
      contacts.push({ email: address, fields, sourceRow: row.sourceRow });
    } catch (error) {
      errors.push({
        sourceRow: row.sourceRow,
        email: String(fields.email || ""),
        reason: error.message,
      });
    }
  }

  const subjectMapping = mappings.find(
    ({ target }) => target === "sequence_subject",
  );
  const steps = stepNumbers.map((step, index) => ({
    subject: index === 0 && subjectMapping ? "{{Тема цепочки}}" : "",
    body: `{{Письмо ${step}}}`,
    delay: index === 0 ? 0 : 3,
    format: "plain",
  }));
  return {
    contacts,
    steps,
    variables: [...variables],
    errors,
    skipped,
    importable: contacts.length,
    skippedCount: skipped.length,
    errorCount: errors.length,
    total: table.rows.length,
    stepsReplaceRequired: steps.length > 0,
  };
}
