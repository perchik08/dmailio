import { randomUUID, createHash } from "node:crypto";
import sanitize from "sanitize-html";
import { email, requireValue, render } from "./core.mjs";
import { contentFormat } from "./content.mjs";

const MAX_ATTACHMENTS = 20;
const MAX_BYTES = 8 * 1024 * 1024;
const json = JSON.stringify;
const parse = (v, fallback = {}) => (v ? JSON.parse(v) : fallback);
const header = (v, max = 1000) => {
  const value = String(v || "");
  requireValue(
    !/[\r\n\0]/.test(value) && value.length <= max,
    "Некорректный заголовок письма",
  );
  return value;
};
const safeHtml = (value) =>
  sanitize(String(value || "").slice(0, 200000), {
    allowedTags: [
      "p",
      "br",
      "div",
      "span",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "h1",
      "h2",
      "h3",
      "hr",
    ],
    allowedAttributes: {},
  });
function attachments(values = [], outgoing = false) {
  requireValue(
    Array.isArray(values) && values.length <= MAX_ATTACHMENTS,
    "Вложения: максимум 20 файлов",
  );
  let total = 0;
  return values.map((v) => {
    let data;
    if (outgoing) {
      requireValue(
        typeof v.data === "string" &&
          v.data.length <= Math.ceil(MAX_BYTES / 3) * 4 &&
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            v.data,
          ),
        "Некорректное вложение base64",
      );
      data = Buffer.from(v.data, "base64");
    } else {
      requireValue(Buffer.isBuffer(v.data), "Некорректное вложение");
      data = v.data;
    }
    total += data.length;
    requireValue(total <= MAX_BYTES, "Вложения: максимум 8 МБ");
    return {
      name: outgoing
        ? header(v.name || "attachment", 255)
        : String(v.name || "attachment")
            .replace(/[\r\n\0]/g, " ")
            .slice(0, 255),
      type: outgoing
        ? header(v.type || "application/octet-stream", 100)
        : String(v.type || "application/octet-stream")
            .replace(/[\r\n\0]/g, " ")
            .slice(0, 100),
      data,
    };
  });
}

