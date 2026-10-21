import nodemailer from "nodemailer";
import { sendCampaign, copyCampaignSent } from "./campaign-delivery.mjs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { renderContent } from "./content.mjs";
import {
  initializeFullInbox,
  syncFullInbox,
  updateFullMessage,
  sendFullMessage,
} from "./full-inbox-sync.mjs";

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
    this.connectionClients = new Map();
    for (const name of [
      "verify",
      "send",
      "sendMarketing",
      "restoreCampaignCopy",
      "sync",
      "inspectWarmupPlacement",
      "updateFullMessage",
    ]) {
      const original = this[name].bind(this);
      this[name] = async (m, ...args) => {
        if (!m.id || !this.store.beginMailboxIO) return original(m, ...args);
        const token = this.store.beginMailboxIO(m);
        let lost = false;
        const heartbeat = setInterval(() => {
          try {
            if (!this.store.touchMailboxIO(token)) {
              lost = true;
              this.closeMailboxClients(m.id);
            }
          } catch {
            lost = true;
            this.closeMailboxClients(m.id);
          }
        }, 15000);
        heartbeat.unref();
        try {
          const result = await original(m, ...args);
          try {
            this.store.assertMailboxConnection(m);
            if (lost) throw new Error("Connection lease lost");
          } catch (error) {
            error.definitive = false;
            throw error;
          }
          return result;
        } finally {
          clearInterval(heartbeat);
          this.store.endMailboxIO(token);
        }
      };
    }
  }
  trackClient(m, client) {
    if (!m.id) return client;
    const clients = this.connectionClients.get(m.id) || new Set();
    clients.add(client);
    this.connectionClients.set(m.id, clients);
    const close = client.close.bind(client);
    client.close = (...args) => {
      clients.delete(client);
      if (!clients.size) this.connectionClients.delete(m.id);
      return close(...args);
    };
    return client;
  }
  closeMailboxClients(id) {
    for (const client of [...(this.connectionClients.get(id) || [])])
      try {
        client.close();
      } catch {}
  }
  transport(m) {
    return this.trackClient(
      m,
      nodemailer.createTransport({
        ...m.smtp,
        auth: { user: m.smtp.user, pass: m.smtp.password },
        requireTLS: !m.smtp.secure,
        tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
        logger: false,
        debug: false,
      }),
    );
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
    return this.trackClient(m, c);
  }
  async verify(m) {
    const smtp = this.transport(m);
    try {
      await smtp.verify();
    } catch (error) {
      error.protocol = "SMTP";
      throw error;
    } finally {
      smtp.close();
    }
    const imap = this.imap(m);
    try {
      await imap.connect();
      if (m.id) return await initializeFullInbox(imap);
      await imap.mailboxOpen("INBOX");
      return {
        validity: String(imap.mailbox.uidValidity),
        uid: imap.mailbox.uidNext - 1,
        caughtUp: true,
      };
    } catch (error) {
      error.protocol = "IMAP";
      throw error;
    } finally {
      imap.close();
    }
  }
  async updateFullMessage(m, locations, action) {
    return updateFullMessage(this, m, locations, action);
  }
  mailOptions(m, message) {
    const unsubscribe = `${this.publicURL}/unsubscribe/${message.token}`;
    const formatted = renderContent(
      message,
      (id) => this.store.image(id),
      true,
      message.kind === "campaign" &&
        this.store.campaign(message.campaign_id).trackClicks
        ? (url) => this.store.trackedLink(message, url, this.publicURL)
        : undefined,
    );
    const text = formatted.text;
    let html = formatted.html;
    if (
      message.kind === "campaign" &&
      this.store.campaign(message.campaign_id).trackOpens
    )
      html += `<img src="${this.publicURL}/open/${message.token}.gif" width="1" height="1" alt="">`;
    return {
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
    };
  }
  async restoreCampaignCopy(m, message) {
    const stored = this.store.message(message.id);
    if (stored?.kind !== "campaign" || stored.status !== "sent")
      throw Error("Копирование доступно только отправленному письму кампании");
    return copyCampaignSent(this, m, stored, this.mailOptions(m, stored));
  }
  async send(m, message) {
    if (message.kind === "mail") return sendFullMessage(this, m, message);
    const options = this.mailOptions(m, message);
    if (message.kind === "campaign" && this.store.campaignDelivery)
      return sendCampaign(this, m, message, options);
    const transport = this.transport(m);
    try {
      const result = await transport.sendMail(options);
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
  async sendMarketing(m, message) {
    const transport = this.transport(m);
    try {
      const headers = {};
      if (message.unsubscribeUrl) {
        const url = new URL(message.unsubscribeUrl);
        if (url.protocol !== "https:" || url.username || url.password)
          throw Object.assign(new Error("Invalid unsubscribe URL"), {
            definitive: true,
          });
        headers["List-Unsubscribe"] = `<${url.href}>`;
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }
      const result = await transport.sendMail({
        from: { name: message.fromName, address: m.email },
        to: message.recipient,
        replyTo: message.replyTo || m.email,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: message.messageId,
        headers,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (
        !result.accepted?.some(
          (address) =>
            String(address).toLowerCase() === message.recipient.toLowerCase(),
        )
      )
        throw Object.assign(new Error("SMTP rejected recipient"), {
          definitive: true,
        });
      return {
        messageId: result.messageId || message.messageId,
        accepted: result.accepted,
      };
    } catch (error) {
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
  async sync(m, onMessage) {
    if (m.id) return syncFullInbox(this, m, onMessage);
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
