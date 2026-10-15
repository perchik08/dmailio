import { randomUUID } from "node:crypto";
const disconnected = () =>
  Object.assign(
    new Error(
      "Почта отключена или подключение изменилось. Подключите её заново и выполните проверку.",
    ),
    { code: "MAILBOX_DETACHED", status: 409, definitive: true },
  );
export class MailboxConnections {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS mailbox_io(id TEXT PRIMARY KEY,mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),revision INTEGER NOT NULL,expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS mailbox_io_active ON mailbox_io(mailbox_id,expires);",
    );
  }
  assert(snapshot) {
    const current = this.store.mailbox(snapshot.id);
    if (
      current.detached ||
      !current.enabled ||
      (snapshot.connectionRevision ?? 0) !== current.connectionRevision
    )
      throw disconnected();
    return current;
  }
  begin(snapshot, now = Date.now()) {
    return this.store.transaction(() => {
      this.assert(snapshot);
      this.db.prepare("DELETE FROM mailbox_io WHERE expires<=?").run(now);
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO mailbox_io VALUES(?,?,?,?)")
        .run(id, snapshot.id, snapshot.connectionRevision ?? 0, now + 90000);
      return id;
    });
  }
  touch(id, now = Date.now()) {
    return (
      this.db
        .prepare("UPDATE mailbox_io SET expires=? WHERE id=? AND expires>?")
        .run(now + 90000, id, now).changes === 1
    );
  }
  end(id) {
    this.db.prepare("DELETE FROM mailbox_io WHERE id=?").run(id);
  }
  disconnect(id, now = Date.now()) {
    return this.store.transaction(() => {
      const m = this.store.mailbox(id);
      if (m.detached) return m;
      if (
        this.db
          .prepare("SELECT 1 FROM mailbox_io WHERE mailbox_id=? AND expires>?")
          .get(id, now)
      )
        throw Object.assign(
          new Error(
            "Сейчас ящик завершает операцию с провайдером. Дождитесь её завершения и повторите отвязку.",
          ),
          { code: "MAILBOX_BUSY", status: 409 },
        );
      const row = this.db
        .prepare("SELECT config FROM mailboxes WHERE id=?")
        .get(id);
      const cfg = JSON.parse(row.config);
      cfg.enabled = false;
      cfg.detachedAt = now;
      cfg.connectionRevision = (cfg.connectionRevision || 0) + 1;
      cfg.warmup = {
        ...m.warmup,
        enabled: false,
        consent: false,
        pausedAt: now,
      };
      this.db
        .prepare(
          "UPDATE mailboxes SET config=?,secrets='',verified=0,error='' WHERE id=?",
        )
        .run(JSON.stringify(cfg), id);
      this.store.dispatch.save(id, { enabled: false });
      this.db
        .prepare(
          "UPDATE marketing_sender_default SET mailbox_id=NULL WHERE mailbox_id=?",
        )
        .run(id);
      for (const campaign of this.db
        .prepare("SELECT id,config FROM campaigns WHERE status='active'")
        .all())
        if (JSON.parse(campaign.config).mailboxIds?.includes(id))
          this.db
            .prepare("UPDATE campaigns SET status='paused' WHERE id=?")
            .run(campaign.id);
      return this.store.mailbox(id);
    });
  }
}
