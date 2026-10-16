import nodemailer from "nodemailer";
import { requireValue } from "./core.mjs";
const text = (value) =>
  String(value || "")
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, " ")
    .slice(0, 2000);
export class CampaignDelivery {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS campaign_delivery(
      message_id TEXT PRIMARY KEY REFERENCES messages(id),mime BLOB NOT NULL,
      smtp_response TEXT NOT NULL DEFAULT '',smtp_message_id TEXT NOT NULL DEFAULT '',
      accepted TEXT NOT NULL DEFAULT '[]',rejected TEXT NOT NULL DEFAULT '[]',accepted_at INTEGER,
      smtp_error TEXT NOT NULL DEFAULT '',copy_status TEXT NOT NULL DEFAULT 'pending',
      copy_error TEXT NOT NULL DEFAULT '',copy_folder TEXT NOT NULL DEFAULT '',copied_at INTEGER,
      legacy INTEGER NOT NULL DEFAULT 0,copy_attempted_at INTEGER NOT NULL DEFAULT 0
    )`);
  }
  get(id, raw = false) {
    const r = this.db
      .prepare("SELECT * FROM campaign_delivery WHERE message_id=?")
      .get(id);
    if (!r) return null;
    return {
      smtpResponse: r.smtp_response,
      smtpMessageId: r.smtp_message_id,
      accepted: JSON.parse(r.accepted),
      rejected: JSON.parse(r.rejected),
      acceptedAt: r.accepted_at,
      smtpError: r.smtp_error,
      copyStatus: r.copy_status,
      copyError: r.copy_error,
      copyFolder: r.copy_folder,
      copiedAt: r.copied_at,
      legacy: Boolean(r.legacy),
      ...(raw ? { mime: Buffer.from(r.mime) } : {}),
    };
  }
  prepare(message, mime, legacy = false) {
    requireValue(
      message.kind === "campaign" &&
        Buffer.isBuffer(mime) &&
        mime.length <= 25000000,
      "Некорректная копия письма кампании",
    );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO campaign_delivery(message_id,mime,legacy) VALUES(?,?,?)",
      )
      .run(message.id, mime, legacy ? 1 : 0);
    return this.get(message.id, true);
  }
  accept(id, result, now = Date.now()) {
    this.db
      .prepare(
        "UPDATE campaign_delivery SET smtp_response=?,smtp_message_id=?,accepted=?,rejected=?,accepted_at=?,smtp_error='' WHERE message_id=? AND accepted_at IS NULL",
      )
      .run(
        text(result.response),
        text(result.messageId),
        JSON.stringify(result.accepted || []),
        JSON.stringify(result.rejected || []),
        now,
        id,
      );
  }
  failure(id, error) {
    this.db
      .prepare(
        "UPDATE campaign_delivery SET smtp_response=?,smtp_error=? WHERE message_id=? AND accepted_at IS NULL",
      )
      .run(text(error.response), text(error.code || error.message), id);
  }
  copied(id, folder, error = "") {
    this.db
      .prepare(
        "UPDATE campaign_delivery SET copy_status=?,copy_error=?,copy_folder=?,copied_at=? WHERE message_id=?",
      )
      .run(
        error ? "error" : "copied",
        text(error),
        folder,
        error ? null : Date.now(),
        id,
      );
  }
  attemptCopy(id) {
    this.db
      .prepare(
        "UPDATE campaign_delivery SET copy_attempted_at=? WHERE message_id=?",
      )
      .run(Date.now(), id);
  }
  pendingCopies(healthy, now = Date.now()) {
    const ids = [...healthy];
    if (!ids.length) return [];
    return this.db
      .prepare(
        `SELECT m.id,m.mailbox_id FROM campaign_delivery d JOIN messages m ON m.id=d.message_id WHERE m.status='sent' AND d.accepted_at IS NOT NULL AND d.copy_status!='copied' AND d.copy_attempted_at<=? AND m.mailbox_id IN (${ids.map(() => "?").join(",")}) ORDER BY d.copy_attempted_at LIMIT 10`,
      )
      .all(now - 300000, ...ids);
  }
}
async function compile(options, message) {
  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });
  try {
    return (
      await composer.sendMail({
        ...options,
        date: new Date(message.sent || message.created || Date.now()),
      })
    ).message;
  } finally {
    composer.close();
  }
}
export async function copyCampaignSent(gateway, mailbox, message, options) {
  const delivery = gateway.store.campaignDelivery;
  const existing = delivery.get(message.id, true);
  const receipt =
    existing ||
    delivery.prepare(message, await compile(options, message), true);
  requireValue(
    receipt.acceptedAt || message.status === "sent",
    "Нет подтверждения отправки; копирование запрещено",
  );
  if (receipt.copyStatus === "copied") return delivery.get(message.id);
  delivery.attemptCopy(message.id);
  let c,
    folder = "",
    warning = "";
  try {
    c = gateway.imap(mailbox);
    await c.connect();
    const folders = await c.list();
    const sent =
      folders.find((f) => f.specialUse === "\\Sent") ||
      folders.find((f) =>
        /^(sent|sent items|sent mail|отправленные)$/i.test(
          f.path || f.name || "",
        ),
      );
    if (!sent) throw Error("Не найдена папка «Отправленные»");
    folder = sent.path || sent.name;
    const lock = await c.getMailboxLock(folder, { readOnly: true });
    let found = false;
    try {
      // Some providers reject HEADER Message-ID searches. Search by date then
      // compare actual envelope IDs; a failed search never permits blind APPEND.
      const ids = await c.search(
        {
          since: new Date(
            (message.sent || receipt.acceptedAt || message.created) - 86400000,
          ),
        },
        { uid: true },
      );
      if (!Array.isArray(ids))
        throw Error("Не удалось проверить существующую копию письма");
      for (let offset = 0; offset < ids.length && !found; offset += 200) {
        for await (const row of c.fetch(
          ids.slice(offset, offset + 200).join(","),
          { envelope: true },
          { uid: true },
        )) {
          if (row.envelope?.messageId === message.message_id) found = true;
        }
      }
    } finally {
      lock.release();
    }
    if (!found) {
      const appended = await c.append(
        folder,
        receipt.mime,
        ["\\Seen"],
        new Date(message.sent || receipt.acceptedAt || message.created),
      );
      if (!appended) throw Error("Не удалось сохранить копию в «Отправленные»");
    }
  } catch (error) {
    warning = text(error.message);
  } finally {
    try {
      c?.close();
    } catch (error) {
      warning ||= text(error.message);
    }
  }
  delivery.copied(message.id, folder, warning);
  return delivery.get(message.id);
}
export async function sendCampaign(gateway, mailbox, message, options) {
  const delivery = gateway.store.campaignDelivery;
  let receipt = delivery.get(message.id, true);
  if (!receipt?.acceptedAt) {
    requireValue(
      gateway.store.message(message.id)?.status === "sending",
      "Повторная SMTP-отправка обработанного письма запрещена",
    );
    receipt ||= delivery.prepare(message, await compile(options, message));
    const transport = gateway.transport(mailbox);
    try {
      const result = await transport.sendMail({
        raw: receipt.mime,
        envelope: { from: mailbox.email, to: [message.recipient] },
      });
      if (
        !result.accepted?.some(
          (address) =>
            String(address).toLowerCase() === message.recipient.toLowerCase(),
        )
      )
        throw Object.assign(Error("SMTP не принял получателя"), {
          definitive: true,
          response: result.response,
        });
      delivery.accept(message.id, result);
    } catch (error) {
      delivery.failure(message.id, error);
      if (
        ["EAUTH", "EENVELOPE"].includes(error.code) ||
        Number(error.responseCode) >= 400
      )
        error.definitive = true;
      throw error;
    } finally {
      transport.close();
    }
  }
  await copyCampaignSent(gateway, mailbox, message, options);
  return delivery.get(message.id);
}
