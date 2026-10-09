import { requireValue } from "./core.mjs";

// Called only after the existing login and same-origin checks.
export async function handleFullInbox({
  path,
  method,
  url,
  data,
  send,
  res,
  store,
  gateway,
  worker,
}) {
  if (!path.startsWith("/api/mailbox/")) return false;
  const inbox = store.fullInbox;
  if (path === "/api/mailbox/messages" && method === "GET") {
    send(inbox.list(Object.fromEntries(url.searchParams)));
    return true;
  }
  const message = path.match(
    /^\/api\/mailbox\/messages\/([^/]+)(?:\/(action))?$/,
  );
  if (message) {
    const detail = inbox.get(message[1]);
    if (!detail) {
      send({ error: "Письмо не найдено" }, 404);
      return true;
    }
    if (method === "GET" && !message[2]) {
      send(detail);
      return true;
    }
    if (method === "POST" && message[2]) {
      const action = data.action;
      requireValue(
        [
          "read",
          "unread",
          "star",
          "unstar",
          "archive",
          "trash",
          "spam",
        ].includes(action),
        "Неизвестное действие с письмом",
      );
      if (detail.locations?.length) {
        const remoteAction = ["read", "unread"].includes(action)
          ? { read: action === "read" }
          : ["star", "unstar"].includes(action)
            ? { starred: action === "star" }
            : action;
        const result = await gateway.updateFullMessage(
          store.mailbox(detail.mailboxId, true),
          detail.locations,
          remoteAction,
        );
        for (const moved of result?.moves ||
          (result?.oldFolder ? [result] : []))
          inbox.relocate(detail.id, moved.oldFolder, moved.folder, moved);
      } else
        requireValue(
          ["read", "unread", "star", "unstar"].includes(action),
          "У письма нет доступного расположения у провайдера. Дождитесь синхронизации.",
        );
      if (["read", "unread"].includes(action))
        inbox.setLocalFlags(detail.id, { read: action === "read" });
      if (["star", "unstar"].includes(action))
        inbox.setLocalFlags(detail.id, { starred: action === "star" });
      send(inbox.get(detail.id));
      return true;
    }
  }
  const attachment = path.match(/^\/api\/mailbox\/attachments\/([^/]+)$/);
  if (attachment && method === "GET") {
    const asset = inbox.attachment(decodeURIComponent(attachment[1]));
    if (!asset) send({ error: "Вложение не найдено" }, 404);
    else {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(String(asset.name || "attachment").toWellFormed())}`,
      );
      send(Buffer.from(asset.data), 200, "application/octet-stream");
    }
    return true;
  }
  if (path === "/api/mailbox/drafts") {
    if (method === "GET") {
      send(inbox.drafts());
      return true;
    }
    if (method === "POST") {
      send(inbox.saveDraft(data), 201);
      return true;
    }
  }
  const draft = path.match(/^\/api\/mailbox\/drafts\/([^/]+)(?:\/delete)?$/);
  if (draft && ["POST", "DELETE"].includes(method)) {
    inbox.deleteDraft(draft[1]);
    send({ ok: true });
    return true;
  }
  if (path === "/api/mailbox/send" && method === "POST") {
    const reserved = inbox.reserveOutgoing(data);
    if (reserved.reservationFresh) await worker.deliver(reserved);
    send({
      ...store.message(reserved.id),
      sentCopyError: inbox.outgoing(reserved.id)?.sentCopyError || "",
      deliveryWarning: inbox.outgoing(reserved.id)?.deliveryWarning || "",
    });
    return true;
  }
  send({ error: "Метод не найден" }, 404);
  return true;
}
