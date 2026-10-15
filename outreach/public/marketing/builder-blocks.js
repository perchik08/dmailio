const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const url = (value) => {
  if (!value) return "";
  if (!/^(https:\/\/|\/marketing-media\/[a-f\d]{64}$)/i.test(String(value)))
    throw Error("Ссылки должны начинаться с https://");
  return esc(value);
};
export const advancedTypes = [
  "Table",
  "Social",
  "Menu",
  "Icons",
  "Sticker",
  "Gif",
  "Video",
  "Gallery",
  "Countdown",
];
export const advancedPalette = {
  Table: [
    "Таблица",
    { rows: "Заголовок 1\tЗаголовок 2\nЗначение 1\tЗначение 2" },
  ],
  Social: ["Соцсети", { links: "Сайт|https://example.com" }],
  Menu: ["Меню", { links: "Главная|https://example.com" }],
  Icons: ["Иконки", { text: "★ ✓ →", links: "" }],
  Sticker: ["Стикер", { url: "", alt: "Стикер" }],
  Gif: ["GIF", { url: "", alt: "Анимация" }],
  Video: [
    "Видео",
    {
      url: "https://example.com/video",
      thumbnail: "",
      alt: "Посмотреть видео",
    },
  ],
  Gallery: ["Галерея", { images: "", alt: "Галерея" }],
  Countdown: [
    "Таймер",
    {
      deadline: "2030-01-01T00:00:00+03:00",
      timezone: "Europe/Moscow",
      foreground: "#ffffff",
      background: "#535ff4",
    },
  ],
};
export function timerConfig(props) {
  const deadline = String(props.deadline || "");
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(
      deadline,
    ) ||
    !Number.isFinite(Date.parse(deadline))
  )
    throw Error(
      "Дата таймера должна содержать часовой пояс: 2026-12-31T18:00:00+03:00",
    );
  const foreground = props.foreground || "#ffffff",
    background = props.background || "#535ff4";
  if (!/^#[a-f\d]{6}$/i.test(foreground) || !/^#[a-f\d]{6}$/i.test(background))
    throw Error("Проверьте цвета таймера");
  try {
    new Intl.DateTimeFormat("ru", { timeZone: props.timezone || "UTC" });
  } catch {
    throw Error("Неизвестный часовой пояс");
  }
  if (
    Date.parse(deadline) < Date.UTC(2020, 0, 1) ||
    Date.parse(deadline) > Date.UTC(2100, 0, 1)
  )
    throw Error("Дата таймера: от 2020 до 2100 года");
  return {
    deadline: new Date(deadline).toISOString(),
    foreground,
    background,
    timezone: props.timezone || "UTC",
  };
}
export function timerPath(props) {
  const config = timerConfig(props);
  return `/marketing-countdown/${Date.parse(config.deadline)}-${config.foreground.slice(1)}-${config.background.slice(1)}.gif`;
}
export function advancedHTML(type, p) {
  switch (type) {
    case "Table": {
      const rows = String(p.rows || "").split("\n");
      if (rows.length > 100 || rows.some((row) => row.split("\t").length > 10))
        throw Error("Таблица: не более 100 строк и 10 колонок");
      return `<table role="presentation" width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse">${rows
        .map(
          (row, i) =>
            `<tr>${row
              .split("\t")
              .map(
                (cell) =>
                  `<${i ? "td" : "th"} style="border:1px solid #cccccc">${esc(cell)}</${i ? "td" : "th"}>`,
              )
              .join("")}</tr>`,
        )
        .join("")}</table>`;
    }
    case "Social":
    case "Menu":
      return String(p.links || "")
        .split("\n")
        .slice(0, 20)
        .map((line) => {
          const [label, href] = line.split("|");
          if (!href) return esc(label);
          if (!url(href)) throw Error("Ссылки должны начинаться с https://");
          return `<a href="${url(href)}" style="display:inline-block;padding:8px">${esc(label)}</a>`;
        })
        .join(" ");
    case "Icons":
      return `<span>${esc(p.text)}</span>`;
    case "Sticker":
    case "Gif":
      return p.url
        ? `<img src="${url(p.url)}" alt="${esc(p.alt)}" style="max-width:100%;height:auto">`
        : `<p>${esc(p.alt || "Выберите изображение")}</p>`;
    case "Video":
      return `<a href="${url(p.url)}">${p.thumbnail ? `<img src="${url(p.thumbnail)}" alt="${esc(p.alt || "Посмотреть видео")}" style="max-width:100%;height:auto">` : esc(p.alt || "Посмотреть видео")} ▶</a>`;
    case "Gallery": {
      const images = String(p.images || "")
        .split("\n")
        .filter(Boolean);
      if (images.length > 12) throw Error("Галерея: не более 12 картинок");
      return images
        .map(
          (image, index) =>
            `<img src="${url(image)}" alt="${esc(p.alt || "Галерея")} ${index + 1}" style="display:block;max-width:100%;height:auto">`,
        )
        .join("");
    }
    case "Countdown": {
      const config = timerConfig(p),
        label = new Intl.DateTimeFormat("ru-RU", {
          timeZone: config.timezone,
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(config.deadline));
      return `<img src="${timerPath(p)}" alt="Обратный отсчёт до ${esc(label)} (${esc(config.timezone)}); после окончания: 00:00:00:00" width="330" height="42">`;
    }
    default:
      throw Error("Неизвестный блок");
  }
}
