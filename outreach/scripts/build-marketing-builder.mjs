import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(
  new URL("../../frontend/email-builder/", import.meta.url),
);
const command = process.platform === "win32" ? "npx.cmd" : "npx";
for (const args of [
  ["yarn@1.22.22", "install", "--frozen-lockfile"],
  ["vite", "build", "--config", "vite.marketing.config.ts"],
]) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
