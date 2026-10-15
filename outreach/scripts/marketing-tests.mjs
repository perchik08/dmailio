import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const suite = process.argv[2];
const definitions = {
  unit: ["test", /^(marketing-.*|core|store|full-inbox-.*)\.test\.mjs$/],
  integration: ["test/integration", /\.test\.mjs$/],
  e2e: ["test/e2e", /\.spec\.mjs$/],
};
if (!definitions[suite]) throw new Error("Unknown marketing suite");
const [directory, pattern] = definitions[suite];
const files = (
  await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })
)
  .filter((file) => pattern.test(file))
  .sort();
if (!files.length) {
  console.error(
    `Marketing ${suite}: no tests implemented; verification unavailable.`,
  );
  process.exit(2);
}
const args =
  suite === "e2e"
    ? [
        "node_modules/@playwright/test/cli.js",
        "test",
        ...files.map((file) => `${directory}/${file}`),
      ]
    : [
        "--test",
        ...(suite === "integration" ? ["--test-concurrency=1"] : []),
        ...files.map((file) => `${directory}/${file}`),
      ];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
