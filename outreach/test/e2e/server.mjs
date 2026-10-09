import { createApp } from "../../server.mjs";
import { Store } from "../../store.mjs";

const store = new Store(":memory:", "a".repeat(64));
const app = createApp({
  store,
  password: "fixture-password-only",
  publicURL: "http://127.0.0.1:19100",
  gateway: {},
  worker: {},
});
app.listen(19100, "127.0.0.1");
const stop = () =>
  app.close(() => {
    store.close();
    process.exit(0);
  });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
