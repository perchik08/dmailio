import { randomUUID } from "node:crypto";

export class Worker {
  constructor(store, gateway) {
    this.store = store;
    this.gateway = gateway;
    this.running = false;
    this.owner = randomUUID();
    this.lastError = "";
  }
  lease(now = Date.now()) {
    this.store.db
      .prepare(
        `INSERT INTO runtime_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE runtime_lock.expires<? OR runtime_lock.owner=?`,
      )
      .run(this.owner, now + 300000, now, this.owner);
    return (
      this.store.db.prepare("SELECT owner FROM runtime_lock WHERE id=1").get()
        .owner === this.owner
    );
  }
  async deliver(message) {
    try {
      await this.gateway.send(
        this.store.mailbox(message.mailbox_id, true),
        message,
      );
      this.store.finish(message.id, "sent");
    } catch (e) {
      this.store.finish(
        message.id,
        e.definitive ? "failed" : "unknown",
        Date.now(),
        e.definitive
          ? "SMTP отклонил письмо. Проверьте подключение или адрес."
          : "Результат отправки неизвестен. Проверьте папку отправленных; автоматического повтора не будет.",
      );
    }
    return this.store.message(message.id);
  }
  async tick(now = Date.now()) {
    if (this.running || !this.lease()) return;
    this.running = true;
    try {
      this.store.recover(now);
      const healthy = new Set();
      for (const m of this.store
        .mailboxes()
        .filter((m) => m.enabled && m.verified)) {
        if (!this.lease()) return;
        try {
          const cursor = await this.gateway.sync(
            this.store.mailbox(m.id, true),
            (incoming) => this.store.ingest(m.id, incoming),
          );
          this.store.synced(m.id, cursor);
          try {
            const known = this.store.pendingPlacementMessageIds(m.id);
            if (known.size && this.gateway.inspectWarmupPlacement)
              await this.gateway.inspectWarmupPlacement(
                this.store.mailbox(m.id, true),
                known,
                (event) => this.store.recordPlacement(m.id, event),
                (folder) => this.store.placementCursor(m.id, folder),
                (folder, next) =>
                  this.store.savePlacementCursor(m.id, folder, next),
              );
          } catch {
            // Placement diagnostics must never block inbox sync or delivery.
          }
          if (cursor.caughtUp !== false) healthy.add(m.id);
        } catch {
          this.store.syncError(m.id);
        }
      }
      for (let i = 0; i < 25; i++) {
        if (!this.lease()) return;
        const message =
          this.store.reserve(now, healthy) ||
          this.store.reserveWarmup(now, healthy);
        if (!message) break;
        // Recheck immediately before SMTP: reply/opt-out/pause may have arrived after reservation.
        if (message.kind === "campaign") {
          const c = this.store.campaign(message.campaign_id);
          const l = c.leads.find((x) => x.id === message.lead_id);
          if (c.status !== "active" || l.status !== "sending") {
            this.store.cancelReservation(message.id);
            continue;
          }
        }
        await this.deliver(message);
      }
      this.lastError = "";
    } catch {
      this.lastError = "Ошибка обработки очереди";
    } finally {
      this.running = false;
      this.store.db
        .prepare("DELETE FROM runtime_lock WHERE id=1 AND owner=?")
        .run(this.owner);
    }
  }
}
