import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "./store.mjs";
import { MailGateway } from "./mail.mjs";
import { Worker } from "./worker.mjs";
import { checkDomainDNS } from "./dns.mjs";
import { parseContacts, requireValue, render } from "./core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hash = (s) => createHash("sha256").update(String(s)).digest();
const sample =
  '\uFEFFemail,name,company,Тема цепочки,Письмо 1,Письмо 2,Письмо 3\r\ndemo@example.com,Иван,Пример,Вопрос для {{company}},"{{name}}, добрый день! Меня зовут {{Имя Отправителя}}.","Возвращаюсь к вопросу, {{name}}.",Подскажите пожалуйста актуально ли предложение?\r\n';
export function createApp({
  store,
  password,
  publicURL,
  gateway,
  worker,
  dnsChecker = checkDomainDNS,
}) {
  requireValue(
    typeof password === "string" && password.length >= 16,
    "DMAILIO_PASSWORD: минимум 16 символов",
  );
  const origin = new URL(publicURL).origin;
  const secure = origin.startsWith("https:");
  const sessions = new Map();
  const attempts = new Map();
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const send = (
      data,
      status = 200,
      type = "application/json; charset=utf-8",
    ) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(
        type.startsWith("application/json") ? JSON.stringify(data) : data,
      );
    };
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      const method = req.method;
      if (path === "/healthz") return send({ ok: true });
      const opt = path.match(/^\/unsubscribe\/([a-f0-9]{48})$/);
      if (opt) {
        if (method === "POST") {
          store.unsubscribe(opt[1]);
          return send(
            "Вы отписались от рассылки.",
            200,
            "text/plain; charset=utf-8",
          );
        }
        if (method === "GET")
          return send(
            '<!doctype html><meta charset="utf-8"><title>Отписка</title><h1>Отписаться от рассылки</h1><form method="post"><button>Подтвердить отписку</button></form>',
            200,
            "text/html; charset=utf-8",
          );
      }
      const pixel = path.match(/^\/open\/([a-f0-9]{48})\.gif$/);
      if (pixel && method === "GET") {
        store.track(pixel[1]);
        return send(
          Buffer.from(
            "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
            "base64",
          ),
          200,
          "image/gif",
        );
      }
      if (!["GET", "HEAD"].includes(method) && req.headers.origin !== origin)
        return send(
          { error: "Запрос должен исходить из интерфейса Dmailio" },
          403,
        );
      let data = {};
      if (!["GET", "HEAD"].includes(method)) {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 11_000_000) {
            send({ error: "Файл слишком большой" }, 413);
            req.destroy();
            return;
          }
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString();
        data = raw ? JSON.parse(raw) : {};
      }
      for (const [key, value] of sessions)
        if (value < Date.now()) sessions.delete(key);
      if (path === "/api/login" && method === "POST") {
        const ip = req.socket.remoteAddress;
        const a = attempts.get(ip) || { count: 0, until: 0 };
        if (a.until < Date.now()) {
          a.count = 0;
          a.until = Date.now() + 900000;
        }
        a.count++;
        attempts.set(ip, a);
        if (a.count > 15)
          return send(
            { error: "Слишком много попыток. Повторите через 15 минут." },
            429,
          );
        if (!timingSafeEqual(hash(data.password || ""), hash(password)))
          return send({ error: "Неверный пароль" }, 401);
        attempts.delete(ip);
        const token = randomBytes(32).toString("hex");
        sessions.set(token, Date.now() + 12 * 3600000);
        res.setHeader(
          "Set-Cookie",
          `dmailio=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`,
        );
        return send({ ok: true });
      }
      const token = req.headers.cookie?.match(
        /(?:^|;\s*)dmailio=([a-f0-9]{64})(?:;|$)/,
      )?.[1];
      if (path.startsWith("/api/") && !sessions.has(token))
        return send({ error: "Войдите в Dmailio" }, 401);
      if (path === "/api/logout" && method === "POST") {
        sessions.delete(token);
        res.setHeader(
          "Set-Cookie",
          `dmailio=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
        );
        return send({ ok: true });
      }
      if (path === "/api/state" && method === "GET")
        return send({
          mailboxes: store.mailboxOverview(),
          campaigns: store.campaigns(),
          workerError: worker.lastError || "",
        });
      if (path === "/api/mailboxes" && method === "GET")
        return send(store.mailboxOverview());
      if (path === "/api/mailboxes" && method === "POST")
        return send(store.saveMailbox(data), 201);
      if (path === "/api/mailboxes/warmup/bulk" && method === "POST") {
        store.bulkWarmup(data.ids, data.enabled);
        return send(store.mailboxOverview());
      }
      const mailboxPage = path.match(
        /^\/api\/mailboxes\/([^/]+)\/(detail|dns|settings)$/,
      );
      if (mailboxPage) {
        const [, id, action] = mailboxPage;
        if (action === "detail" && method === "GET")
          return send(store.mailboxDetail(id));
        if (action === "settings" && method === "POST")
          return send(store.saveMailboxSettings(id, data));
        if (action === "dns" && method === "GET") {
          const mailbox = store.mailbox(id);
          const selectors = mailbox.dkimSelector
            ? [mailbox.dkimSelector]
            : undefined;
          return send(
            await dnsChecker(
              mailbox.email,
              selectors ? { selectors } : undefined,
            ),
          );
        }
      }
      if (path === "/api/images" && method === "POST") {
        requireValue(
          typeof data.base64 === "string" &&
            data.base64.length <= 2_700_000 &&
            /^[A-Za-z0-9+/]*={0,2}$/.test(data.base64),
          "Некорректная картинка или превышен размер 2 МБ",
        );
        return send(
          store.saveImage(Buffer.from(data.base64, "base64"), data.mime),
          201,
        );
      }
      const image = path.match(/^\/api\/images\/([a-f0-9]{32})$/);
      if (image && method === "GET") {
        const asset = store.image(image[1]);
        if (!asset) return send({ error: "Картинка не найдена" }, 404);
        return send(Buffer.from(asset.data), 200, asset.mime);
      }
      if (path === "/api/content/preview" && method === "POST") {
        requireValue(typeof data.body === "string", "Введите текст");
        let signature = "",
          signature_format = "plain";
        if (data.mailboxId && data.includeSignature !== false) {
          const m = store.mailbox(data.mailboxId);
          if (m.signatureEnabled !== false)
            signature = render(m.signature || "", {}, m);
          signature_format = m.signatureFormat || "plain";
        }
        const formatted = store.rendered({
          body: data.body,
          format: data.format,
          signature,
          signature_format,
        });
        return send({ html: formatted.html, text: formatted.text });
      }
      const mailbox = path.match(
        /^\/api\/mailboxes\/([^/]+)\/(verify|warmup|signature)$/,
      );
      if (mailbox && method === "POST") {
        if (mailbox[2] === "signature")
          return send(store.saveSignature(mailbox[1], data));
        if (mailbox[2] === "warmup")
          return send(store.warmup(mailbox[1], data));
        try {
          const cursor = await gateway.verify(store.mailbox(mailbox[1], true));
          store.markMailbox(mailbox[1], true);
          const m = store.mailbox(mailbox[1], true);
          if (!m.cursor.validity) store.synced(m.id, cursor);
          return send(store.mailbox(mailbox[1]));
        } catch {
          store.markMailbox(
            mailbox[1],
            false,
            "Проверка SMTP/IMAP не пройдена. Проверьте host, порт и пароль приложения.",
          );
          return send({ error: "Проверка SMTP/IMAP не пройдена" }, 400);
        }
      }
      if (path === "/api/import/preview" && method === "POST")
        return send(parseContacts(data.csv));
      if (path === "/api/template.csv" && method === "GET") {
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="dmailio-sequence.csv"',
        );
        return send(sample, 200, "text/csv; charset=utf-8");
      }
      if (path === "/api/campaigns" && method === "POST")
        return send(store.saveCampaign(data), 201);
      const campaign = path.match(
        /^\/api\/campaigns\/([^/]+)(?:\/(import|status|preview))?$/,
      );
      if (campaign) {
        const [, id, action] = campaign;
        if (method === "GET" && !action) return send(store.campaign(id));
        if (method === "POST") {
          if (action === "import") {
            const parsed = parseContacts(data.csv);
            requireValue(
              !parsed.errors.length,
              "Исправьте ошибки CSV перед импортом",
            );
            return send(store.importContacts(id, parsed.contacts));
          }
          if (action === "status")
            return send(store.setCampaignStatus(id, data.status));
          if (action === "preview")
            return send(
              store.preview(
                id,
                data.leadId,
                data.mailboxId,
                Number(data.step) || 0,
              ),
            );
        }
      }
      if (path === "/api/inbox" && method === "GET")
        return send(store.inbox(url.searchParams.get("campaign") || ""));
      const resolution = path.match(/^\/api\/messages\/([^/]+)\/resolve$/);
      if (resolution && method === "POST")
        return send(store.resolve(resolution[1], data.outcome));
      const thread = path.match(
        /^\/api\/threads\/([^/]+)(?:\/(reply|label))?$/,
      );
      if (thread) {
        const [, id, action] = thread;
        if (method === "GET" && !action)
          return send(
            store
              .thread(id)
              .map((m) => ({ ...m, html: store.rendered(m).html })),
          );
        if (method === "POST" && action === "label") {
          store.label(id, data.status);
          return send({ ok: true });
        }
        if (method === "POST" && action === "reply") {
          const msg = store.reserveReply(id, data.body, Date.now(), data);
          return send(await worker.deliver(msg));
        }
      }
      if (path === "/api/analytics" && method === "GET") {
        const since = Number(url.searchParams.get("since") || 0);
        requireValue(Number.isFinite(since) && since >= 0, "Некорректная дата");
        return send(
          store.analytics(url.searchParams.get("campaign") || "", since),
        );
      }
      if (path.startsWith("/api/"))
        return send({ error: "Метод не найден" }, 404);
      const font = path.match(
        /^\/fonts\/(onest|inter)-(latin|cyrillic)\.woff2$/,
      );
      if (font && method === "GET")
        return send(
          await readFile(
            join(
              here,
              "node_modules",
              "@fontsource-variable",
              font[1],
              "files",
              `${font[1]}-${font[2]}-wght-normal.woff2`,
            ),
          ),
          200,
          "font/woff2",
        );
      const icon = path.match(/^\/icons\/([a-z][a-z0-9-]*)\.svg$/);
      if (icon && method === "GET")
        return send(
          await readFile(join(here, "public", "icons", `${icon[1]}.svg`)),
          200,
          "image/svg+xml",
        );
      if (method === "GET" && ["/quill.js", "/quill.snow.css"].includes(path)) {
        const name = path.slice(1);
        return send(
          await readFile(join(here, "node_modules", "quill", "dist", name)),
          200,
          name.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : "text/css; charset=utf-8",
        );
      }
      if (
        method === "GET" &&
        ["/", "/app.js", "/editor.js", "/style.css"].includes(path)
      ) {
        const name = path === "/" ? "index.html" : path.slice(1);
        return send(
          await readFile(join(here, "public", name)),
          200,
          name.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : name.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8",
        );
      }
      return send({ error: "Не найдено" }, 404);
    } catch (e) {
      if (!res.headersSent)
        send(
          {
            error: e.code?.includes("SQLITE")
              ? "Не удалось сохранить: проверьте уникальность и связанные данные"
              : e instanceof SyntaxError
                ? "Некорректный JSON"
                : e.message || "Ошибка запроса",
          },
          400,
        );
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const dataDir = process.env.DMAILIO_DATA || join(here, "data");
  await mkdir(dataDir, { recursive: true });
  const port = Number(process.env.PORT || 9100);
  const publicURL =
    process.env.DMAILIO_PUBLIC_URL || `http://localhost:${port}`;
  const store = new Store(
    join(dataDir, "outreach.sqlite"),
    process.env.DMAILIO_KEY,
  );
  const gateway = new MailGateway(store, publicURL);
  const worker = new Worker(store, gateway);
  const app = createApp({
    store,
    gateway,
    worker,
    publicURL,
    password: process.env.DMAILIO_PASSWORD,
  });
  const timer = setInterval(() => worker.tick(), 60000);
  timer.unref();
  app.listen(port, process.env.HOST || "127.0.0.1", () =>
    console.log(`Dmailio outreach: ${publicURL}`),
  );
  const stop = () => {
    clearInterval(timer);
    app.close(async () => {
      while (worker.running)
        await new Promise((resolve) => setTimeout(resolve, 100));
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
