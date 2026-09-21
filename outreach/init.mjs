import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
await writeFile(
  new URL(".env", import.meta.url),
  `DMAILIO_KEY=${randomBytes(32).toString("hex")}\nDMAILIO_PASSWORD=${randomBytes(24).toString("base64url")}\nDMAILIO_PUBLIC_URL=http://localhost:9100\nHOST=127.0.0.1\nPORT=9100\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Создан outreach/.env. Пароль входа хранится в DMAILIO_PASSWORD. Сохраните резервную копию файла.",
);
