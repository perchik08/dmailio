import test from "node:test";
import assert from "node:assert/strict";
import { applyBuilderImage } from "../public/marketing/editor-builder.js";
import { renderLetter } from "../marketing/render.mjs";
test("choosing a video thumbnail preserves its destination in source and exported HTML", () => {
  const original = {
    schemaVersion: 1,
    document: {
      root: { type: "EmailLayout", data: { childrenIds: ["video"] } },
      video: {
        type: "Video",
        data: { props: { url: "https://example.com/watch", alt: "Watch" } },
      },
    },
  };
  const source = applyBuilderImage(
    JSON.stringify(original),
    "video",
    { url: "https://example.com/thumbnail.png" },
    "Preview",
  );
  assert.equal(
    JSON.parse(source).document.video.data.props.url,
    "https://example.com/watch",
  );
  const result = renderLetter({ source, editorMode: "builder" });
  assert.match(result.html, /href="https:\/\/example.com\/watch"/);
  assert.match(result.html, /src="https:\/\/example.com\/thumbnail.png"/);
});
