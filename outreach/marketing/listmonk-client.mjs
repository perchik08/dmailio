import { MarketingError, invalid } from "./contracts.mjs";

const failure = (code = "LISTMONK_UNAVAILABLE", status = 503) =>
  new MarketingError(
    code,
    "Не удалось выполнить запрос к сервису подписчиков. Данные не изменены или требуют проверки состояния операции.",
    status,
    {},
    status === 503,
  );
export class ListmonkClient {
  #origin;
  #authorization;
  #timeout;
  constructor({ url, user, token, timeout = 10000 }) {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      throw invalid("Проверьте серверный адрес listmonk");
    if (!user || !token || /[\r\n:]/.test(user) || /[\r\n]/.test(token))
      throw invalid("Не настроен серверный токен listmonk");
    this.#origin = parsed.origin;
    this.#authorization = `token ${user}:${token}`;
    this.#timeout = timeout;
  }
  async request(method, path, data) {
    if (
      !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method) ||
      !/^\/api\/(lists|subscribers|campaigns|tx)(?:[/?]|$)/.test(path) ||
      path.includes("..") ||
      path.includes("\\") ||
      /[\r\n]/.test(path)
    )
      throw invalid("Недопустимый запрос listmonk");
    let response;
    try {
      response = await fetch(this.#origin + path, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeout),
        headers: {
          Authorization: this.#authorization,
          "Content-Type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      if (!response.ok) {
        if (response.status === 404) throw failure("NOT_FOUND", 404);
        if (response.status === 409) throw failure("CONFLICT", 409);
        if (response.status === 400 || response.status === 422)
          throw failure("UPSTREAM_VALIDATION", 422);
        throw failure();
      }
      const raw = await response.text();
      if (raw.length > 8000000) throw failure();
      const result = JSON.parse(raw);
      if (!Object.hasOwn(result, "data")) throw failure();
      return result.data;
    } catch (error) {
      if (error instanceof MarketingError) throw error;
      throw failure();
    }
  }
}
