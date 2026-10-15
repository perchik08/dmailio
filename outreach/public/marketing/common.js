export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export async function request(path, data, method) {
  const response = await fetch(`/api/marketing${path}`, {
    method: method || (data === undefined ? "GET" : "POST"),
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(
      new Error(body.message || "Не удалось выполнить действие"),
      { code: body.code, status: response.status },
    );
  }
  return response;
}
export async function api(path, data, method) {
  return (await request(path, data, method)).json();
}
export function guard(fn, target) {
  return async (event) => {
    try {
      await fn(event);
    } catch (error) {
      target.querySelector("[data-error]").textContent = error.message;
    }
  };
}
export const statusNames = {
  active: "Активен",
  disabled: "Маркетинг отключён",
  blocked: "Заблокирован",
  unsubscribed: "Отписан",
  unconfirmed: "Без подтверждения",
};
export const date = (value) =>
  value ? new Date(value).toLocaleString("ru-RU") : "—";
export function heading(title, description, actions = "") {
  return `<div class="top"><div><h1>${escape(title)}</h1><p class="hint">${escape(description)}</p></div><div class="mk-actions">${actions}</div></div><p data-error role="alert" class="mk-error"></p>`;
}
export function pager(result) {
  return `<div class="mk-pager"><span>Всего: ${result.total}</span><button data-page="${result.page - 1}" ${result.page <= 1 ? "disabled" : ""}>Назад</button><span>Страница ${result.page}</span><button data-page="${result.page + 1}" ${result.page * result.perPage >= result.total ? "disabled" : ""}>Далее</button></div>`;
}
export function dialog(title, content, submit, { save = "Сохранить" } = {}) {
  const element = document.createElement("dialog");
  element.className = "mk-dialog";
  element.innerHTML = `<form><h2>${escape(title)}</h2>${content}<p data-error role="alert" class="mk-error"></p><div class="mk-actions"><button type="button" data-cancel>Отмена</button><button class="primary" type="submit">${escape(save)}</button></div></form>`;
  document.body.append(element);
  element.querySelector("[data-cancel]").onclick = () => element.close();
  element.addEventListener("close", () => element.remove());
  element.querySelector("form").onsubmit = guard(async (event) => {
    event.preventDefault();
    const button = element.querySelector("[type=submit]");
    button.disabled = true;
    try {
      await submit(new FormData(event.target), element);
      element.close();
    } finally {
      button.disabled = false;
    }
  }, element);
  element.showModal();
  return element;
}
export const input = (name, label, value = "", type = "text", extra = "") =>
  `<label>${escape(label)}<input name="${name}" type="${type}" value="${escape(value)}" ${extra}></label>`;
export function navigate(section, params = new URLSearchParams()) {
  if (
    document.querySelector("#marketing-root")?.isDirtyLetter?.() &&
    !confirm(
      "Есть несохранённые изменения. Перейти? Черновик останется на этом устройстве.",
    )
  )
    return;
  location.hash = `marketing/${section}${params.size ? "?" + params : ""}`;
}
