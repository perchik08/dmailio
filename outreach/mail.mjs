import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { escapeHTML } from "./core.mjs";
import { renderContent } from "./content.mjs";

export function classify(parsed) {
  const ct = String(
    parsed.headers.get("content-type")?.value ||
      parsed.headers.get("content-type") ||
      "",
  );
  if (
    ct.includes("multipart/report") &&
    (ct.includes("delivery-status") ||
      parsed.headers.get("content-type")?.params?.["report-type"] ===
        "delivery-status" ||
      parsed.attachments?.some(
        (a) => a.contentType === "message/delivery-status",
      ))
  )
    return "bounce";
  const auto = String(parsed.headers.get("auto-submitted") || "").toLowerCase();
  if (
    (auto && auto !== "no") ||
    parsed.headers.has("x-autoreply") ||
    parsed.headers.has("x-autorespond")
  )
    return "auto";
  return "reply";
}
export class MailGateway {
  constructor(store, publicURL) {
    this.store = store;
    this.publicURL = publicURL.replace(/\/$/, "");
  }
  transport(m) {
    return nodemailer.createTransport({
      ...m.smtp,
      auth: { user: m.smtp.user, pass: m.smtp.password },
      requireTLS: !m.smtp.secure,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      logger: false,
      debug: false,
    });
  }
  imap(m) {
    const c = new ImapFlow({
      ...m.imap,
      auth: { user: m.imap.user, pass: m.imap.password },
      doSTARTTLS: m.imap.secure ? undefined : true,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      disableAutoIdle: true,
    });
    c.on("error", () => {});
    return c;
  }
  async verify(m) {
    const smtp = this.transport(m);
    try {
      await smtp.verify();
    } finally {
      smtp.close();
    }
    const imap = this.imap(m);
    try {
      await imap.connect();
      await imap.mailboxOpen("INBOX");
      return {
        validity: String(imap.mailbox.uidValidity),
        uid: imap.mailbox.uidNext - 1,
        caughtUp: true,
      };
    } finally {
      imap.close();
    }
  }
  async send(m, message) {
    const unsubscribe = `${this.publicURL}/unsubscribe/${message.token}`;
    const formatted = renderContent(
      message,
      (id) => this.store.image(id),
      true,
    );
    const text =
      formatted.text +
      (message.kind === "campaign" ? `\n\nОтписаться: ${unsubscribe}` : "");
    let html =
      formatted.html +
      (message.kind === "campaign"
        ? `<p><a href="${escapeHTML(unsubscribe)}">Отписаться</a></p>`
        : "");
    if (
      message.kind === "campaign" &&
      this.store.campaign(message.campaign_id).trackOpens
    )
      html += `<img src="${this.publicURL}/open/${message.token}.gif" width="1" height="1" alt="">`;
    const transport = this.transport(m);
    try {
      const result = await transport.sendMail({
        from: {
          name: [m.name, m.surname].filter(Boolean).join(" "),
          address: m.email,
        },
        to: message.recipient,
        subject: message.subject,
        text,
        html,
        attachments: formatted.attachments,
        messageId: message.message_id,
        inReplyTo: message.parent || undefined,
        references: message.parent ? [message.parent] : undefined,
        disableFileAccess: true,
        disableUrlAccess: true,
        headers:
          message.kind === "campaign"
            ? {
                "List-Unsubscribe": `<${unsubscribe}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : {},
      });
      if (!result.accepted?.length) {
        const e = new Error("Rejected");
        e.definitive = true;
        throw e;
      }
    } catch (e) {
      if (
        ["EAUTH", "EENVELOPE"].includes(e.code) ||
        Number(e.responseCode) >= 400
      )
        e.definitive = true;
      throw e;
    } finally {
      transport.close();
    }
  }
  async sync(m, onMessage) {
    const c = this.imap(m);
    try {
      await c.connect();
      const lock = await c.getMailboxLock("INBOX");
      try {
        const validity = String(c.mailbox.uidValidity);
        const max = c.mailbox.uidNext - 1;
        if (!m.cursor?.validity) return { validity, uid: max, caughtUp: true };
        const cursor = {
          validity,
          uid: m.cursor.validity === validity ? m.cursor.uid : 0,
          caughtUp: true,
        };
        if (cursor.uid >= max) return cursor;
        let count = 0;
        for await (const msg of c.fetch(
          `${cursor.uid + 1}:${max}`,
          { source: { maxLength: 5_000_000 }, size: true },
          { uid: true },
        )) {
          // Parse the bounded MIME prefix even for large attachments: headers remain
          // available for reply correlation, and unrelated large mail cannot stall sync.
          const p = await simpleParser(msg.source, {
            skipHtmlToText: false,
            skipTextToHtml: true,
            skipImageLinks: true,
          });
          const refs = [
            p.inReplyTo,
            ...(Array.isArray(p.references)
              ? [...p.references].reverse()
              : p.references
                ? [p.references]
                : []),
          ].filter(Boolean);
          const type = classify(p);
          if (type === "bounce")
            for (const a of p.attachments || []) {
              if (
                ["message/rfc822", "text/rfc822-headers"].includes(
                  a.contentType,
                )
              ) {
                const match = a.content
                  .toString()
                  .match(/^Message-ID:\s*(<[^>]+>)/im);
                if (match) refs.unshift(match[1]);
              }
            }
          await onMessage({
            remoteId: `${validity}:${msg.uid}`,
            messageId: p.messageId,
            references: refs,
            from: p.from?.value?.[0]?.address || "",
            subject: p.subject || "",
            text:
              (p.text || "") +
              (msg.size > 5_000_000
                ? "\n\n[Крупное письмо обработано частично. Полная версия доступна в почтовом ящике.]"
                : ""),
            type,
          });
          cursor.uid = msg.uid;
          count++;
          if (count >= 200) {
            cursor.caughtUp = cursor.uid >= max;
            break;
          }
        }
        return cursor;
      } finally {
        lock.release();
      }
    } finally {
      c.close();
    }
  }

  async inspectWarmupPlacement(
    m,
    knownMessageIds,
    onPlacement,
    cursorFor = async () => null,
    onCursor = async () => {},
  ) {
    if (!knownMessageIds?.size) return;
    const host = String(m.imap?.host || "").toLowerCase();
    const provider =
      host.includes("gmail") || host.includes("google")
        ? "google"
        : host.includes("yandex")
          ? "yandex"
          : host.includes("mail.ru") || host.includes("vk")
            ? "mailru"
            : "other";
    const c = this.imap(m);
    try {
      await c.connect();
      const folders = (await c.list()).filter((folder) => {
        const name = String(folder.path || folder.name || "").toLowerCase();
        return (
          folder.specialUse === "\\Inbox" ||
          folder.specialUse === "\\Junk" ||
          name.includes("promotion") ||
          name.includes("промоакц")
        );
      });
      for (const folder of folders) {
        const path = folder.path || folder.name;
        const lock = await c.getMailboxLock(path);
        try {
          const validity = String(c.mailbox.uidValidity);
          const max = Math.max(0, Number(c.mailbox.uidNext || 1) - 1);
          const previous = await cursorFor(path);
          const start =
            previous?.validity === validity
              ? Number(previous.uid || 0) + 1
              : Math.max(1, max - 199);
          let scannedTo = Math.min(max, start - 1);
          const observations = [];
          if (start <= max) {
            for await (const msg of c.fetch(
              `${start}:${max}`,
              { envelope: true, labels: true },
              { uid: true },
            )) {
              scannedTo = Math.max(scannedTo, Number(msg.uid || 0));
              const messageId = msg.envelope?.messageId;
              if (!messageId || !knownMessageIds.has(messageId)) continue;
              const folderName = String(path).toLowerCase();
              const labels = Array.from(msg.labels || [], (label) =>
                String(label).toLowerCase(),
              );
              const isSpam = folder.specialUse === "\\Junk";
              const isPromotion =
                folderName.includes("promotion") ||
                folderName.includes("промоакц") ||
                labels.some(
                  (label) =>
                    label.includes("category promotions") ||
                    label.includes("promotions") ||
                    label.includes("промоакц"),
                );
              const placement = isSpam
                ? "spam"
                : isPromotion
                  ? "promotions"
                  : "inbox";
              observations.push({
                uid: msg.uid,
                messageId,
                provider,
                placement,
                folder: path,
                isSpam,
              });
            }
          }
          for (const observation of observations) {
            let rescuedAt = 0;
            if (observation.isSpam) {
              try {
                await c.messageMove(observation.uid, "INBOX", { uid: true });
                rescuedAt = Date.now();
              } catch {
                // Record the spam placement even when the provider forbids moving it.
              }
            }
            const { uid, isSpam, ...event } = observation;
            await onPlacement({
              ...event,
              observedAt: Date.now(),
              rescuedAt,
            });
          }
          await onCursor(path, { validity, uid: Math.max(scannedTo, max) });
        } finally {
          lock.release();
        }
      }
    } finally {
      c.close();
    }
  }
}
