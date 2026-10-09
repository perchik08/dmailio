import test from "node:test";
import assert from "node:assert/strict";
import {
  contactInput,
  normalizeEmail,
  contactQuery,
  exportCell,
} from "../marketing/contacts.mjs";
import { listInput } from "../marketing/lists.mjs";

test("contact normalization preserves plus/dots and validates fields without an external validator", () => {
  assert.equal(
    normalizeEmail(" Test.Name+news@ПРИМЕР.РФ "),
    "test.name+news@xn--e1afmkfd.xn--p1ai",
  );
  assert.throws(() => normalizeEmail("invalid"));
  const contact = contactInput({
    email: "test@example.com",
    name: "Иван",
    fields: { company: "Компания", phone: "+79990000000" },
    tags: ["Один", "Один"],
    source: "Manual",
    enabled: true,
  });
  assert.deepEqual(contact.tags, ["Один"]);
  assert.throws(() =>
    contactInput({ ...contact, fields: { constructor: "attack" } }),
  );
  assert.throws(() => contactInput({ ...contact, source: "" }));
});
test("filters build controlled expressions and exports cannot execute spreadsheet formulas", () => {
  const query = contactQuery(
    new URLSearchParams(
      "search=O%27Reilly&tag=hello&status=blocked&sort=email&direction=asc",
    ),
  );
  assert.match(query.params.get("query"), /O''Reilly/);
  assert.equal(query.params.get("order_by"), "email");
  assert.throws(() => contactQuery(new URLSearchParams("query=DROP TABLE")));
  assert.throws(() => contactQuery(new URLSearchParams("sort=email;DROP")));
  assert.equal(exportCell('=HYPERLINK("evil")'), '\'=HYPERLINK("evil")');
  assert.equal(exportCell("normal"), "normal");
});
test("list validation preserves reversible archive status and rejects invalid tags", () => {
  assert.deepEqual(
    listInput({
      name: "Новости",
      description: "Описание",
      tags: ["B2B"],
      archived: true,
    }),
    {
      name: "Новости",
      description: "Описание",
      tags: ["B2B"],
      type: "private",
      optin: "single",
      status: "archived",
    },
  );
  assert.throws(() => listInput({ name: "" }));
  assert.throws(() => listInput({ name: "One", tags: [null] }));
});
