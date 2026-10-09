export function applyBuilderImage(source, selected, asset, alt) {
  const value = JSON.parse(source || empty());
  let id = selected;
  if (
    !id ||
    !["Image", "Gif", "Sticker", "Video", "Gallery"].includes(
      value.document[id]?.type,
    )
  ) {
    id = crypto.randomUUID();
    value.document[id] = { type: "Image", data: { props: {} } };
    value.document.root.data.childrenIds.push(id);
  }
  value.document[id].data.props = {
    ...value.document[id].data.props,
    ...(value.document[id].type === "Video" ||
    value.document[id].type === "Gallery"
      ? {}
      : { url: asset.url }),
    alt,
  };
  if (value.document[id].type === "Video")
    value.document[id].data.props.thumbnail = asset.url;
  if (value.document[id].type === "Gallery")
    value.document[id].data.props.images = [
      value.document[id].data.props.images,
      asset.url,
    ]
      .filter(Boolean)
      .join("\n");
  return JSON.stringify(value);
}
const empty = () =>
  JSON.stringify({
    schemaVersion: 1,
    document: { root: { type: "EmailLayout", data: { childrenIds: [] } } },
  });
export function mountBuilder(root, editor) {
  const host = document.createElement("div");
  host.className = "mk-builder-host";
  root.querySelector(".mk-source").prepend(host);
  const nonce = crypto.randomUUID(),
    frame = document.createElement("iframe");
  frame.title = "Визуальный конструктор";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = `/marketing/builder.html#${nonce}`;
  host.append(frame);
  let ready = false,
    known = "",
    selected = null,
    closed = false;
  const sync = () => {
    const active = editor.capture().editorMode === "builder";
    host.hidden = !active;
    if (!active) return;
    if (!editor.source.value) editor.source.value = empty();
    if (ready && editor.source.value !== known) {
      known = editor.source.value;
      frame.contentWindow.postMessage(
        {
          channel: "dmailio-builder",
          schemaVersion: 1,
          nonce,
          type: "load",
          source: known,
        },
        "*",
      );
    }
  };
  const changed = () => sync();
  const receive = (event) => {
    const data = event.data;
    if (
      closed ||
      event.source !== frame.contentWindow ||
      event.origin !== "null" ||
      data?.channel !== "dmailio-builder" ||
      data.schemaVersion !== 1 ||
      data.nonce !== nonce
    )
      return;
    if (data.type === "ready") {
      ready = true;
      known = "";
      sync();
    }
    if (data.type === "image" && typeof data.blockId === "string") {
      selected = data.blockId;
      root.querySelector("[data-image]").click();
    }
    if (
      data.type === "selection" &&
      (typeof data.blockId === "string" || data.blockId === null)
    )
      selected = data.blockId;
    if (
      data.type === "change" &&
      typeof data.source === "string" &&
      data.source.length <= 220000 &&
      editor.capture().editorMode === "builder"
    ) {
      try {
        const value = JSON.parse(data.source);
        if (value.schemaVersion !== 1 || !value.document?.root) return;
      } catch {
        return;
      }
      if (editor.source.value === data.source) return;
      known = data.source;
      editor.source.value = data.source;
      editor.source.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  editor.builderImage = (asset, alt) => {
    editor.source.value = applyBuilderImage(
      editor.source.value,
      selected,
      asset,
      alt,
    );
    editor.source.dispatchEvent(new Event("input", { bubbles: true }));
  };
  editor.builderVariable = (token) => {
    const value = JSON.parse(editor.source.value || empty());
    let id = selected;
    if (
      !id ||
      !["Text", "Heading", "Button"].includes(value.document[id]?.type)
    ) {
      id = crypto.randomUUID();
      value.document[id] = { type: "Text", data: { props: { text: "" } } };
      value.document.root.data.childrenIds.push(id);
    }
    value.document[id].data.props.text =
      (value.document[id].data.props.text || "") + token;
    editor.source.value = JSON.stringify(value);
    editor.source.dispatchEvent(new Event("input", { bubbles: true }));
  };
  window.addEventListener("message", receive);
  root.addEventListener("letter-change", changed);
  sync();
  return () => {
    closed = true;
    window.removeEventListener("message", receive);
    root.removeEventListener("letter-change", changed);
  };
}
