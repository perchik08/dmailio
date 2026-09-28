import { requireValue } from "./core.mjs";

export const leadActions = {
  contacted: "Связались",
  replied: "Ответили",
  not_replied: "Не ответили",
  opened: "Открыли",
  clicked: "Кликнули",
  bounced: "Недоставлено",
  errors: "Ошибки",
  uncertain: "Результат отправки неизвестен",
  untouched: "Пока не связались",
  completed: "Завершён",
  stopped: "Отправка остановлена",
  unsubscribed: "Отписались",
  auto: "Автоответ",
};

export function queryLeads(db, campaignId, input = {}) {
  const campaign = db
    .prepare("SELECT * FROM campaigns WHERE id=?")
    .get(campaignId);
  requireValue(campaign, "Кампания не найдена");
  const config = JSON.parse(campaign.config);
  const search = String(input.search || "")
    .trim()
    .toLocaleLowerCase("ru")
    .slice(0, 200);
  const actions = input.actions || [];
  const fields = input.fields || [];
  const excluded = input.excluded || [];
  requireValue(
    Array.isArray(excluded) &&
      excluded.length <= 20 &&
      excluded.every((a) => Object.hasOwn(leadActions, a)),
    "Некорректные исключения",
  );
  requireValue(
    Array.isArray(actions) &&
      actions.length <= 20 &&
      actions.every((a) => Object.hasOwn(leadActions, a)),
    "Некорректные фильтры действий",
  );
  requireValue(
    Array.isArray(fields) &&
      fields.length <= 20 &&
      fields.every(
        (f) =>
          f &&
          typeof f.key === "string" &&
          f.key.length <= 200 &&
          ["eq", "contains", "empty", "not_empty"].includes(f.op) &&
          (f.value === undefined ||
            (typeof f.value === "string" && f.value.length <= 1000)),
      ),
    "Некорректные фильтры полей",
  );
  const size = Math.min(
    100,
    Math.max(1, Math.floor(Number(input.pageSize) || 50)),
  );
  // Aggregate once per lead, never count repeated events as additional contacts.
  const facts = new Map(
    db
      .prepare(
        `SELECT m.lead_id,
    max(m.kind='campaign' AND m.direction='out' AND m.status='sent') contacted,
    count(DISTINCT CASE WHEN m.kind='campaign' AND m.direction='out' AND m.status='sent' THEN m.step END) sent_steps,
    max(m.direction='in' AND m.kind='reply') replied,
    max(m.direction='in' AND m.kind='auto') auto,
    max(m.direction='in' AND m.kind='bounce') bounced,
    max(m.status='failed') errors, max(m.status='unknown') uncertain,
    max(e.kind='open') opened, max(e.kind='click') clicked
    FROM messages m LEFT JOIN events e ON e.message_id=m.id
    WHERE m.campaign_id=? AND m.kind!='warmup' AND m.lead_id IS NOT NULL GROUP BY m.lead_id`,
      )
      .all(campaignId)
      .map((r) => [r.lead_id, r]),
  );
  const errors = new Map(
    db
      .prepare(
        "SELECT lead_id,error FROM messages WHERE campaign_id=? AND kind!='warmup' AND error!='' AND status IN ('failed','unknown') ORDER BY created",
      )
      .all(campaignId)
      .map((r) => [r.lead_id, r.error]),
  );
  const keys = new Set(["email", "sender", "step"]);
  const rows = db
    .prepare(
      `SELECT l.*,b.email sender,b.error mailbox_error,s.reason suppression FROM leads l LEFT JOIN mailboxes b ON b.id=l.mailbox_id LEFT JOIN suppressions s ON s.email=l.email WHERE l.campaign_id=? ORDER BY l.rowid`,
    )
    .all(campaignId)
    .map((l) => {
      l.fields = JSON.parse(l.fields);
      Object.keys(l.fields).forEach((k) => keys.add(k));
      const f = facts.get(l.id) || {};
      const flags = {
        contacted: !!f.contacted,
        replied: !!f.replied,
        not_replied: !f.replied,
        opened: !!f.opened,
        clicked: !!f.clicked,
        auto: !!f.auto,
        bounced: !!f.bounced || l.status === "bounced",
        errors:
          !!f.errors ||
          !!l.mailbox_error ||
          ["failed", "invalid"].includes(l.status),
        uncertain: !!f.uncertain || l.status === "uncertain",
        untouched: !f.contacted,
        completed:
          config.steps.length > 0 && f.sent_steps >= config.steps.length,
        stopped:
          ["stopped", "replied", "bounced", "unsubscribed"].includes(
            l.status,
          ) ||
          !!l.suppression ||
          (campaign.status === "paused" &&
            ["pending", "sending"].includes(l.status)),
        unsubscribed:
          l.suppression === "unsubscribe" ||
          (l.status === "unsubscribed" && l.suppression !== "bounce"),
      };
      return {
        ...l,
        flags,
        error:
          errors.get(l.id) ||
          l.preparation_error ||
          (l.mailbox_error ? `Ящик отправителя: ${l.mailbox_error}` : "") ||
          (l.status === "invalid"
            ? "Не удалось подготовить письмо: проверьте переменные и содержимое шага"
            : ""),
        totalSteps: config.steps.length,
      };
    });
  const value = (l, key) =>
    String(
      key === "email"
        ? l.email
        : key === "sender"
          ? l.sender || ""
          : key === "step"
            ? Math.min(l.step + 1, l.totalSteps)
            : (l.fields[key] ?? ""),
    ).toLocaleLowerCase("ru");
  const groups = Map.groupBy(fields, (f) => f.key);
  const base = rows.filter((l) => {
    if (
      search &&
      ![
        l.email,
        l.fields.name,
        l.fields.company,
        l.fields["Имя"],
        l.fields["Компания"],
      ].some((v) =>
        String(v || "")
          .toLocaleLowerCase("ru")
          .includes(search),
      )
    )
      return false;
    return [...groups.values()].every((group) =>
      group.some((f) => {
        const actual = value(l, f.key),
          expected = String(f.value || "").toLocaleLowerCase("ru");
        return f.op === "empty"
          ? !actual.trim()
          : f.op === "not_empty"
            ? !!actual.trim()
            : f.op === "eq"
              ? actual === expected
              : actual.includes(expected);
      }),
    );
  });
  const counts = Object.fromEntries(
    Object.keys(leadActions).map((a) => [
      a,
      base.filter((l) => l.flags[a]).length,
    ]),
  );
  const filtered = base.filter(
    (l) =>
      (!actions.length || actions.some((a) => l.flags[a])) &&
      !excluded.some((a) => l.flags[a]),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const page = Math.min(
    pages,
    Math.max(1, Math.floor(Number(input.page) || 1)),
  );
  return {
    rows: filtered.slice((page - 1) * size, page * size),
    total: filtered.length,
    campaignTotal: rows.length,
    page,
    pages,
    counts,
    actions: leadActions,
    fields: [...keys],
    tracking: { opens: !!config.trackOpens, clicks: !!config.trackClicks },
  };
}
