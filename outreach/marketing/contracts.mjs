export class MarketingError extends Error {
  constructor(code, message, status = 400, fields = {}, retryable = false) {
    super(message);
    Object.assign(this, { code, status, fields, retryable });
  }
}
export const invalid = (message, fields = {}) =>
  new MarketingError("VALIDATION", message, 400, fields);
export const unavailable = () =>
  new MarketingError(
    "MARKETING_UNAVAILABLE",
    "Маркетинговый модуль временно недоступен. Проверьте подключение listmonk и базы данных.",
    503,
    {},
    true,
  );
export function errorBody(error) {
  const known = error instanceof MarketingError ? error : unavailable();
  return {
    code: known.code,
    message: known.message,
    fields: known.fields,
    retryable: known.retryable,
  };
}
export function pagination(params, allowed = []) {
  for (const key of params.keys())
    if (!["page", "perPage", ...allowed].includes(key))
      throw invalid("Неизвестный параметр фильтра", {
        [key]: "Не поддерживается",
      });
  const page = Number(params.get("page") ?? 1);
  const perPage = Number(params.get("perPage") ?? 50);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000000 ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > 100
  )
    throw invalid("Проверьте страницу и размер списка");
  return { page, perPage };
}
export function identifier(value) {
  if (
    typeof value !== "string" ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)
  )
    throw invalid("Некорректный идентификатор");
  return value;
}
export function requiredString(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw invalid(`Проверьте поле «${label}»`, {
      [label]: `От 1 до ${max} символов`,
    });
  return value.trim();
}
