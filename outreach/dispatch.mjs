import { createHash } from "node:crypto";
import { MarketingError } from "./marketing/contracts.mjs";
export const providerCeiling = (mailbox) =>
  /^(smtp\.gmail\.com)$/i.test(mailbox.smtp.host)
    ? 500
    : /^smtp\.yandex\.(ru|com)$/i.test(mailbox.smtp.host)
      ? 300
      : 10000;
export class Dispatch {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS mailbox_dispatch_policy(mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id),settings TEXT NOT NULL DEFAULT '{}',paused_until INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '',checked_at INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS marketing_sender_default(id INTEGER PRIMARY KEY CHECK(id=1),mailbox_id TEXT REFERENCES mailboxes(id));CREATE TABLE IF NOT EXISTS marketing_outgoing(request_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),payload TEXT NOT NULL,provider_message_id TEXT);`,
    );
    this.store.transaction(() => {
      if (
        !this.db
          .prepare("PRAGMA table_info(messages)")
          .all()
          .some((c) => c.name === "quota_units")
      ) {
        this.db.exec(
          "ALTER TABLE messages ADD COLUMN quota_units INTEGER NOT NULL DEFAULT 1",
        );
        this.db.exec(
          `UPDATE messages SET quota_units=coalesce((SELECT max(1,json_array_length(metadata,'$.to')+json_array_length(metadata,'$.cc')+json_array_length(metadata,'$.bcc')) FROM full_inbox_outgoing WHERE full_inbox_outgoing.message_id=messages.id),1)`,
        );
      }
    });
  }
  policy(id) {
    const m = this.store.mailbox(id);
    const row = this.db
      .prepare("SELECT * FROM mailbox_dispatch_policy WHERE mailbox_id=?")
      .get(id);
    return {
      enabled: false,
      fromName: [m.name, m.surname].filter(Boolean).join(" "),
      replyTo: m.email,
      providerDailyLimit: Math.min(m.limit, providerCeiling(m)),
      externalReserve: 0,
      intervalSeconds: 60,
      ...(row ? JSON.parse(row.settings) : {}),
      pausedUntil: row?.paused_until || 0,
      blocked: Boolean(row?.blocked),
      reason: row?.reason || "",
      checkedAt: row?.checked_at || null,
    };
  }
  save(id, value) {
    const row = this.db
      .prepare(
        "SELECT settings FROM mailbox_dispatch_policy WHERE mailbox_id=?",
      )
      .get(id);
    const { pausedUntil, blocked, reason, checkedAt, ...settings } = {
      ...(row ? JSON.parse(row.settings) : {}),
      ...value,
    };
    this.db
      .prepare(
        `INSERT INTO mailbox_dispatch_policy(mailbox_id,settings) VALUES(?,?) ON CONFLICT(mailbox_id) DO UPDATE SET settings=excluded.settings`,
      )
      .run(id, JSON.stringify(settings));
    return this.policy(id);
  }
  checked(id, now = Date.now()) {
    this.save(id, {});
    this.db
      .prepare(
        "UPDATE mailbox_dispatch_policy SET checked_at=?,paused_until=0,blocked=0,reason='' WHERE mailbox_id=?",
      )
      .run(now, id);
  }
  fail(id, error, now = Date.now()) {
    const code = String(error.code || ""),
      response = Number(error.responseCode);
    let reason = "",
      blocked = 0,
      pause = 0;
    if (code === "EAUTH") {
      reason = "AUTH_REQUIRED";
      blocked = 1;
    } else if (
      /(?:5\.7\.|spam|policy|blocked)/i.test(
        String(error.response || "").slice(0, 1000),
      )
    ) {
      reason = "POLICY_BLOCK";
      blocked = 1;
    } else if ([421, 450, 451, 452].includes(response)) {
      reason = "RATE_LIMIT";
      pause = now + 15 * 60000;
    }
    if (!reason) return;
    this.save(id, {});
    this.db
      .prepare(
        "UPDATE mailbox_dispatch_policy SET reason=?,blocked=?,paused_until=? WHERE mailbox_id=?",
      )
      .run(reason, blocked, pause, id);
  }
  budget(id, now = Date.now(), interval = 1, units = 1) {
    const m = this.store.mailbox(id),
      p = this.policy(id);
    const rows = this.db
      .prepare(
        "SELECT created,quota_units FROM messages WHERE mailbox_id=? AND direction='out' AND status IN ('sending','sent','unknown') AND created>? ORDER BY created",
      )
      .all(id, now - 86400000);
    const used = rows.reduce((n, row) => n + row.quota_units, 0),
      limit = Math.max(
        0,
        Math.min(m.limit, p.providerDailyLimit, providerCeiling(m)) -
          p.externalReserve,
      ),
      remaining = Math.max(0, limit - used);
    let reason = !m.enabled
      ? "DISABLED"
      : !m.verified
        ? "UNVERIFIED"
        : m.error
          ? "CONNECTION_ERROR"
          : p.blocked
            ? p.reason
            : p.pausedUntil > now
              ? p.reason
              : remaining < units
                ? "QUOTA"
                : rows.length &&
                    now - rows.at(-1).created <
                      Math.max(interval * 60, p.intervalSeconds) * 1000
                  ? "INTERVAL"
                  : "";
    let nextAvailableAt = now;
    if (reason === "INTERVAL")
      nextAvailableAt =
        rows.at(-1).created + Math.max(interval * 60, p.intervalSeconds) * 1000;
    if (reason === "RATE_LIMIT") nextAvailableAt = p.pausedUntil;
    if (reason === "QUOTA") {
      let release = 0;
      nextAvailableAt = null;
      for (const row of rows) {
        release += row.quota_units;
        if (limit - used + release >= units) {
          nextAvailableAt = row.created + 86400001;
          break;
        }
      }
    }
    if (
      [
        "DISABLED",
        "UNVERIFIED",
        "CONNECTION_ERROR",
        "AUTH_REQUIRED",
        "POLICY_BLOCK",
      ].includes(reason)
    )
      nextAvailableAt = null;
    return {
      limit,
      used,
      remaining,
      available: !reason,
      reason: reason || null,
      nextAvailableAt,
      intervalSeconds: p.intervalSeconds,
      externalReserve: p.externalReserve,
      scope: "dmailio_rolling_24h",
    };
  }
  outgoing(key) {
    const row = this.db
      .prepare("SELECT * FROM marketing_outgoing WHERE request_key=?")
      .get(key);
    return row ? { ...row, message: this.store.message(row.message_id) } : null;
  }
  reserve(payload, key, now) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    return this.store.transaction(() => {
      const old = this.outgoing(key);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new MarketingError(
            "IDEMPOTENCY_CONFLICT",
            "Этот ключ уже использован для другого письма",
            409,
          );
        return { ...old, fresh: false };
      }
      const budget = this.budget(payload.mailboxId, now);
      if (!budget.available) return { deferred: true, budget };
      const message = this.store.insertMessage(
        {
          mailbox_id: payload.mailboxId,
          kind: payload.test ? "marketing_test" : "marketing",
          recipient: payload.recipient,
          subject: payload.subject,
          body: payload.text,
        },
        now,
      );
      this.db
        .prepare(
          "INSERT INTO marketing_outgoing(request_key,fingerprint,message_id,payload) VALUES(?,?,?,?)",
        )
        .run(key, fingerprint, message.id, JSON.stringify(payload));
      return { ...this.outgoing(key), fresh: true };
    });
  }
}
