import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:19100", trace: "retain-on-failure" },
  webServer: {
    command: "node test/e2e/server.mjs",
    url: "http://127.0.0.1:19100/healthz",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
