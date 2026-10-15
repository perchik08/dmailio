import test from "node:test";
import assert from "node:assert/strict";
import { builderHTML, parseBuilder } from "../marketing/builder.mjs";
test("builder compiler validates references and renders six-column rows, styles and text without executing HTML", () => {
  const document = {
    schemaVersion: 1,
    document: {
      root: {
        type: "EmailLayout",
        data: { childrenIds: ["row"], canvasColor: "#fff", width: 720 },
      },
      row: {
        type: "ColumnsContainer",
        data: {
          props: {
            columns: Array.from({ length: 6 }, (_, i) => ({
              childrenIds: ["b" + i],
            })),
            ratios: [1, 1, 2, 1, 1, 1],
            mobileReverse: true,
          },
        },
      },
    },
  };
  for (let i = 0; i < 6; i++)
    document.document["b" + i] = {
      type: "Text",
      data: { props: { text: "Column " + i } },
    };
  const html = builderHTML(JSON.stringify(document));
  assert.match(html, /Column 5/);
  assert.match(html, /720px/);
  assert.equal((html.match(/class="mk-column"/g) || []).length, 6);
  const cycle = structuredClone(document);
  cycle.document.row.data.props.columns[0].childrenIds = ["row"];
  assert.throws(() => parseBuilder(JSON.stringify(cycle)), /цикл/);
  const missing = structuredClone(document);
  missing.document.root.data.childrenIds = ["missing"];
  assert.throws(() => parseBuilder(JSON.stringify(missing)), /блок/);
  assert.throws(() => parseBuilder('{"schemaVersion":99}'), /верс/);
});
