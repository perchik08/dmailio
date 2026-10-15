import { email } from "../core.mjs";
import { invalid, identifier, MarketingError } from "./contracts.mjs";
import { providerCeiling } from "../dispatch.mjs";
export class Senders {
  constructor(store, gateway) {
    Object.assign(this, { store, gateway });
  }
  get(id, now = Date.now()) {
    identifier(id);
    let m;
    try {
      m = this.store.mailbox(id);
    } catch {
      throw new MarketingError(
        "NOT_FOUND",
        "Подключённая почта не найдена",
        404,
      );
    }
    const p = this.store.dispatch.policy(id),
      budget = this.store.dispatch.budget(id, now);
    return {
      id: m.id,
      email: m.email,
      name: p.fromName,
      fromName: p.fromName,
      replyTo: p.replyTo,
      enabled: m.enabled,
      verified: m.verified,
      detached: m.detached,
      marketingEnabled: p.enabled,
      eligible: Boolean(
        m.enabled && m.verified && !m.error && p.enabled && !p.blocked,
      ),
      connectionError: m.error ? "Проверьте подключение SMTP/IMAP" : "",
      checkedAt: p.checkedAt,
      providerDailyLimit: p.providerDailyLimit,
      providerCeiling: providerCeiling(m),
      externalReserve: p.externalReserve,
      intervalSeconds: p.intervalSeconds,
      blocked: p.blocked,
      pauseReason: p.reason || null,
      pausedUntil: p.pausedUntil || null,
      budget,
    };
  }
  page(now = Date.now()) {
    return {
      items: this.store.mailboxes().map((m) => this.get(m.id, now)),
      defaultSenderId:
        this.store.db
          .prepare("SELECT mailbox_id FROM marketing_sender_default WHERE id=1")
          .get()?.mailbox_id || null,
    };
  }
  update(id, value) {
    identifier(id);
    if (this.get(id).detached)
      throw new MarketingError(
        "SENDER_UNAVAILABLE",
        "Почта отключена. Сначала подключите её заново в разделе «Почты».",
        409,
      );
    const allowed = [
      "enabled",
      "fromName",
      "replyTo",
      "providerDailyLimit",
      "externalReserve",
      "intervalSeconds",
    ];
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).some((k) => !allowed.includes(k))
    )
      throw invalid("Проверьте настройки отправителя");
    const p = { ...this.store.dispatch.policy(id), ...value };
    if (typeof p.enabled !== "boolean")
      throw invalid("Проверьте разрешение для рассылок");
    if (
      typeof p.fromName !== "string" ||
      p.fromName.length > 200 ||
      /[\r\n\0]/.test(p.fromName)
    )
      throw invalid("Проверьте имя отправителя");
    try {
      p.replyTo = email(p.replyTo || this.store.mailbox(id).email);
    } catch {
      throw invalid("Укажите один корректный Reply-To адрес");
    }
    if (
      !Number.isInteger(p.providerDailyLimit) ||
      p.providerDailyLimit < 1 ||
      p.providerDailyLimit > providerCeiling(this.store.mailbox(id))
    )
      throw invalid("Проверьте лимит провайдера");
    if (
      !Number.isInteger(p.externalReserve) ||
      p.externalReserve < 0 ||
      p.externalReserve >=
        Math.min(this.store.mailbox(id).limit, p.providerDailyLimit)
    )
      throw invalid("Резерв должен быть меньше общего лимита");
    if (
      !Number.isInteger(p.intervalSeconds) ||
      p.intervalSeconds < 60 ||
      p.intervalSeconds > 86400
    )
      throw invalid("Пауза между письмами: от 60 до 86400 секунд");
    this.store.dispatch.save(
      id,
      Object.fromEntries(allowed.map((k) => [k, p[k]])),
    );
    return this.get(id);
  }
  eligible(id) {
    const sender = this.get(id);
    if (!sender.eligible)
      throw new MarketingError(
        "SENDER_UNAVAILABLE",
        "Выберите включённую проверенную почту и разрешите её для рассылок",
        409,
      );
    return sender;
  }
  setDefault(id) {
    if (id !== null) this.eligible(id);
    this.store.db
      .prepare(
        "INSERT INTO marketing_sender_default(id,mailbox_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET mailbox_id=excluded.mailbox_id",
      )
      .run(id);
    return this.page();
  }
  async check(id) {
    identifier(id);
    this.store.assertMailboxConnection(this.store.mailbox(id));
    const m = this.store.mailbox(id, true);
    try {
      const cursor = await this.gateway.verify(m);
      this.store.markMailbox(id, true, "", m.connectionRevision);
      if (!m.cursor?.validity && !m.cursor?.since && cursor)
        this.store.synced(id, cursor, Date.now(), m.connectionRevision);
      return this.get(id);
    } catch {
      this.store.markMailbox(
        id,
        false,
        "Проверка SMTP/IMAP не пройдена",
        m.connectionRevision,
      );
      throw new MarketingError(
        "CONNECTION_FAILED",
        "Не удалось проверить SMTP/IMAP. Настройки доступны в разделе «Почты».",
        422,
      );
    }
  }
}
