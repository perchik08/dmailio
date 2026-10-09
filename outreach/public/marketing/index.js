import { api, escape } from "./common.js";
import { contacts } from "./contacts.js";
import { lists } from "./lists.js";
import { importForm, importStatus } from "./import.js";
import { letters, letterEditor } from "./letters.js";
export async function mountMarketing(root, refresh) {
  root.disposeLetter?.();
  const [section, search = ""] = location.hash
    .slice("#marketing/".length)
    .split("?");
  const params = new URLSearchParams(search);
  root.innerHTML = '<p role="status">Загрузка маркетинговой базы…</p>';
  try {
    if (section === "letters") await letters(root, params, refresh);
    else if (/^letters\/[a-f\d-]{36}$/.test(section))
      await letterEditor(root, section.split("/")[1]);
    else if (section === "import") await importForm(root, params);
    else if (/^imports\/[\w-]+$/.test(section))
      await importStatus(root, section.split("/")[1]);
    else if (section === "contacts") await contacts(root, params, { refresh });
    else if (section === "lists") await lists(root, params, refresh);
    else if (/^lists\/[a-f\d-]{36}$/.test(section))
      await contacts(root, params, { list: await api("/" + section), refresh });
    else throw new Error("Раздел не найден");
  } catch (error) {
    root.innerHTML = `<h1>Маркетинговая база</h1><p role="alert">${escape(error.message)}</p><p>Аутрич и почта доступны через меню.</p><button data-retry>Повторить</button>`;
    root.querySelector("[data-retry]").onclick = refresh;
  }
}
