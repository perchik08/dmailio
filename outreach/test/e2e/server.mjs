import { createApp } from "../../server.mjs";
import { Store } from "../../store.mjs";
import { configuredMarketing } from "../../marketing/config.mjs";

const database = process.env.MARKETING_TEST_DATABASE_URL;
if (
  database &&
  (new URL(database).pathname !== "/marketing_test" ||
    !["127.0.0.1", "localhost"].includes(new URL(database).hostname))
)
  throw new Error(
    "Browser tests require isolated local marketing_test database",
  );
const marketing = await configuredMarketing(
  database
    ? {
        MARKETING_DATABASE_URL: database,
        LISTMONK_URL: process.env.LISTMONK_TEST_URL,
        LISTMONK_API_USER: "fixture-api",
        LISTMONK_API_TOKEN: "fixture-api-token-only",
      }
    : {},
);

const store = new Store(":memory:", "a".repeat(64));
const app = createApp({
  store,
  password: "fixture-password-only",
  publicURL: "http://127.0.0.1:19100",
  gateway: {},
  worker: {},
  marketing,
});
app.listen(19100, "127.0.0.1");
const stop = () =>
  app.close(async () => {
    await marketing.close?.();
    store.close();
    process.exit(0);
  });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
