import pg from "pg";
import { ListmonkClient } from "./listmonk-client.mjs";
import { MarketingRepository } from "./repository.mjs";
import { MarketingAPI } from "./api.mjs";

export async function configuredMarketing(env = process.env) {
  if (
    !env.MARKETING_DATABASE_URL ||
    !env.LISTMONK_URL ||
    !env.LISTMONK_API_USER ||
    !env.LISTMONK_API_TOKEN
  )
    return new MarketingAPI();
  const pool = new pg.Pool({
    connectionString: env.MARKETING_DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  pool.on("error", () =>
    console.error("Marketing database connection unavailable"),
  );
  try {
    const listmonk = new ListmonkClient({
      url: env.LISTMONK_URL,
      user: env.LISTMONK_API_USER,
      token: env.LISTMONK_API_TOKEN,
    });
    const repository = new MarketingRepository(pool);
    await repository.migrate();
    return Object.assign(new MarketingAPI({ repository, listmonk }), {
      close: () => pool.end(),
    });
  } catch {
    await pool.end();
    console.error(
      "Marketing configuration unavailable; outreach remains active",
    );
    return new MarketingAPI();
  }
}