/** Additive full mailbox storage. Ordinary sends remain in Store.messages for shared quota accounting. */
export class FullInboxStore {
  constructor(ownerStore) {
    this.owner = ownerStore;
    this.db = ownerStore.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS full_inbox_messages(id TEXT PRIMARY KEY,mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),identity TEXT NOT NULL,subject TEXT NOT NULL,sender TEXT NOT NULL,created INTEGER NOT NULL,metadata TEXT NOT NULL,search_text TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'mail',campaign_id TEXT,legacy_id TEXT,read INTEGER NOT NULL DEFAULT 0,starred INTEGER NOT NULL DEFAULT 0,UNIQUE(mailbox_id,identity));
      CREATE INDEX IF NOT EXISTS full_inbox_created ON full_inbox_messages(created);
      CREATE TABLE IF NOT EXISTS full_inbox_locations(mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),folder TEXT NOT NULL,validity TEXT NOT NULL,uid INTEGER NOT NULL,message_id TEXT NOT NULL REFERENCES full_inbox_messages(id) ON DELETE CASCADE,flags TEXT NOT NULL,PRIMARY KEY(mailbox_id,folder,validity,uid));
      CREATE INDEX IF NOT EXISTS full_inbox_message_locations ON full_inbox_locations(message_id);
      CREATE TABLE IF NOT EXISTS full_inbox_attachments(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES full_inbox_messages(id) ON DELETE CASCADE,name TEXT NOT NULL,type TEXT NOT NULL,data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS full_inbox_drafts(id TEXT PRIMARY KEY,mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),input TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS full_inbox_outgoing(message_id TEXT PRIMARY KEY REFERENCES messages(id),request_id TEXT NOT NULL UNIQUE,metadata TEXT NOT NULL,sent_copy_error TEXT,sent_copy_recorded INTEGER NOT NULL DEFAULT 0,attachment_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS full_inbox_local_flags(message_id TEXT PRIMARY KEY REFERENCES messages(id),read INTEGER NOT NULL DEFAULT 1,starred INTEGER NOT NULL DEFAULT 0);
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(full_inbox_outgoing)")
        .all()
        .some((v) => v.name === "attachment_count")
    )
      this.db.exec(
        "ALTER TABLE full_inbox_outgoing ADD COLUMN attachment_count INTEGER NOT NULL DEFAULT 0",
      );
    // Existing campaign conversations remain visible on rollout. Stable legacy identities
    // deliberately do not deduplicate new IMAP mail by Message-ID.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO full_inbox_messages(id,mailbox_id,identity,subject,sender,created,metadata,search_text,kind,campaign_id,legacy_id)
      SELECT id,mailbox_id,'legacy:' || id,subject,recipient,created,json_object('messageId',message_id,'references',json('[]'),'to',json_array((SELECT email FROM mailboxes WHERE id=messages.mailbox_id)),'cc',json('[]'),'replyTo',json('[]'),'text',body,'html','','internalDate',created,'localFolders',json('["INBOX"]')),subject || char(10) || recipient || char(10) || body,CASE WHEN kind='warmup' THEN 'warmup' WHEN campaign_id IS NOT NULL THEN 'campaign' ELSE 'mail' END,campaign_id,id FROM messages WHERE direction='in' AND NOT EXISTS(SELECT 1 FROM full_inbox_messages f WHERE f.legacy_id=messages.id)`,
      )
      .run();
    this.db
      .exec(`UPDATE full_inbox_messages SET kind=(SELECT kind FROM messages WHERE id=legacy_id)
      WHERE kind IN ('mail','campaign') AND EXISTS(SELECT 1 FROM messages WHERE id=legacy_id AND kind IN ('reply','bounce','auto'));`);
  }
  capture(mailboxId, inbound, now = Date.now()) {
    requireValue(this.owner.mailbox(mailboxId), "Ящик не найден");
    const folder = String(inbound.folder || "INBOX").slice(0, 1000);
    const validity = String(inbound.validity || "0");
    const uid = Number(inbound.uid);
    requireValue(Number.isSafeInteger(uid) && uid > 0, "Некорректный UID");
    const files = attachments(inbound.attachments);
    const metadata = {
      messageId: String(inbound.messageId || "").slice(0, 1000),
      references: (Array.isArray(inbound.references) ? inbound.references : [])
        .map((v) => String(v).slice(0, 1000))
        .slice(-100),
      to: (inbound.to || []).map(String),
      cc: (inbound.cc || []).map(String),
      replyTo: (inbound.replyTo || []).map(String),
      text: String(inbound.text || "").slice(0, 200000),
      html: safeHtml(inbound.html),
      internalDate: Number(inbound.internalDate) || now,
      type: inbound.type || "mail",
    };
    const identity = String(
      inbound.identity ||
        createHash("sha256")
          .update(
            json([
              metadata,
              inbound.from,
              inbound.subject,
              files.map((v) => [v.name, v.data.toString("base64")]),
            ]),
          )
          .digest("hex"),
    );
    return this.owner.transaction(() => {
      const location = this.db
        .prepare(
          "SELECT message_id id FROM full_inbox_locations WHERE mailbox_id=? AND folder=? AND validity=? AND uid=?",
        )
        .get(mailboxId, folder, validity, uid);
      let row =
        location ||
        this.db
          .prepare(
            "SELECT id FROM full_inbox_messages WHERE mailbox_id=? AND identity=?",
          )
          .get(mailboxId, identity);
      const fresh = !row;
      const flags = Array.isArray(inbound.flags)
        ? inbound.flags.map(String)
        : [];
      if (!row) {
        row = { id: randomUUID() };
        const subject = String(inbound.subject || "").slice(0, 1000),
          from = String(inbound.from || "").slice(0, 2000);
        this.db
          .prepare(
            "INSERT INTO full_inbox_messages(id,mailbox_id,identity,subject,sender,created,metadata,search_text,read,starred) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            row.id,
            mailboxId,
            identity,
            subject,
            from,
            metadata.internalDate,
            json(metadata),
            [subject, from, ...metadata.to, metadata.text].join("\n"),
            +flags.includes("\\Seen"),
            +flags.includes("\\Flagged"),
          );
        for (const file of files)
          this.db
            .prepare("INSERT INTO full_inbox_attachments VALUES(?,?,?,?,?)")
            .run(randomUUID(), row.id, file.name, file.type, file.data);
      }
      this.db
        .prepare(
          "INSERT INTO full_inbox_locations VALUES(?,?,?,?,?,?) ON CONFLICT(mailbox_id,folder,validity,uid) DO UPDATE SET flags=excluded.flags",
        )
        .run(mailboxId, folder, validity, uid, row.id, json(flags));
      const stored = this.db
        .prepare("SELECT metadata FROM full_inbox_messages WHERE id=?")
        .get(row.id);
      const pending = parse(stored.metadata);
      if (pending.localFolders?.includes(folder)) {
        pending.localFolders = pending.localFolders.filter((v) => v !== folder);
        this.db
          .prepare("UPDATE full_inbox_messages SET metadata=? WHERE id=?")
          .run(json(pending), row.id);
      }
      return { id: row.id, fresh };
    });
  }
  annotate(id, legacyMessage) {
    if (!legacyMessage) return;
    this.db
      .prepare(
        "UPDATE full_inbox_messages SET kind=?,campaign_id=?,legacy_id=? WHERE id=?",
      )
      .run(
        legacyMessage.kind === "warmup"
          ? "warmup"
          : ["reply", "bounce", "auto"].includes(legacyMessage.kind)
            ? legacyMessage.kind
            : legacyMessage.campaign_id
              ? "campaign"
              : "mail",
        legacyMessage.campaign_id || null,
        legacyMessage.id || null,
        id,
      );
  }
  isOutgoing(mailboxId, messageId) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM messages WHERE mailbox_id=? AND message_id=? AND direction='out'",
      )
      .get(mailboxId, messageId);
  }
  updateLocationFlags(mailboxId, folder, validity, uid, flags) {
    return this.reconcileFolder(
      mailboxId,
      folder,
      validity,
      [{ uid, flags }],
      false,
    );
  }
  locations(mailboxId, folder, { limit = 200, afterUid = 0 } = {}) {
    return this.db
      .prepare(
        "SELECT message_id id,folder,validity,uid FROM full_inbox_locations WHERE mailbox_id=? AND folder=? AND uid>? ORDER BY uid LIMIT ?",
      )
      .all(mailboxId, folder, afterUid, Math.min(1000, Math.max(1, limit)));
  }
  removeLocations(mailboxId, folder, validity, uids) {
    return this.owner.transaction(() => {
      let count = 0;
      for (const uid of uids)
        count += this.db
          .prepare(
            "DELETE FROM full_inbox_locations WHERE mailbox_id=? AND folder=? AND validity=? AND uid=?",
          )
          .run(mailboxId, folder, String(validity), uid).changes;
      return count;
    });
  }
  reconcileFolder(mailboxId, folder, validity, observations, complete = false) {
    return this.owner.transaction(() => {
      for (const item of observations) {
        const loc = this.db
          .prepare(
            "SELECT message_id FROM full_inbox_locations WHERE mailbox_id=? AND folder=? AND validity=? AND uid=?",
          )
          .get(mailboxId, folder, String(validity), item.uid);
        if (!loc) continue;
        const flags = item.flags || [];
        this.db
          .prepare(
            "UPDATE full_inbox_locations SET flags=? WHERE mailbox_id=? AND folder=? AND validity=? AND uid=?",
          )
          .run(json(flags), mailboxId, folder, String(validity), item.uid);
        this.setLocalFlags(loc.message_id, {
          read: flags.includes("\\Seen"),
          starred: flags.includes("\\Flagged"),
        });
      }
      if (!complete) return 0;
      const keep = new Set(observations.map((v) => Number(v.uid)));
      let count = 0;
      for (const loc of this.db
        .prepare(
          "SELECT validity,uid FROM full_inbox_locations WHERE mailbox_id=? AND folder=?",
        )
        .all(mailboxId, folder)) {
        if (loc.validity !== String(validity) || !keep.has(loc.uid))
          count += this.db
            .prepare(
              "DELETE FROM full_inbox_locations WHERE mailbox_id=? AND folder=? AND validity=? AND uid=?",
            )
            .run(mailboxId, folder, loc.validity, loc.uid).changes;
      }
      return count;
    });
  }
  setLocalFlags(id, input) {
    const row = this.db
      .prepare("SELECT id FROM full_inbox_messages WHERE id=?")
      .get(id);
    if (!row && this.owner.message(id)?.direction === "out") {
      for (const name of ["read", "starred"])
        if (input[name] !== undefined)
          requireValue(typeof input[name] === "boolean", "Некорректный флаг");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO full_inbox_local_flags(message_id) VALUES(?)",
        )
        .run(id);
      for (const name of ["read", "starred"])
        if (input[name] !== undefined)
          this.db
            .prepare(
              `UPDATE full_inbox_local_flags SET ${name}=? WHERE message_id=?`,
            )
            .run(+input[name], id);
      return this.get(id);
    }
    requireValue(row, "Письмо не найдено");
    for (const name of ["read", "starred"])
      if (input[name] !== undefined) {
        requireValue(typeof input[name] === "boolean", "Некорректный флаг");
        this.db
          .prepare(`UPDATE full_inbox_messages SET ${name}=? WHERE id=?`)
          .run(+input[name], id);
      }
    return this.get(id);
  }
  relocate(id, oldFolder, newFolder, remote = {}) {
    // IMAP MOVE assigns new UIDs: remove stale source UID immediately. Sync discovers target location.
    this.db
      .prepare(
        "DELETE FROM full_inbox_locations WHERE message_id=? AND folder=?",
      )
      .run(id, oldFolder);
    const row = this.db
      .prepare("SELECT mailbox_id,metadata FROM full_inbox_messages WHERE id=?")
      .get(id);
    requireValue(row, "Письмо не найдено");
    if (
      Number.isSafeInteger(Number(remote.uid)) &&
      Number(remote.uid) > 0 &&
      remote.validity
    )
      this.db
        .prepare(
          "INSERT OR REPLACE INTO full_inbox_locations VALUES(?,?,?,?,?,?)",
        )
        .run(
          row.mailbox_id,
          newFolder,
          String(remote.validity),
          Number(remote.uid),
          id,
          json(remote.flags || []),
        );
    else {
      const metadata = parse(row.metadata);
      metadata.localFolders = [
        ...new Set([
          ...(metadata.localFolders || []).filter((v) => v !== oldFolder),
          newFolder,
        ]),
      ];
      this.db
        .prepare("UPDATE full_inbox_messages SET metadata=? WHERE id=?")
        .run(json(metadata), id);
    }
    return this.get(id);
  }
  attachment(id) {
    const match = /^([a-f0-9-]{36}):(\d+)$/.exec(String(id));
    if (match) {
      const file = this.outgoing(match[1])?.attachments[Number(match[2])];
      return file
        ? { name: file.name, type: file.type, data: file.data }
        : null;
    }
    const row = this.db
      .prepare("SELECT name,type,data FROM full_inbox_attachments WHERE id=?")
      .get(id);
    return row ? { ...row, data: Buffer.from(row.data) } : null;
  }
  item(row) {
    const locations = this.db
      .prepare(
        "SELECT folder,validity,uid FROM full_inbox_locations WHERE message_id=? ORDER BY folder",
      )
      .all(row.id);
    return {
      id: row.id,
      mailboxId: row.mailbox_id,
      mailboxEmail: this.owner.mailbox(row.mailbox_id)?.email || "",
      from: row.sender,
      subject: row.subject,
      created: row.created,
      folders: [
        ...new Set([
          ...locations.map((v) => v.folder),
          ...(parse(row.metadata).localFolders || []),
        ]),
      ],
      kind: row.kind,
      campaignId: row.campaign_id || null,
      read: !!row.read,
      starred: !!row.starred,
      direction: "in",
      status: "received",
      attachments: this.db
        .prepare(
          "SELECT count(*) n FROM full_inbox_attachments WHERE message_id=?",
        )
        .get(row.id).n,
    };
  }
  get(id) {
    const row = this.db
      .prepare("SELECT * FROM full_inbox_messages WHERE id=?")
      .get(id);
    if (row)
      return {
        ...this.item(row),
        ...parse(row.metadata),
        locations: this.db
          .prepare(
            "SELECT folder,validity,uid FROM full_inbox_locations WHERE message_id=? ORDER BY folder",
          )
          .all(id),
        attachments: this.db
          .prepare(
            "SELECT id,name,type,length(data) size FROM full_inbox_attachments WHERE message_id=?",
          )
          .all(id),
      };
    const sent = this.owner.message(id);
    if (sent?.direction === "out") {
      const extra = this.outgoing(id) || {};
      const rendered = this.owner.rendered(sent);
      return {
        ...this.sentItem(sent),
        to: extra.to || [sent.recipient],
        cc: extra.cc || [],
        replyTo: [],
        references: extra.references || [],
        messageId: sent.message_id,
        text: rendered.text,
        html: safeHtml(rendered.html),
        locations: [],
        attachments: (extra.attachments || []).map((v, i) => ({
          id: `${id}:${i}`,
          name: v.name,
          type: v.type,
          size: v.data.length,
        })),
        sentCopyError: extra.sentCopyError || null,
        deliveryWarning: extra.deliveryWarning || null,
      };
    }
    return null;
  }
  sentItem(row) {
    const extra = this.db
      .prepare(
        "SELECT attachment_count,sent_copy_error FROM full_inbox_outgoing WHERE message_id=?",
      )
      .get(row.id);
    const flags = this.db
      .prepare(
        "SELECT read,starred FROM full_inbox_local_flags WHERE message_id=?",
      )
      .get(row.id);
    return {
      id: row.id,
      mailboxId: row.mailbox_id,
      mailboxEmail: this.owner.mailbox(row.mailbox_id)?.email || "",
      from: this.owner.mailbox(row.mailbox_id)?.email || "",
      subject: row.subject,
      created: row.created,
      folders: ["Sent"],
      kind: row.kind,
      campaignId: row.campaign_id || null,
      read: flags ? !!flags.read : true,
      starred: !!flags?.starred,
      direction: "out",
      status: row.status,
      attachments: extra?.attachment_count || 0,
      error: row.error,
      sentCopyError: extra?.sent_copy_error || null,
    };
  }
  list(filters = {}) {
    const page = Math.max(
        1,
        Math.min(1000000, Math.floor(Number(filters.page) || 1)),
      ),
      pageSize = Math.max(
        1,
        Math.min(100, Math.floor(Number(filters.pageSize) || 50)),
      );
    const warnings = [];
    const mailboxes = this.db
      .prepare("SELECT id FROM mailboxes")
      .all()
      .map((v) => this.owner.mailbox(v.id, true));
    for (const m of mailboxes) {
      if (filters.mailboxId && filters.mailboxId !== m.id) continue;
      for (const error of m.cursor?.errors || [])
        warnings.push(typeof error === "string" ? error : json(error));
      if (m.cursor?.since)
        warnings.push(
          `Сбор почты ${m.email} начат ${new Date(m.cursor.since).toISOString()}; более ранние письма не загружаются.`,
        );
    }
    if (filters.view === "drafts") {
      let items = this.drafts().filter(
        (v) => !filters.mailboxId || v.mailboxId === filters.mailboxId,
      );
      if (filters.search)
        items = items.filter((v) =>
          [v.subject, v.body]
            .join("\n")
            .toLowerCase()
            .includes(String(filters.search).toLowerCase()),
        );
      return {
        items: items.slice((page - 1) * pageSize, page * pageSize),
        total: items.length,
        page,
        pageSize,
        folders: [],
        warnings,
      };
    }
    const sent = filters.view === "sent";
    const clauses = [],
      values = [];
    if (filters.mailboxId) {
      clauses.push("mailbox_id=?");
      values.push(filters.mailboxId);
    }
    if (filters.campaign) {
      clauses.push("campaign_id=?");
      values.push(filters.campaign);
    }
    if (filters.kind) {
      if (!sent && filters.kind === "campaign")
        clauses.push("campaign_id IS NOT NULL");
      else if (!sent && filters.kind === "bounce")
        clauses.push(
          "kind!='warmup' AND (kind='bounce' OR json_extract(metadata,'$.type')='bounce')",
        );
      else {
        clauses.push("kind=?");
        values.push(filters.kind);
      }
    }
    if (filters.search) {
      clauses.push(
        sent
          ? "instr(lower(subject || char(10) || body || char(10) || recipient),lower(?))>0"
          : "instr(lower(search_text),lower(?))>0",
      );
      values.push(String(filters.search).slice(0, 1000));
    }
    if (sent) clauses.push("direction='out'");
    else if (filters.folder) {
      clauses.push(
        "(EXISTS(SELECT 1 FROM full_inbox_locations l WHERE l.message_id=full_inbox_messages.id AND l.folder=?) OR EXISTS(SELECT 1 FROM json_each(metadata,'$.localFolders') WHERE value=?))",
      );
      values.push(filters.folder, filters.folder);
    }
    const table = sent ? "messages" : "full_inbox_messages",
      where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const total = this.db
      .prepare(`SELECT count(*) n FROM ${table}${where}`)
      .get(...values).n;
    const items = this.db
      .prepare(
        `SELECT * FROM ${table}${where} ORDER BY created DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, pageSize, (page - 1) * pageSize)
      .map((row) => (sent ? this.sentItem(row) : this.item(row)));
    const folders = this.db
      .prepare(
        `SELECT DISTINCT folder FROM full_inbox_locations${filters.mailboxId ? " WHERE mailbox_id=?" : ""}
         UNION SELECT value folder FROM full_inbox_messages,json_each(metadata,'$.localFolders')${filters.mailboxId ? " WHERE mailbox_id=?" : ""} ORDER BY folder`,
      )
      .all(...(filters.mailboxId ? [filters.mailboxId, filters.mailboxId] : []))
      .map((v) => v.folder);
    return { items, total, page, pageSize, folders, warnings };
  }
  validateInput(input, sending = false) {
    requireValue(input && typeof input === "object", "Некорректное письмо");
    const mailbox = this.owner.mailbox(input.mailboxId);
    requireValue(mailbox, "Выберите ящик отправителя");
    const recipients = (values) => {
      requireValue(
        values === undefined || Array.isArray(values),
        "Получатели должны быть списком",
      );
      return [...new Set((values || []).map((v) => email(header(v, 320))))];
    };
    const to = recipients(input.to),
      cc = recipients(input.cc),
      bcc = recipients(input.bcc);
    const reply = input.replyToId ? this.get(input.replyToId) : null;
    if (reply && !to.length)
      to.push(
        ...recipients(
          reply.direction === "out"
            ? reply.to
            : reply.replyTo.length
              ? reply.replyTo
              : [reply.from],
        ),
      );
    if (reply && input.replyAll) {
      const own = mailbox.email.toLowerCase();
      for (const address of recipients([...reply.to, ...reply.cc]))
        if (address !== own && !to.includes(address) && !cc.includes(address))
          cc.push(address);
    }
    requireValue(
      to.length + cc.length + bcc.length <= 100 &&
        (!sending || to.length + cc.length + bcc.length > 0),
      "Укажите получателей (максимум 100)",
    );
    let body = String(input.body || "");
    requireValue(
      body.length <= 200000,
      "Текст письма: максимум 200000 символов",
    );
    let files = attachments(input.attachments, true);
    if (input.forwardId) {
      const source = this.get(input.forwardId);
      requireValue(source, "Исходное письмо не найдено");
      if (!body)
        body = `---------- Forwarded message ----------\nFrom: ${source.from}\nSubject: ${source.subject}\n\n${source.text || ""}`;
      requireValue(
        body.length <= 200000,
        "Текст письма: максимум 200000 символов",
      );
      const originals = (source.attachments || [])
        .map((v) => this.attachment(v.id))
        .filter(Boolean);
      for (const original of originals)
        if (
          !files.some(
            (v) => v.name === original.name && v.data.equals(original.data),
          )
        )
          files.push(original);
      files = attachments(files);
    }
    const value = {
      mailboxId: mailbox.id,
      to,
      cc,
      bcc,
      subject: header(input.subject, 1000),
      body,
      format: contentFormat(input.format || "plain"),
      attachments: files.map((v) => ({
        ...v,
        data: v.data.toString("base64"),
      })),
      replyToId: input.replyToId || null,
      forwardId: input.forwardId || null,
      replyAll: !!input.replyAll,
    };
    for (const id of [value.replyToId, value.forwardId].filter(Boolean))
      requireValue(this.get(id), "Исходное письмо не найдено");
    return value;
  }
  saveDraft(input) {
    const value = this.validateInput(input);
    const id = input.id || input.draftId || randomUUID(),
      now = Date.now();
    if (input.id || input.draftId)
      requireValue(
        this.db.prepare("SELECT id FROM full_inbox_drafts WHERE id=?").get(id),
        "Черновик не найден",
      );
    this.db
      .prepare(
        "INSERT INTO full_inbox_drafts VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mailbox_id=excluded.mailbox_id,input=excluded.input,updated=excluded.updated",
      )
      .run(id, value.mailboxId, json(value), now, now);
    return this.drafts().find((v) => v.id === id);
  }
  drafts() {
    return this.db
      .prepare("SELECT * FROM full_inbox_drafts ORDER BY updated DESC")
      .all()
      .map((v) => ({
        ...parse(v.input),
        id: v.id,
        created: v.created,
        updated: v.updated,
        direction: "out",
        status: "draft",
        kind: "mail",
        folders: ["Drafts"],
        mailboxEmail: this.owner.mailbox(v.mailbox_id)?.email || "",
      }));
  }
  deleteDraft(id) {
    return (
      this.db.prepare("DELETE FROM full_inbox_drafts WHERE id=?").run(id)
        .changes > 0
    );
  }
  reserveOutgoing(input, now = Date.now()) {
    const requestId = header(input.requestId, 200);
    requireValue(requestId, "requestId обязателен");
    return this.owner.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT message_id FROM full_inbox_outgoing WHERE request_id=?",
        )
        .get(requestId);
      if (existing)
        return {
          ...this.owner.message(existing.message_id),
          reservationFresh: false,
        };
      const value = this.validateInput(input, true);
      requireValue(
        this.owner.available(value.mailboxId, now),
        "Лимит или интервал отправки ящика исчерпан",
      );
      if (input.draftId)
        requireValue(
          this.db
            .prepare(
              "SELECT id FROM full_inbox_drafts WHERE id=? AND mailbox_id=?",
            )
            .get(input.draftId, value.mailboxId),
          "Черновик не найден",
        );
      const mailbox = this.owner.mailbox(value.mailboxId);
      const parent = value.replyToId ? this.get(value.replyToId) : null;
      const messageId =
        parent?.messageId && !/[\r\n\0]/.test(parent.messageId)
          ? parent.messageId
          : null;
      const references = (parent?.references || [])
        .filter((v) => typeof v === "string" && !/[\r\n\0]/.test(v))
        .slice(-50);
      if (messageId) references.push(messageId);
      const content = {
        body: value.body,
        format: value.format,
        signature:
          mailbox.signatureEnabled !== false
            ? render(mailbox.signature || "", {}, mailbox)
            : "",
        signature_format: mailbox.signatureFormat || "plain",
      };
      this.owner.rendered(content);
      const row = this.owner.insertMessage(
        {
          ...content,
          mailbox_id: mailbox.id,
          kind: "mail",
          recipient: [...value.to, ...value.cc, ...value.bcc].join(", "),
          subject: value.subject,
          parent: messageId,
        },
        now,
      );
      this.db
        .prepare(
          "INSERT INTO full_inbox_outgoing(message_id,request_id,metadata,attachment_count) VALUES(?,?,?,?)",
        )
        .run(
          row.id,
          requestId,
          json({ ...value, inReplyTo: messageId, references }),
          value.attachments.length,
        );
      if (input.draftId) this.deleteDraft(input.draftId);
      return { ...row, reservationFresh: true };
    });
  }
  outgoing(messageId) {
    const row = this.db
      .prepare("SELECT * FROM full_inbox_outgoing WHERE message_id=?")
      .get(messageId);
    if (!row) return null;
    const value = parse(row.metadata);
    return {
      ...value,
      attachments: value.attachments.map((v) => ({
        ...v,
        data: Buffer.from(v.data, "base64"),
      })),
      sentCopyError: row.sent_copy_error || null,
      sentCopyRecorded: !!row.sent_copy_recorded,
    };
  }
  recordSentCopy(messageId, error) {
    this.db
      .prepare(
        "UPDATE full_inbox_outgoing SET sent_copy_error=?,sent_copy_recorded=1 WHERE message_id=? AND sent_copy_recorded=0",
      )
      .run(
        error ? String(error.message || error).slice(0, 2000) : "",
        messageId,
      );
  }
  recordDeliveryWarning(messageId, warning) {
    this.db
      .prepare(
        "UPDATE full_inbox_outgoing SET metadata=json_set(metadata,'$.deliveryWarning',?) WHERE message_id=?",
      )
      .run(String(warning || "").slice(0, 2000), messageId);
  }
}
