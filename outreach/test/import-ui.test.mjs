import test from "node:test";
import assert from "node:assert/strict";

test("import UI exposes supported field targets and validates file type and size", async () => {
  const ui = await import("../public/importer.js").catch(() => null);
  assert.ok(ui, "importer.js should expose the import UI helpers");
  assert.ok(ui.importTargets.some(({ value }) => value === "email"));
  assert.ok(ui.importTargets.some(({ value }) => value === "custom"));
  assert.equal(
    ui.validateImportFile({ name: "leads.csv", size: 20 }).format,
    "csv",
  );
  assert.equal(
    ui.validateImportFile({ name: "leads.xlsx", size: 20 }).format,
    "xlsx",
  );
  assert.throws(
    () => ui.validateImportFile({ name: "leads.xls", size: 20 }),
    /\.xls.*\.xlsx/i,
  );
  assert.throws(
    () => ui.validateImportFile({ name: "leads.csv", size: 10_000_001 }),
    /10 МБ/,
  );
});

test("mapping controls identify repeated source columns by stable position and step", async () => {
  const { mappingTargetLabel } = await import("../public/importer.js");
  assert.equal(
    mappingTargetLabel({ kind: "sequence_step", step: 2 }),
    "Письмо 2",
  );
  assert.equal(mappingTargetLabel("skip"), "Не импортировать");
});
