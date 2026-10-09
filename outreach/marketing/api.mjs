import { MarketingError, errorBody, unavailable } from "./contracts.mjs";

export class MarketingAPI {
  constructor({ repository, listmonk } = {}) {
    Object.assign(this, { repository, listmonk });
  }
  async handle({ path, method, send }) {
    if (!path.startsWith("/api/marketing/")) return false;
    try {
      if (!this.repository || !this.listmonk) throw unavailable();
      if (path === "/api/marketing/status" && method === "GET") {
        await this.repository.health();
        await this.listmonk.request("GET", "/api/lists?minimal=true");
        send({
          available: true,
          cabinet: "current",
          massTransportConfigured: false,
        });
      } else if (
        path.startsWith("/api/marketing/operations/") &&
        method === "GET"
      ) {
        send(
          await this.repository.operationResult(
            path.slice("/api/marketing/operations/".length),
          ),
        );
      } else throw new MarketingError("NOT_FOUND", "Раздел не найден", 404);
    } catch (error) {
      send(
        errorBody(error),
        error instanceof MarketingError ? error.status : 503,
      );
    }
    return true;
  }
}
