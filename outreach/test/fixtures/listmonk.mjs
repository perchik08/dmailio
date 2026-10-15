// Linux CI only. Never run against a non-fixture database.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";
const connection = new URL(process.env.MARKETING_TEST_DATABASE_URL);
if (
  connection.pathname !== "/marketing_test" ||
  !["localhost", "127.0.0.1"].includes(connection.hostname)
)
  throw new Error("An isolated local marketing_test PostgreSQL is required");
const image = "listmonk/listmonk:v6.2.0";
const args = [
  "--network",
  "host",
  "-e",
  "LISTMONK_app__address=127.0.0.1:19000",
  "-e",
  `LISTMONK_db__host=${connection.hostname}`,
  "-e",
  `LISTMONK_db__port=${connection.port || 5432}`,
  "-e",
  `LISTMONK_db__user=${decodeURIComponent(connection.username)}`,
  "-e",
  `LISTMONK_db__password=${decodeURIComponent(connection.password)}`,
  "-e",
  "LISTMONK_db__database=marketing_test",
  "-e",
  "LISTMONK_db__ssl_mode=disable",
  "-e",
  "LISTMONK_ADMIN_USER=fixture-admin",
  "-e",
  "LISTMONK_ADMIN_PASSWORD=fixture-admin-password-only",
];
function docker(...extra) {
  const result = spawnSync("docker", extra, { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Listmonk fixture setup failed");
}
docker(
  "run",
  "--rm",
  ...args,
  image,
  "./listmonk",
  "--install",
  "--idempotent",
  "--yes",
  "--config",
  "",
);
const pool = new pg.Pool({
  connectionString: process.env.MARKETING_TEST_DATABASE_URL,
});
try {
  await pool.query(
    "INSERT INTO users(username,password,email,name,type,user_role_id,status) VALUES('fixture-api',$1,'fixture-api@example.invalid','Fixture API','api',1,'enabled') ON CONFLICT (username) DO UPDATE SET password=EXCLUDED.password",
    [createHash("sha256").update("fixture-api-token-only").digest("hex")],
  );
} finally {
  await pool.end();
}
docker(
  "run",
  "-d",
  "--name",
  "marketing-listmonk-fixture",
  ...args,
  image,
  "./listmonk",
  "--config",
  "",
);
let available = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(
      "http://127.0.0.1:19000/api/lists?minimal=true",
      {
        headers: { Authorization: "token fixture-api:fixture-api-token-only" },
        signal: AbortSignal.timeout(1000),
      },
    );
    if (response.ok) {
      available = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!available)
  throw new Error("Authenticated listmonk fixture did not become ready");
console.log("Authenticated listmonk v6.2.0 fixture ready; no SMTP configured");
