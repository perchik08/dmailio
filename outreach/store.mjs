import { DatabaseSync } from "node:sqlite";
import { contentFormat, renderContent, validateImage } from "./content.mjs";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  email,
  requireValue,
  render,
  validateSchedule,
  defaultSchedule,
  inWindow,
} from "./core.mjs";

const json = JSON.stringify;
const warmupProviders = ["google", "yandex", "mailru", "other"];
const automaticWarmupPlan = [2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 10];
const warmupTargets = (warmup) =>
  warmup.mode === "custom"
    ? Array.from({ length: 14 }, (_, day) =>
        Math.min(warmup.max, warmup.start + day * warmup.increase),
      )
    : automaticWarmupPlan;
const warmupLabel = (score) =>
  score >= 95
    ? "Высокий прогрев"
    : score >= 80
      ? "Хорошо прогрет"
      : score >= 60
        ? "Хорошая динамика"
        : score >= 40
          ? "Прогревается"
          : score >= 20
            ? "Набирает историю"
            : "Старт";
export class Store {
  constructor(path, key) {
    requireValue(
      /^[a-f0-9]{64}$/i.test(key || ""),
      "DMAILIO_KEY: требуется 64 hex-символа",
    );
    this.key = Buffer.from(key, "hex");
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mailboxes(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,config TEXT NOT NULL,secrets TEXT NOT NULL,verified INTEGER DEFAULT 0,error TEXT DEFAULT '',last_sync INTEGER DEFAULT 0,cursor TEXT DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',config TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),email TEXT NOT NULL,fields TEXT NOT NULL,mailbox_id TEXT REFERENCES mailboxes(id),step INTEGER DEFAULT 0,status TEXT DEFAULT 'pending',due INTEGER DEFAULT 0, UNIQUE(campaign_id,email));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),campaign_id TEXT REFERENCES campaigns(id),lead_id TEXT REFERENCES leads(id),step INTEGER,kind TEXT NOT NULL,direction TEXT NOT NULL,status TEXT NOT NULL,recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,parent TEXT,created INTEGER NOT NULL,sent INTEGER,error TEXT DEFAULT '',remote_id TEXT,token TEXT UNIQUE NOT NULL, UNIQUE(mailbox_id,remote_id),UNIQUE(mailbox_id,direction,message_id));
      CREATE UNIQUE INDEX IF NOT EXISTS automatic_step ON messages(lead_id,step) WHERE kind='campaign' AND direction='out';
      CREATE INDEX IF NOT EXISTS due_leads ON leads(status,due);
      CREATE TABLE IF NOT EXISTS suppressions(email TEXT PRIMARY KEY,reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_status(lead_id TEXT PRIMARY KEY REFERENCES leads(id),status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id),kind TEXT NOT NULL,created INTEGER NOT NULL, UNIQUE(message_id,kind));
      CREATE TABLE IF NOT EXISTS runtime_lock(id INTEGER PRIMARY KEY,owner TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,mime TEXT NOT NULL,data BLOB NOT NULL,created INTEGER NOT NULL);
    `);
    // Additive migration: existing messages remain plain text without a signature.
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(messages)")
        .all()
        .map((c) => c.name),
    );
    for (const [name, value] of [
      ["format", "plain"],
      ["signature", ""],
      ["signature_format", "plain"],
      ["signature_marker", ""],
    ])
      if (!columns.has(name))
        this.db.exec(
          `ALTER TABLE messages ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${value}'`,
        );
  }
  close() {
    this.db.close();
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  seal(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(json(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data]
      .map((b) => b.toString("base64"))
      .join(".");
  }
  unseal(value) {
    const [iv, tag, data] = value
      .split(".")
      .map((v) => Buffer.from(v, "base64"));
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]));
  }
  saveMailbox(input) {
    const address = email(input.email);
    const id = input.id || randomUUID();
    const old = input.id ? this.mailbox(id, true) : null;
    requireValue(
      Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 10000,
      "Лимит ящика: 1–10000",
    );
    const cfg = {
      email: address,
      name: String(input.name || "").slice(0, 100),
      surname: String(input.surname || "").slice(0, 100),
      signature:
        old?.signature ?? String(input.signature || "").slice(0, 20000),
      signatureFormat: old?.signatureFormat || "plain",
      signatureEnabled: old?.signatureEnabled !== false,
      limit: input.limit,
      enabled: input.enabled !== false,
      warmup: old?.warmup || {
        enabled: false,
        consent: false,
        start: 2,
        increase: 1,
        max: 10,
        since: 0,
        pausedAt: 0,
        mode: "automatic-v1",
        providers: warmupProviders,
        planCredit: 0,
      },
    };
    const secrets = {};
    for (const type of ["smtp", "imap"]) {
      const v = input[type];
      requireValue(
        v &&
          /^[a-z0-9.-]+$/i.test(v.host || "") &&
          Number.isInteger(v.port) &&
          v.port > 0 &&
          v.port < 65536,
        `Проверьте ${type.toUpperCase()} host/port`,
      );
      cfg[type] = {
        host: v.host,
        port: v.port,
        secure: v.secure !== false,
        user: String(v.user || address),
      };
      secrets[type] = v.password || old?.[type]?.password;
      requireValue(
        typeof secrets[type] === "string" && secrets[type].length > 0,
        `Нужен пароль ${type.toUpperCase()}`,
      );
    }
    requireValue(
      !/[\r\n]/.test(cfg.name + cfg.surname),
      "Имя не должно содержать переносы",
    );
    this.db
      .prepare(
        `INSERT INTO mailboxes(id,email,config,secrets) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,config=excluded.config,secrets=excluded.secrets,verified=0`,
      )
      .run(id, address, json(cfg), this.seal(secrets));
    return this.mailbox(id);
  }
  mailbox(id, secrets = false) {
    const row = this.db.prepare("SELECT * FROM mailboxes WHERE id=?").get(id);
    requireValue(row, "Ящик не найден");
    const cfg = JSON.parse(row.config);
    cfg.warmup = {
      enabled: false,
      consent: false,
      start: 2,
      increase: 1,
      max: 10,
      since: 0,
      pausedAt: 0,
      mode: "automatic-v1",
      providers: warmupProviders,
      planCredit: 0,
      ...(cfg.warmup || {}),
    };
    const result = {
      ...cfg,
      id,
      verified: !!row.verified,
      error: row.error,
      lastSync: row.last_sync,
    };
    if (secrets) {
      const s = this.unseal(row.secrets);
      for (const t of ["smtp", "imap"])
        result[t] = { ...result[t], password: s[t] };
      result.cursor = JSON.parse(row.cursor);
    }
    return result;
  }
  mailboxes() {
    return this.db
      .prepare("SELECT id FROM mailboxes ORDER BY email")
      .all()
      .map((r) => this.mailbox(r.id));
  }
  saveMailboxSettings(id, input) {
    requireValue(
      Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 10000,
      "Лимит ящика: 1–10000",
    );
    const name = String(input.name || "").slice(0, 100);
    const surname = String(input.surname || "").slice(0, 100);
    const dkimSelector = String(input.dkimSelector || "")
      .trim()
      .toLowerCase();
    requireValue(
      !/[\r\n]/.test(name + surname),
      "Имя не должно содержать переносы",
    );
    requireValue(
      !dkimSelector || /^[a-z0-9_-]{1,63}$/i.test(dkimSelector),
      "Селектор DKIM: латиница, цифры, дефис или подчёркивание",
    );
    const row = this.db
      .prepare("SELECT config FROM mailboxes WHERE id=?")
      .get(id);
    requireValue(row, "Ящик не найден");
    const cfg = JSON.parse(row.config);
    Object.assign(cfg, { name, surname, limit: input.limit, dkimSelector });
    this.db
      .prepare("UPDATE mailboxes SET config=? WHERE id=?")
      .run(json(cfg), id);
    return this.mailbox(id);
  }
  saveSignature(id, input) {
    requireValue(
      typeof input.body === "string" && input.body.length <= 20000,
      "Подпись: максимум 20 000 символов",
    );
    const format = contentFormat(input.format);
    renderContent({ body: input.body, format }, (id) => this.image(id));
    const row = this.db
      .prepare("SELECT config FROM mailboxes WHERE id=?")
      .get(id);
    requireValue(row, "Ящик не найден");
    const cfg = JSON.parse(row.config);
    cfg.signature = input.body;
    cfg.signatureFormat = format;
    cfg.signatureEnabled = input.enabled !== false;
    this.db
      .prepare("UPDATE mailboxes SET config=? WHERE id=?")
      .run(json(cfg), id);
    return this.mailbox(id);
  }
  saveImage(data, mime) {
    validateImage(data, mime);
    const total = this.db
      .prepare("SELECT coalesce(sum(length(data)),0) size FROM images")
      .get().size;
    requireValue(
      total + data.length <= 100_000_000,
      "Хранилище картинок заполнено (100 МБ)",
    );
    const id = randomBytes(16).toString("hex");
    this.db
      .prepare("INSERT INTO images VALUES(?,?,?,?)")
      .run(id, mime, data, Date.now());
    return { id, url: `/api/images/${id}` };
  }
  image(id) {
    return this.db.prepare("SELECT mime,data FROM images WHERE id=?").get(id);
  }
  rendered(message, forEmail = false) {
    return renderContent(message, (id) => this.image(id), forEmail);
  }
  markMailbox(id, ok, error = "") {
    this.db
      .prepare("UPDATE mailboxes SET verified=?,error=? WHERE id=?")
      .run(ok ? 1 : 0, error, id);
  }
  synced(id, cursor, now = Date.now()) {
    this.db
      .prepare("UPDATE mailboxes SET last_sync=?,cursor=?,error='' WHERE id=?")
      .run(now, json(cursor), id);
  }
  syncError(id) {
    this.db
      .prepare(
        "UPDATE mailboxes SET error='Не удалось синхронизировать входящие. Проверьте подключение.' WHERE id=?",
      )
      .run(id);
  }
  saveCampaign(input) {
    const id = input.id || randomUUID();
    if (input.id)
      requireValue(
        this.campaign(id).status === "draft",
        "Редактировать можно только черновик",
      );
    requireValue(
      typeof input.name === "string" &&
        input.name.trim() &&
        input.name.length <= 150,
      "Введите название кампании",
    );
    requireValue(
      Array.isArray(input.steps) &&
        input.steps.length > 0 &&
        input.steps.length <= 20,
      "Цепочка: 1–20 писем",
    );
    const steps = input.steps.map((s, i) => {
      requireValue(
        typeof s.body === "string" && s.body.trim() && s.body.length <= 100000,
        "Заполните текст письма",
      );
      requireValue(
        typeof s.subject === "string" &&
          s.subject.length <= 998 &&
          !/[\r\n]/.test(s.subject),
        "Некорректная тема",
      );
      requireValue(
        Number.isInteger(s.delay) && s.delay >= 0 && s.delay <= 365,
        "Задержка: 0–365 дней",
      );
      requireValue(i > 0 || s.subject.trim(), "Нужна тема первого письма");
      return {
        subject: s.subject,
        body: s.body,
        delay: i ? s.delay : 0,
        format: contentFormat(s.format),
        includeSignature: s.includeSignature !== false,
      };
    });
    requireValue(Array.isArray(input.mailboxIds), "Выберите ящики");
    const mailboxIds = [...new Set(input.mailboxIds)];
    mailboxIds.forEach((mid) => this.mailbox(mid));
    const cfg = {
      steps,
      mailboxIds,
      schedule: validateSchedule(input.schedule || defaultSchedule),
      trackOpens: !!input.trackOpens,
    };
    this.db
      .prepare(
        "INSERT INTO campaigns(id,name,config,created) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config",
      )
      .run(id, input.name.trim(), json(cfg), Date.now());
    return this.campaign(id);
  }
  campaigns() {
    return this.db
      .prepare("SELECT * FROM campaigns ORDER BY created DESC")
      .all()
      .map((r) => ({
        ...r,
        ...JSON.parse(r.config),
        config: undefined,
        counts: this.db
          .prepare(
            "SELECT status,count(*) count FROM leads WHERE campaign_id=? GROUP BY status",
          )
          .all(r.id),
      }));
  }
  campaign(id) {
    const r = this.db.prepare("SELECT * FROM campaigns WHERE id=?").get(id);
    requireValue(r, "Кампания не найдена");
    return {
      ...r,
      ...JSON.parse(r.config),
      config: undefined,
      leads: this.db
        .prepare("SELECT * FROM leads WHERE campaign_id=? ORDER BY rowid")
        .all(id)
        .map((l) => ({ ...l, fields: JSON.parse(l.fields) })),
    };
  }
  importContacts(id, contacts) {
    requireValue(
      this.campaign(id).status === "draft",
      "Импорт доступен только в черновик",
    );
    requireValue(contacts.length > 0, "Нет корректных контактов");
    return this.transaction(() => {
      let added = 0;
      for (const c of contacts) {
        const addr = email(c.email);
        added += Number(
          this.db
            .prepare(
              "INSERT OR IGNORE INTO leads(id,campaign_id,email,fields) VALUES(?,?,?,?)",
            )
            .run(randomUUID(), id, addr, json({ ...c.fields, email: addr }))
            .changes,
        );
      }
      return { added, duplicates: contacts.length - added };
    });
  }
  preview(id, leadId, mailboxId, step = 0) {
    const c = this.campaign(id);
    const l = c.leads.find((l) => l.id === leadId) || c.leads[0];
    requireValue(l, "Загрузите контакты");
    return this.compose(c, l, this.mailbox(mailboxId || c.mailboxIds[0]), step);
  }
  compose(c, l, m, step) {
    requireValue(c.steps[step], "Шаг не найден");
    let subject = "";
    for (let n = 0; n <= step; n++)
      if (c.steps[n].subject) subject = render(c.steps[n].subject, l.fields, m);
    requireValue(
      !/[\r\n]/.test(subject) && subject.length <= 998,
      "Тема после подстановки некорректна",
    );
    const used = new Set();
    const text = render(c.steps[step].body, l.fields, m, used);
    const signature =
      c.steps[step].includeSignature !== false &&
      m.signatureEnabled !== false &&
      !used.has("Подпись Отправителя")
        ? render(m.signature || "", l.fields, m)
        : "";
    const content = {
      body: text,
      format: contentFormat(c.steps[step].format),
      signature,
      signature_format: m.signatureFormat || "plain",
    };
    // Preserve a rich signature inserted into a legacy plain-text CSV template.
    if (
      content.format === "plain" &&
      m.signatureFormat === "markdown" &&
      used.has("Подпись Отправителя")
    ) {
      content.signature_marker = randomUUID();
      content.signature = render(m.signature || "", l.fields, m);
      content.body = render(c.steps[step].body, l.fields, {
        ...m,
        signature: content.signature_marker,
      });
    }
    const formatted = this.rendered(content);
    return {
      subject,
      text,
      body: content.body,
      signature_marker: content.signature_marker || "",
      format: content.format,
      signature: content.signature,
      signature_format: content.signature_format,
      html: formatted.html,
      plainText: formatted.text,
      to: l.email,
      from: m.email,
    };
  }
  setCampaignStatus(id, status) {
    requireValue(["active", "paused"].includes(status), "Недопустимый статус");
    const c = this.campaign(id);
    if (status === "active") {
      requireValue(c.status !== "completed", "Кампания завершена");
      requireValue(
        c.mailboxIds.length && c.leads.length,
        "Нужны ящики и контакты",
      );
      for (const mid of c.mailboxIds) {
        const m = this.mailbox(mid);
        requireValue(
          m.verified && m.enabled,
          "Проверьте подключения всех ящиков",
        );
        for (const l of c.leads)
          for (let i = 0; i < c.steps.length; i++) this.compose(c, l, m, i);
      }
    }
    this.db.prepare("UPDATE campaigns SET status=? WHERE id=?").run(status, id);
    return this.campaign(id);
  }
  available(mid, now, interval = 1) {
    const m = this.mailbox(mid);
    if (!m.enabled || !m.verified) return false;
    const n = this.db
      .prepare(
        "SELECT count(*) n,max(created) last FROM messages WHERE mailbox_id=? AND direction='out' AND status IN ('sending','sent','unknown') AND created>?",
      )
      .get(mid, now - 86400000);
    return n.n < m.limit && (!n.last || now - n.last >= interval * 60000);
  }
  reserve(now, healthy) {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT l.* FROM leads l JOIN campaigns c ON c.id=l.campaign_id WHERE c.status='active' AND l.status='pending' AND l.due<=? ORDER BY l.due,l.rowid",
        )
        .all(now);
      const campaigns = new Map();
      for (const l of rows) {
        if (
          this.db
            .prepare("SELECT 1 FROM suppressions WHERE email=?")
            .get(l.email)
        ) {
          this.db
            .prepare("UPDATE leads SET status='unsubscribed' WHERE id=?")
            .run(l.id);
          continue;
        }
        if (!campaigns.has(l.campaign_id)) {
          const r = this.db
            .prepare("SELECT * FROM campaigns WHERE id=?")
            .get(l.campaign_id);
          const c = { ...r, ...JSON.parse(r.config) };
          c.inWindow = inWindow(new Date(now), c.schedule);
          campaigns.set(r.id, c);
        }
        const c = campaigns.get(l.campaign_id);
        if (!c.inWindow) continue;
        const mids = l.mailbox_id ? [l.mailbox_id] : c.mailboxIds;
        const mid = mids
          .filter(
            (id) =>
              healthy.has(id) && this.available(id, now, c.schedule.interval),
          )
          .sort((a, b) => this.load(a, now) - this.load(b, now))[0];
        if (!mid) continue;
        let p;
        try {
          p = this.compose(
            c,
            { ...l, fields: JSON.parse(l.fields) },
            this.mailbox(mid),
            l.step,
          );
        } catch {
          this.db
            .prepare("UPDATE leads SET status='invalid' WHERE id=?")
            .run(l.id);
          continue;
        }
        const previous = this.db
          .prepare(
            "SELECT message_id,subject FROM messages WHERE lead_id=? AND kind='campaign' AND status='sent' ORDER BY step DESC LIMIT 1",
          )
          .get(l.id);
        const message = this.insertMessage(
          {
            mailbox_id: mid,
            campaign_id: c.id,
            lead_id: l.id,
            step: l.step,
            kind: "campaign",
            recipient: l.email,
            subject: p.subject,
            body: p.body,
            signature_marker: p.signature_marker,
            format: p.format,
            signature: p.signature,
            signature_format: p.signature_format,
            parent: previous?.message_id,
          },
          now,
        );
        this.db
          .prepare("UPDATE leads SET mailbox_id=?,status='sending' WHERE id=?")
          .run(mid, l.id);
        return message;
      }
      return null;
    });
  }
  load(mid, now) {
    return this.db
      .prepare(
        "SELECT count(*) n FROM messages WHERE mailbox_id=? AND direction='out' AND created>?",
      )
      .get(mid, now - 86400000).n;
  }
  insertMessage(v, now) {
    const id = randomUUID();
    const m = this.mailbox(v.mailbox_id);
    const messageId = `<${id}@${m.email.split("@")[1]}>`;
    this.db
      .prepare(
        `INSERT INTO messages(id,message_id,mailbox_id,campaign_id,lead_id,step,kind,direction,status,recipient,subject,body,parent,created,token,format,signature,signature_format,signature_marker) VALUES(?,?,?,?,?,?,?,'out','sending',?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        messageId,
        v.mailbox_id,
        v.campaign_id || null,
        v.lead_id || null,
        v.step ?? null,
        v.kind,
        v.recipient,
        v.subject,
        v.body,
        v.parent || null,
        now,
        randomBytes(24).toString("hex"),
        v.format || "plain",
        v.signature || "",
        v.signature_format || "plain",
        v.signature_marker || "",
      );
    return this.message(id);
  }
  message(id) {
    return this.db.prepare("SELECT * FROM messages WHERE id=?").get(id);
  }
  cancelReservation(id) {
    this.transaction(() => {
      const m = this.message(id);
      requireValue(m?.status === "sending", "Отправка уже обработана");
      this.db
        .prepare(
          "UPDATE leads SET status='pending' WHERE id=? AND status='sending'",
        )
        .run(m.lead_id);
      this.db.prepare("DELETE FROM messages WHERE id=?").run(id);
    });
  }
  finish(id, status, now = Date.now(), error = "", expected = "sending") {
    requireValue(
      ["sent", "failed", "unknown"].includes(status),
      "Статус отправки",
    );
    this.transaction(() => {
      const m = this.message(id);
      requireValue(m && m.status === expected, "Отправка уже обработана");
      this.db
        .prepare("UPDATE messages SET status=?,sent=?,error=? WHERE id=?")
        .run(status, status === "sent" ? now : null, error, id);
      if (m.kind === "campaign") {
        const c = this.campaign(m.campaign_id);
        const next = m.step + 1;
        const state =
          status === "sent"
            ? next < c.steps.length
              ? "pending"
              : "completed"
            : status === "unknown"
              ? "uncertain"
              : "failed";
        this.db
          .prepare(
            "UPDATE leads SET step=?,status=?,due=? WHERE id=? AND status=?",
          )
          .run(
            status === "sent" ? next : m.step,
            state,
            now + (c.steps[next]?.delay || 0) * 86400000,
            m.lead_id,
            expected === "unknown" ? "uncertain" : "sending",
          );
        this.completeCampaign(c.id);
      }
    });
  }
  resolve(id, outcome, now = Date.now()) {
    requireValue(
      ["sent", "cancel"].includes(outcome),
      "Выберите результат проверки",
    );
    requireValue(
      this.message(id)?.status === "unknown",
      "Можно сверять только отправки с неизвестным результатом",
    );
    if (outcome === "sent")
      this.finish(
        id,
        "sent",
        now,
        "Подтверждено оператором после сверки",
        "unknown",
      );
    else
      this.transaction(() => {
        const m = this.message(id);
        this.db
          .prepare(
            "UPDATE messages SET status='cancelled',error='Оператор остановил цепочку после сверки' WHERE id=?",
          )
          .run(id);
        if (m.kind === "campaign") {
          this.db
            .prepare(
              "UPDATE leads SET status='stopped' WHERE id=? AND status='uncertain'",
            )
            .run(m.lead_id);
          this.completeCampaign(m.campaign_id);
        }
      });
    return { id, status: this.message(id).status };
  }
  completeCampaign(id) {
    const row = this.db
      .prepare(
        "SELECT count(*) n FROM leads WHERE campaign_id=? AND status IN ('pending','sending','uncertain','failed','invalid')",
      )
      .get(id);
    if (!row.n)
      this.db
        .prepare(
          "UPDATE campaigns SET status='completed' WHERE id=? AND status='active'",
        )
        .run(id);
  }
  recover(now) {
    this.db
      .prepare(
        "UPDATE leads SET status='uncertain' WHERE status='sending' AND id IN (SELECT lead_id FROM messages WHERE status='sending' AND created<?)",
      )
      .run(now - 600000);
    this.db
      .prepare(
        "UPDATE messages SET status='unknown',error='Процесс прервался: проверьте отправленные письма перед дальнейшими действиями' WHERE status='sending' AND created<?",
      )
      .run(now - 600000);
  }
  ingest(mid, inbound, now = Date.now()) {
    return this.transaction(() => {
      if (
        this.db
          .prepare("SELECT 1 FROM messages WHERE mailbox_id=? AND remote_id=?")
          .get(mid, inbound.remoteId)
      )
        return null;
      const refs = inbound.references || [];
      let original;
      for (const ref of refs) {
        original = this.db
          .prepare(
            "SELECT * FROM messages WHERE mailbox_id=? AND message_id=? AND direction='out'",
          )
          .get(mid, ref);
        if (original) break;
      }
      // Initial warmup messages are received by a different consenting mailbox.
      if (!original && inbound.messageId) {
        const warm = this.db
          .prepare(
            "SELECT * FROM messages WHERE message_id=? AND kind='warmup' AND direction='out'",
          )
          .get(inbound.messageId);
        const target = this.mailbox(mid);
        if (
          warm &&
          warm.recipient === target.email &&
          target.warmup?.enabled &&
          target.warmup.consent &&
          this.mailbox(warm.mailbox_id).warmup?.consent &&
          inbound.from.toLowerCase() === this.mailbox(warm.mailbox_id).email
        ) {
          const id = randomUUID();
          this.db
            .prepare(
              `INSERT OR IGNORE INTO messages(id,message_id,mailbox_id,kind,direction,status,recipient,subject,body,parent,created,remote_id,token) VALUES(?,?,?,'warmup','in','received',?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              inbound.messageId,
              mid,
              inbound.from,
              inbound.subject,
              inbound.text,
              warm.parent,
              now,
              inbound.remoteId,
              randomBytes(24).toString("hex"),
            );
          return this.message(id);
        }
      }
      if (!original) return null; // Do not ingest unrelated personal inbox contents.
      let from;
      try {
        from = email(inbound.from);
      } catch {
        return null;
      }
      if (inbound.type !== "bounce" && from !== original.recipient) return null;
      const kind = original.kind === "warmup" ? "warmup" : inbound.type;
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO messages(id,message_id,mailbox_id,campaign_id,lead_id,kind,direction,status,recipient,subject,body,parent,created,remote_id,token) VALUES(?,?,?,?,?,?,'in','received',?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          inbound.messageId || `<${randomUUID()}@local>`,
          mid,
          original.campaign_id,
          original.lead_id,
          kind,
          from,
          String(inbound.subject || "").slice(0, 998),
          String(inbound.text || "").slice(0, 200000),
          original.message_id,
          now,
          inbound.remoteId,
          randomBytes(24).toString("hex"),
        );
      if (original.lead_id && ["reply", "bounce"].includes(kind)) {
        this.db
          .prepare("UPDATE leads SET status=? WHERE id=?")
          .run(kind === "reply" ? "replied" : "bounced", original.lead_id);
        if (kind === "bounce") this.suppress(original.recipient, "bounce");
        this.completeCampaign(original.campaign_id);
      }
      return this.message(id);
    });
  }
  suppress(addr, reason = "unsubscribe") {
    this.db
      .prepare("INSERT OR IGNORE INTO suppressions VALUES(?,?)")
      .run(email(addr), reason);
    this.db
      .prepare(
        "UPDATE leads SET status='unsubscribed' WHERE email=? AND status IN ('pending','sending')",
      )
      .run(email(addr));
  }
  unsubscribe(token) {
    const m = this.db
      .prepare("SELECT * FROM messages WHERE token=? AND kind='campaign'")
      .get(token);
    requireValue(m, "Ссылка не найдена");
    this.suppress(m.recipient);
  }
  inbox(campaign = "") {
    return this.db
      .prepare(
        `SELECT l.id,l.email,l.campaign_id,c.name campaign,coalesce(t.status,'new') label,max(m.created) updated,count(*) messages FROM leads l JOIN campaigns c ON c.id=l.campaign_id JOIN messages m ON m.lead_id=l.id LEFT JOIN thread_status t ON t.lead_id=l.id WHERE m.direction='in' AND m.kind!='warmup' AND (?='' OR c.id=?) GROUP BY l.id ORDER BY updated DESC`,
      )
      .all(campaign, campaign);
  }
  thread(id) {
    return this.db
      .prepare(
        "SELECT m.*,b.email sender FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE lead_id=? ORDER BY created",
      )
      .all(id)
      .map(({ token, ...m }) => m);
  }
  label(id, status) {
    requireValue(
      ["new", "interested", "closed", "not_interested"].includes(status),
      "Статус диалога",
    );
    this.db
      .prepare(
        "INSERT INTO thread_status VALUES(?,?) ON CONFLICT(lead_id) DO UPDATE SET status=excluded.status",
      )
      .run(id, status);
  }
  reserveReply(leadId, body, now = Date.now(), options = {}) {
    requireValue(
      typeof body === "string" && body.trim() && body.length <= 100000,
      "Введите ответ",
    );
    return this.transaction(() => {
      const l = this.db.prepare("SELECT * FROM leads WHERE id=?").get(leadId);
      requireValue(l && l.mailbox_id, "Диалог не найден");
      requireValue(
        !this.db
          .prepare("SELECT 1 FROM suppressions WHERE email=?")
          .get(l.email),
        "Адрес отписан или заблокирован",
      );
      requireValue(
        this.available(l.mailbox_id, now),
        "Достигнут лимит или интервал ящика",
      );
      const prev = this.db
        .prepare(
          "SELECT * FROM messages WHERE lead_id=? ORDER BY created DESC LIMIT 1",
        )
        .get(leadId);
      requireValue(prev, "Нет переписки");
      const m = this.mailbox(l.mailbox_id);
      const content = {
        body,
        format: contentFormat(options.format),
        signature:
          options.includeSignature !== false && m.signatureEnabled !== false
            ? render(m.signature || "", JSON.parse(l.fields), m)
            : "",
        signature_format: m.signatureFormat || "plain",
      };
      this.rendered(content);
      return this.insertMessage(
        {
          mailbox_id: l.mailbox_id,
          campaign_id: l.campaign_id,
          lead_id: leadId,
          kind: "manual",
          recipient: l.email,
          subject: /^re:/i.test(prev.subject)
            ? prev.subject
            : `Re: ${prev.subject}`,
          ...content,
          parent: prev.message_id,
        },
        now,
      );
    });
  }
  analytics(campaign = "", since = 0) {
    const rows = this.db
      .prepare(
        "SELECT m.*,l.email FROM messages m LEFT JOIN leads l ON l.id=m.lead_id WHERE kind!='warmup' AND (?='' OR m.campaign_id=?) AND m.created>=? ORDER BY m.created DESC",
      )
      .all(campaign, campaign, since);
    const sent = rows.filter(
      (m) => m.direction === "out" && m.status === "sent",
    );
    const replies = rows.filter(
      (m) => m.direction === "in" && m.kind === "reply",
    );
    return {
      sent: sent.length,
      contacted: new Set(sent.map((m) => m.lead_id)).size,
      replies: new Set(replies.map((m) => m.lead_id)).size,
      bounces: rows.filter((m) => m.kind === "bounce").length,
      uncertain: rows.filter((m) => m.status === "unknown").length,
      opens: this.db
        .prepare(
          "SELECT count(*) n FROM events e JOIN messages m ON m.id=e.message_id WHERE e.kind='open' AND (?='' OR m.campaign_id=?) AND e.created>=?",
        )
        .get(campaign, campaign, since).n,
      steps: [
        ...new Set(
          sent.filter((m) => m.kind === "campaign").map((m) => m.step),
        ),
      ]
        .sort((a, b) => a - b)
        .map((step) => ({
          step: step + 1,
          sent: sent.filter((m) => m.kind === "campaign" && m.step === step)
            .length,
          replies: replies.filter((r) =>
            sent.some((m) => m.step === step && m.message_id === r.parent),
          ).length,
        })),
      events: rows.slice(0, 200).map(({ body, token, ...m }) => m),
    };
  }
  track(token, now = Date.now()) {
    const m = this.db
      .prepare("SELECT * FROM messages WHERE token=? AND kind='campaign'")
      .get(token);
    if (m && this.campaign(m.campaign_id).trackOpens)
      this.db
        .prepare("INSERT OR IGNORE INTO events VALUES(?,?,'open',?)")
        .run(randomUUID(), m.id, now);
  }
  warmup(id, input, now = Date.now()) {
    const m = this.mailbox(id);
    const enabled = !!input.enabled;
    let since = m.warmup.since || 0;
    let pausedAt = m.warmup.pausedAt || 0;
    if (enabled && !m.warmup.enabled) {
      if (!since) since = now;
      pausedAt = 0;
    } else if (!enabled && m.warmup.enabled) pausedAt = now;
    const mode = input.reset
      ? "automatic-v1"
      : input.mode || m.warmup.mode || "automatic-v1";
    requireValue(
      ["automatic-v1", "custom"].includes(mode),
      "Неизвестный режим прогрева",
    );
    const start = mode === "custom" ? Number(input.start ?? m.warmup.start) : 2;
    const increase =
      mode === "custom" ? Number(input.increase ?? m.warmup.increase) : 1;
    const max = mode === "custom" ? Number(input.max ?? m.warmup.max) : 10;
    requireValue(
      [start, increase, max].every(
        (value) => Number.isInteger(value) && value >= 1 && value <= 100,
      ) && start <= max,
      "Параметры прогрева: 1–100, старт не больше максимума",
    );
    const providers = input.reset
      ? warmupProviders
      : [...new Set(input.providers || m.warmup.providers || warmupProviders)];
    requireValue(
      providers.length > 0 &&
        providers.every((provider) => warmupProviders.includes(provider)),
      "Выберите доступные почтовые сервисы для прогрева",
    );
    const oldPlan = warmupTargets(m.warmup);
    const sentSince = since
      ? this.db
          .prepare(
            "SELECT count(*) n FROM messages WHERE mailbox_id=? AND kind='warmup' AND direction='out' AND status='sent' AND created>=?",
          )
          .get(id, since).n
      : 0;
    const oldCredit = Math.min(
      1,
      sentSince / oldPlan.reduce((sum, value) => sum + value, 0),
    );
    const w = {
      enabled,
      consent: !!input.consent,
      start,
      increase,
      max,
      since,
      pausedAt,
      mode,
      providers,
      planCredit: Math.max(m.warmup.planCredit || 0, oldCredit),
    };
    requireValue(
      !w.enabled || (w.consent && m.verified),
      "Для прогрева нужны согласие владельца и проверенное подключение",
    );
    const cfg = JSON.parse(
      this.db.prepare("SELECT config FROM mailboxes WHERE id=?").get(id).config,
    );
    cfg.warmup = w;
    this.db
      .prepare("UPDATE mailboxes SET config=? WHERE id=?")
      .run(json(cfg), id);
    return this.mailbox(id);
  }
  bulkWarmup(ids, enabled, now = Date.now()) {
    requireValue(
      Array.isArray(ids) && ids.length > 0 && ids.length <= 1000,
      "Выберите от 1 до 1000 ящиков",
    );
    const selected = [...new Set(ids.map(String))];
    const mailboxes = selected.map((id) => this.mailbox(id));
    if (enabled) {
      requireValue(
        mailboxes.every((m) => m.verified && m.enabled),
        "Для прогрева нужны проверенные и включённые ящики",
      );
      const selectedIds = new Set(selected);
      const futurePool = this.mailboxes().filter(
        (m) =>
          m.verified &&
          m.enabled &&
          !m.error &&
          (selectedIds.has(m.id) || (m.warmup?.enabled && m.warmup.consent)),
      );
      requireValue(
        futurePool.length >= 2,
        "Для прогрева нужны минимум два проверенных ящика",
      );
    }
    return this.transaction(() =>
      mailboxes.map((m) =>
        this.warmup(
          m.id,
          {
            ...m.warmup,
            enabled,
            consent: enabled ? true : m.warmup.consent,
          },
          now,
        ),
      ),
    );
  }
  mailboxOverview(now = Date.now()) {
    const mailboxes = this.mailboxes();
    const activePool = mailboxes.filter(
      (m) =>
        m.verified &&
        m.enabled &&
        !m.error &&
        m.warmup?.enabled &&
        m.warmup.consent,
    ).length;
    const stats = this.db.prepare(
      `SELECT
        coalesce(sum(direction='out' AND status='sent'),0) sent,
        coalesce(sum(direction='in'),0) received,
        coalesce(sum(direction='in' AND parent IS NOT NULL),0) replies,
        coalesce(sum(direction='out' AND status='failed'),0) failed,
        coalesce(sum(direction='out' AND status='unknown'),0) uncertain,
        coalesce(sum(direction='out' AND status='sent' AND created>=?),0) sent24h,
        coalesce(sum(direction='in' AND parent IS NOT NULL AND created>=?),0) replies24h,
        coalesce(sum(direction='out' AND status='sent' AND created>=?),0) sentSince,
        coalesce(sum(direction='out' AND status='failed' AND created>=?),0) failedSince,
        coalesce(sum(direction='out' AND status='unknown' AND created>=?),0) uncertainSince,
        coalesce(sum(direction='in' AND created>=?),0) receivedSince,
        count(DISTINCT CASE WHEN direction='out' AND status='sent' AND created>=? THEN strftime('%Y-%m-%d',created/1000.0,'unixepoch') END) activeDays,
        coalesce(sum(direction='out' AND status='sent' AND created>=?),0) sentToday
      FROM messages WHERE mailbox_id=? AND kind='warmup'`,
    );
    return mailboxes.map((m) => {
      const plan = warmupTargets(m.warmup);
      const since = m.warmup.since || now;
      const current = new Date(now);
      const utcDayStart = Date.UTC(
        current.getUTCFullYear(),
        current.getUTCMonth(),
        current.getUTCDate(),
      );
      const warmupStats = stats.get(
        now - 86400000,
        now - 86400000,
        since,
        since,
        since,
        since,
        since,
        utcDayStart,
        m.id,
      );
      const connectionHealthy = m.verified && m.enabled && !m.error;
      const attempts =
        warmupStats.sent + warmupStats.failed + warmupStats.uncertain;
      const parts = {
        connection: connectionHealthy ? 40 : 0,
        sync:
          connectionHealthy && m.lastSync && now - m.lastSync <= 15 * 60000
            ? 25
            : 0,
        sending: connectionHealthy
          ? attempts
            ? Math.round((20 * warmupStats.sent) / attempts)
            : 0
          : 0,
        receiving: connectionHealthy && warmupStats.received ? 15 : 0,
      };
      let warmupStatus = "paused";
      if (!m.verified) warmupStatus = "unverified";
      else if (!m.enabled || m.error) warmupStatus = "error";
      else if (m.warmup?.enabled && m.warmup.consent)
        warmupStatus = activePool >= 2 ? "warming" : "waiting";
      const day = Math.min(
        plan.length,
        Math.max(1, warmupStats.activeDays + (warmupStats.sentToday ? 0 : 1)),
      );
      const programFraction = Math.min(1, warmupStats.activeDays / plan.length);
      const expected = plan.slice(0, day).reduce((a, b) => a + b, 0);
      const totalPlan = plan.reduce((a, b) => a + b, 0);
      const attemptsSince =
        warmupStats.sentSince +
        warmupStats.failedSince +
        warmupStats.uncertainSince;
      const success = attemptsSince ? warmupStats.sentSince / attemptsSince : 0;
      const progressParts = {
        duration: Math.round(40 * programFraction),
        plan: Math.round(
          25 *
            Math.max(
              m.warmup.planCredit || 0,
              Math.min(1, warmupStats.sentSince / totalPlan),
            ),
        ),
        sending: Math.round(20 * programFraction * success),
        receiving: Math.round(
          15 * programFraction * Number(warmupStats.receivedSince > 0),
        ),
      };
      const progressScore = Object.values(progressParts).reduce(
        (sum, value) => sum + value,
        0,
      );
      return {
        ...m,
        warmupStatus,
        warmupStats,
        currentWarmupLimit: plan[day - 1],
        warmupProgress: {
          score: progressScore,
          label: warmupLabel(progressScore),
          day,
          totalDays: plan.length,
          target: plan[day - 1],
          expected,
          parts: progressParts,
        },
        health: {
          score: Object.values(parts).reduce((sum, value) => sum + value, 0),
          parts,
        },
      };
    });
  }
  reserveWarmup(now, healthy) {
    return this.transaction(() => {
      const pool = this.mailboxes().filter(
        (m) => m.warmup?.enabled && m.warmup.consent && healthy.has(m.id),
      );
      if (pool.length < 2) return null;
      const eligible = (m) => {
        const plan = warmupTargets(m.warmup);
        const current = new Date(now);
        const utcDayStart = Date.UTC(
          current.getUTCFullYear(),
          current.getUTCMonth(),
          current.getUTCDate(),
        );
        const program = this.db
          .prepare(
            `SELECT
              count(DISTINCT CASE WHEN status='sent' AND created>=? THEN strftime('%Y-%m-%d',created/1000.0,'unixepoch') END) activeDays,
              coalesce(sum(status='sent' AND created>=?),0) sentToday
            FROM messages
            WHERE mailbox_id=? AND kind='warmup' AND direction='out'`,
          )
          .get(m.warmup.since || now, utcDayStart, m.id);
        const day = Math.min(
          plan.length,
          Math.max(1, program.activeDays + (program.sentToday ? 0 : 1)),
        );
        const limit = plan[day - 1];
        const count = this.db
          .prepare(
            "SELECT count(*) n FROM messages WHERE mailbox_id=? AND kind='warmup' AND direction='out' AND created>?",
          )
          .get(m.id, now - 86400000).n;
        return count < limit && this.available(m.id, now, 30);
      };
      const waiting = this.db
        .prepare(
          "SELECT * FROM messages i WHERE i.kind='warmup' AND i.direction='in' AND i.parent IS NULL AND i.created<? AND NOT EXISTS(SELECT 1 FROM messages o WHERE o.direction='out' AND o.mailbox_id=i.mailbox_id AND o.parent=i.message_id)",
        )
        .all(now - 1800000);
      for (const incoming of waiting) {
        const m = pool.find((m) => m.id === incoming.mailbox_id);
        if (
          m &&
          pool.some((p) => p.email === incoming.recipient) &&
          eligible(m)
        )
          return this.insertMessage(
            {
              mailbox_id: m.id,
              kind: "warmup",
              recipient: incoming.recipient,
              subject: `Re: ${incoming.subject}`,
              body: "Контрольное письмо получено. Ответ из подключённого ящика Dmailio.",
              parent: incoming.message_id,
            },
            now,
          );
      }
      for (const m of pool) {
        if (!eligible(m)) continue;
        const target = pool
          .filter((p) => p.id !== m.id)
          .sort((a, b) => this.load(a.id, now) - this.load(b.id, now))[0];
        return this.insertMessage(
          {
            mailbox_id: m.id,
            kind: "warmup",
            recipient: target.email,
            subject: "Проверка почтового подключения Dmailio",
            body: "Контрольное письмо между подключёнными участниками прогрева Dmailio. Проверяем получение и возможность ответа.",
          },
          now,
        );
      }
      return null;
    });
  }
  warmupStats() {
    return this.db
      .prepare(
        "SELECT mailbox_id,direction,status,count(*) count FROM messages WHERE kind='warmup' GROUP BY mailbox_id,direction,status",
      )
      .all();
  }
}
