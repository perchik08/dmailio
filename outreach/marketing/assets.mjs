import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { validateImage } from "../content.mjs";
import { invalid, MarketingError } from "./contracts.mjs";
export function isPublicIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 2) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0)
  );
}
export function publicImageURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid("Укажите HTTPS-ссылку на картинку");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    (isIP(url.hostname.replace(/^\[|\]$/g, "")) && !isPublicIPv4(url.hostname))
  )
    throw invalid(
      "Разрешены только публичные HTTPS-картинки на стандартном порту",
    );
  return url;
}
async function download(value, redirects = 0) {
  if (redirects > 3) throw invalid("Слишком много перенаправлений картинки");
  const url = publicImageURL(value);
  const addresses = await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((row) => row.family === 4 && !isPublicIPv4(row.address))
  )
    throw invalid("Внутренние адреса недоступны");
  const address = addresses.find(
    (row) => row.family === 4 && isPublicIPv4(row.address),
  );
  if (!address)
    throw invalid(
      "Для импорта ссылки нужен публичный IPv4; загрузите файл вручную",
    );
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        signal: AbortSignal.timeout(8000),
        lookup: (_host, options, done) =>
          options.all
            ? done(null, [{ address: address.address, family: 4 }])
            : done(null, address.address, 4),
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (!response.headers.location)
            return reject(invalid("Некорректное перенаправление"));
          download(
            new URL(response.headers.location, url).href,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(invalid("Не удалось скачать картинку"));
        }
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 2000000) {
            req.destroy(invalid("Картинка: максимум 2 МБ"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            buffer: Buffer.concat(chunks),
            mime: String(response.headers["content-type"] || "").split(";")[0],
          }),
        );
        response.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}
export class Assets {
  constructor(repository) {
    this.repository = repository;
  }
  async save({ buffer, mime, name = "image", alt = "" }) {
    try {
      validateImage(buffer, mime);
    } catch (error) {
      throw invalid(error.message);
    }
    const hash = createHash("sha256").update(buffer).digest("hex");
    await this.repository.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(73193303)");
      const size = Number(
        (
          await client.query(
            "SELECT COALESCE(sum(size),0) size FROM marketing.assets",
          )
        ).rows[0].size,
      );
      const exists = (
        await client.query("SELECT id FROM marketing.assets WHERE id=$1", [
          hash,
        ])
      ).rows.length;
      if (!exists && size + buffer.length > 100000000)
        throw invalid("Библиотека картинок достигла лимита 100 МБ");
      await client.query(
        "INSERT INTO marketing.assets(id,mime,name,alt,size,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [
          hash,
          mime,
          String(name).slice(0, 200),
          String(alt).slice(0, 1000),
          buffer.length,
          buffer,
        ],
      );
    });
    return {
      id: hash,
      url: `/marketing-media/${hash}`,
      mime,
      size: buffer.length,
      alt: String(alt).slice(0, 1000),
    };
  }
  async upload(value) {
    if (typeof value.content !== "string" || value.content.length > 2700000)
      throw invalid("Картинка: максимум 2 МБ");
    return this.save({
      ...value,
      buffer: Buffer.from(value.content, "base64"),
    });
  }
  async remote(value) {
    try {
      return await this.save({
        ...(await download(value.url)),
        name: value.name || "Импорт по ссылке",
        alt: value.alt,
      });
    } catch (error) {
      if (error instanceof MarketingError) throw error;
      throw invalid(
        "Не удалось загрузить картинку по ссылке. Загрузите файл вручную.",
      );
    }
  }
  async page() {
    return (
      await this.repository.pool.query(
        "SELECT id,mime,name,alt,size,created_at FROM marketing.assets ORDER BY created_at DESC LIMIT 300",
      )
    ).rows.map((row) => ({ ...row, url: `/marketing-media/${row.id}` }));
  }
  async get(id) {
    if (!/^[a-f\d]{64}$/.test(id)) throw invalid("Некорректная картинка");
    const { rows } = await this.repository.pool.query(
      "SELECT data,mime FROM marketing.assets WHERE id=$1",
      [id],
    );
    if (!rows.length)
      throw new MarketingError("NOT_FOUND", "Картинка не найдена", 404);
    return rows[0];
  }
}
