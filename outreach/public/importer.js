export const importTargets = [
  { value: "email", label: "Email" },
  { value: "first_name", label: "Имя" },
  { value: "last_name", label: "Фамилия" },
  { value: "middle_name", label: "Отчество" },
  { value: "full_name", label: "Полное имя" },
  { value: "company", label: "Компания" },
  { value: "position", label: "Должность" },
  { value: "department", label: "Отдел" },
  { value: "phone", label: "Телефон" },
  { value: "website", label: "Сайт" },
  { value: "industry", label: "Отрасль" },
  { value: "region", label: "Регион" },
  { value: "country", label: "Страна" },
  { value: "sequence_subject", label: "Тема цепочки" },
  { value: "custom", label: "Пользовательская переменная" },
  ...Array.from({ length: 20 }, (_, index) => ({
    value: `step:${index + 1}`,
    label: `Письмо ${index + 1}`,
  })),
  { value: "skip", label: "Не импортировать" },
];

export function validateImportFile(file) {
  if (!file || typeof file.name !== "string")
    throw new Error("Выберите файл CSV или .xlsx");
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "xls")
    throw new Error(
      "Формат .xls не поддерживается. Сохраните файл как .xlsx и загрузите снова.",
    );
  if (!["csv", "xlsx"].includes(extension))
    throw new Error("Поддерживаются файлы CSV и .xlsx");
  if (file.size > 25_000_000)
    throw new Error("Максимальный размер файла — 25 МБ");
  return { format: extension };
}

export async function fileToImportPayload(file) {
  const { format } = validateImportFile(file);
  if (format === "csv") return { format, content: await file.text() };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { format, content: btoa(binary) };
}

export function mappingTargetValue(target) {
  if (target?.kind === "sequence_step") return `step:${target.step}`;
  return String(target || "skip");
}

export function mappingTargetLabel(target) {
  const value = mappingTargetValue(target);
  return (
    importTargets.find((item) => item.value === value)?.label ||
    "Не импортировать"
  );
}

export function mappingFromTargetValue(value) {
  if (value.startsWith("step:"))
    return { kind: "sequence_step", step: Number(value.slice(5)) };
  return value;
}
