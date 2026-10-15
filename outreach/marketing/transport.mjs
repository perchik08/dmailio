import { email } from "../core.mjs";
import { invalid, MarketingError } from "./contracts.mjs";
export const smtpCapabilities = Object.freeze({
  id: "connected-smtp",
  smtpAccepted: true,
  deliveryConfirmed: false,
  complaints: false,
  bounceEvents: "requires_imap_correlation",
  attachments: {
    supported: false,
    reason: "Подготовка и проверка файлов — отдельный этап",
  },
  maxRecipientsPerMessage: 1,
  connectionCheckSendsMail: false,
});
export class MarketingTransport {
  constructor(store, gateway, senders) {
    Object.assign(this, { store, gateway, senders });
  }
  result(key) {
    const row = this.store.dispatch.outgoing(key);
    if (!row) return null;
    const m = row.message;
    return {
      status:
        m.status === "sent"
          ? "accepted"
          : m.status === "failed"
            ? "rejected"
            : "unknown",
      messageId: m.message_id,
      providerMessageId: row.provider_message_id || null,
      error: m.error || null,
    };
  }
  async submit(message, key, now = Date.now(), authorize) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9:_-]{1,200}$/.test(key))
      throw invalid("Укажите устойчивый ключ отправки");
    if (typeof message?.test !== "boolean")
      throw invalid("Укажите режим отправки");
    if (message.attachments?.length)
      throw invalid(
        "Вложения пока недоступны: требуется подготовка и проверка файлов",
      );
    let recipient;
    try {
      recipient = email(message.recipient);
    } catch {
      throw invalid("Укажите одного получателя");
    }
    if (
      typeof message.subject !== "string" ||
      !message.subject.trim() ||
      message.subject.length > 998 ||
      /[\r\n\0]/.test(message.subject)
    )
      throw invalid("Проверьте тему письма");
    if (
      typeof message.text !== "string" ||
      typeof message.html !== "string" ||
      message.text.length > 220000 ||
      message.html.length > 500000
    )
      throw invalid("Проверьте содержимое письма");
    if (!message.test) {
      if (
        typeof authorize !== "function" ||
        (await authorize(message)) !== true
      )
        throw invalid("Требуется проверка подписки получателя перед отправкой");
    }
    const sender = this.senders.get(message.mailboxId, now);
    const payload = {
      mailboxId: sender.id,
      recipient,
      subject: message.subject,
      text: message.text,
      html: message.html,
      test: message.test,
      fromName: message.fromName ?? sender.fromName,
      replyTo: message.replyTo ?? sender.replyTo,
      unsubscribeUrl: message.unsubscribeUrl || null,
    };
    if (
      payload.fromName !== sender.fromName ||
      payload.replyTo !== sender.replyTo ||
      (message.from && message.from !== sender.email)
    )
      throw invalid(
        "Отправитель должен соответствовать сохранённым настройкам почты",
      );
    const prior = this.store.dispatch.outgoing(key);
    if (!prior) this.senders.eligible(sender.id);
    const reserved = this.store.dispatch.reserve(payload, key, now);
    if (reserved.deferred)
      return {
        status: "deferred",
        reason: reserved.budget.reason,
        retryAt: reserved.budget.nextAvailableAt,
      };
    if (!reserved.fresh) return this.result(key);
    try {
      this.senders.eligible(sender.id);
      const result = await this.gateway.sendMarketing(
        this.store.mailbox(sender.id, true),
        { ...payload, messageId: reserved.message.message_id },
      );
      this.store.db
        .prepare(
          "UPDATE marketing_outgoing SET provider_message_id=? WHERE request_key=?",
        )
        .run(result.messageId || reserved.message.message_id, key);
      this.store.finish(reserved.message.id, "sent", now);
    } catch (error) {
      this.store.dispatch.fail(sender.id, error, now);
      this.store.finish(
        reserved.message.id,
        error.definitive ? "failed" : "unknown",
        now,
        error.definitive
          ? "SMTP отклонил письмо. Проверьте почту или адрес получателя."
          : "Результат SMTP неизвестен. Автоматического повтора не будет.",
      );
    }
    return this.result(key);
  }
  async test(id, recipient, key) {
    return this.submit(
      {
        mailboxId: id,
        recipient,
        subject: "Проверка отправителя Dmailio",
        text: "Это одно проверочное письмо Dmailio. Отвечать на него не нужно.",
        html: "<p>Это одно проверочное письмо Dmailio. Отвечать на него не нужно.</p>",
        test: true,
      },
      key,
    );
  }
}
