import { api, escape, date, heading, input, guard, dialog } from "./common.js";
const reasons = {
  DISABLED: "Почта выключена",
  UNVERIFIED: "Требуется проверка подключения",
  CONNECTION_ERROR: "Ошибка подключения",
  AUTH_REQUIRED: "Проверьте пароль приложения и подключение",
  POLICY_BLOCK: "Провайдер заблокировал отправку. Проверьте условия почты",
  RATE_LIMIT: "Пауза после ограничения провайдера",
  QUOTA: "Исчерпан бюджет за 24 часа",
  INTERVAL: "Пауза между письмами",
};
export async function settings(root, refresh) {
  const result = await api("/senders");
  root.innerHTML =
    heading(
      "Отправители рассылок",
      "Используйте почты, уже подключённые к Dmailio. Настройки отправителя сохраняются отдельно для каждого ящика.",
      "<button data-connect>Подключить почту</button>",
    ) +
    '<p data-feedback role="status" aria-live="polite"></p>' +
    '<p class="hint">Бюджет Dmailio общий для рассылок, кампаний, прогрева и переписки за скользящие 24 часа. Отправки вне сервиса не видны: задайте для них резерв. «Принято SMTP» не означает подтверждённую доставку.</p>' +
    (result.items.length
      ? result.items
          .map(
            (sender) =>
              `<section class="panel mk-sender" data-sender="${escape(sender.id)}"><h2>${escape(sender.email)}</h2><p>${sender.enabled ? "Включена" : "Выключена"} · ${sender.verified ? "Подключение проверено" : "Требуется проверка"}${result.defaultSenderId === sender.id ? " · По умолчанию" : ""}</p><p>Последняя проверка: ${escape(date(sender.checkedAt))}</p><p>${escape(sender.connectionError || reasons[sender.budget.reason] || "Готова к отправке")}${sender.budget.nextAvailableAt && sender.budget.reason ? " · " + escape(date(sender.budget.nextAvailableAt)) : ""}</p><p>Бюджет Dmailio: ${sender.budget.used} использовано / ${sender.budget.limit} за 24 часа. Осталось ${sender.budget.remaining}.</p><form><div class="mk-fields"><label><input name="enabled" type="checkbox" ${sender.marketingEnabled ? "checked" : ""}> Разрешить для рассылок</label>${input("fromName", "Имя отправителя", sender.fromName, "text", 'maxlength="200"')}${input("replyTo", "Reply-To", sender.replyTo, "email", "required")}${input("providerDailyLimit", "Лимит провайдера за 24 часа", sender.providerDailyLimit, "number", `required min="1" max="${sender.providerCeiling}" step="1"`)}${input("externalReserve", "Резерв для отправок вне Dmailio", sender.externalReserve, "number", 'required min="0" step="1"')}${input("intervalSeconds", "Пауза между письмами, секунд", sender.intervalSeconds, "number", 'required min="60" max="86400" step="1"')}</div><p class="hint">From: ${escape(sender.email)}. Изменить подключение и общий лимит можно в разделе «Почты».</p><div class="mk-actions"><button type="submit" class="primary">Сохранить настройки</button><button type="button" data-check>Проверить подключение</button><button type="button" data-default ${sender.eligible ? "" : "disabled"}>Использовать по умолчанию</button><button type="button" data-test ${sender.eligible ? "" : "disabled"}>Тестовое письмо</button></div><p data-error role="alert"></p></form></section>`,
          )
          .join("")
      : '<section class="panel"><h2>Нет подключённых почт</h2><p>Добавьте ящик в разделе «Почты», проверьте подключение и разрешите его для рассылок.</p></section>');
  root.querySelector("[data-connect]").onclick = () => {
    document.querySelector('[data-nav="mailboxes"]')?.click();
  };
  const feedback = (text) => {
    root.querySelector("[data-feedback]").textContent = text;
  };
  for (const section of root.querySelectorAll("[data-sender]")) {
    const id = section.dataset.sender,
      form = section.querySelector("form");
    form.onsubmit = guard(async (event) => {
      event.preventDefault();
      const button = form.querySelector("[type=submit]");
      button.disabled = true;
      try {
        const data = new FormData(form);
        await api(
          "/senders/" + id,
          {
            enabled: data.has("enabled"),
            fromName: data.get("fromName"),
            replyTo: data.get("replyTo"),
            providerDailyLimit: Number(data.get("providerDailyLimit")),
            externalReserve: Number(data.get("externalReserve")),
            intervalSeconds: Number(data.get("intervalSeconds")),
          },
          "PUT",
        );
        await settings(root, refresh);
        feedback("Настройки отправителя сохранены.");
      } finally {
        button.disabled = false;
      }
    }, form);
    section.querySelector("[data-check]").onclick = guard(async (event) => {
      event.target.disabled = true;
      try {
        await api("/transports/" + id + "/check", {});
        await settings(root, refresh);
        feedback("Подключение проверено. Письмо не отправлялось.");
      } finally {
        event.target.disabled = false;
      }
    }, form);
    section.querySelector("[data-default]").onclick = guard(async () => {
      await api("/senders/default", { senderId: id });
      await settings(root, refresh);
      feedback("Отправитель по умолчанию выбран для новых писем.");
    }, form);
    section.querySelector("[data-test]").onclick = () => {
      const operationId = crypto.randomUUID();
      dialog(
        "Тестовое письмо",
        `<p>Будет отправлено одно письмо с ${escape(result.items.find((row) => row.id === id).email)}. Оно расходует общий бюджет ящика.</p>${input("recipient", "Получатель теста", "", "email", "required")}`,
        async (data) => {
          const outcome = await api("/senders/" + id + "/test", {
            recipient: data.get("recipient"),
            operationId,
          });
          await settings(root, refresh);
          feedback(
            outcome.status === "accepted"
              ? "Письмо принято SMTP. Доставка ещё не подтверждена."
              : outcome.status === "unknown"
                ? "Результат отправки неизвестен. Автоматического повтора не будет. Проверьте ящик получателя."
                : outcome.status === "deferred"
                  ? `Письмо не отправлено: ${reasons[outcome.reason] || "отправка временно недоступна"}.`
                  : "SMTP отклонил письмо. Проверьте подключение и адрес получателя.",
          );
        },
        { save: "Отправить одно письмо" },
      );
    };
  }
}
