import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
for (const subject of ["", "Тема предыдущего письма"])
  test(`contact import can save an empty-body draft (${subject || "empty subject"}) but cannot launch it`, () => {
    const s = new Store(":memory:", "a".repeat(64));
    try {
      let c = s.createCampaignDraft("Import contacts");
      c.steps[0].subject = subject;
      c = s.saveCampaign(c);
      const contacts = Array.from({ length: 167 }, (_, i) => ({
        email: `lead${i}@example.com`,
        fields: { first_name: `Name${i}` },
      }));
      const result = s.importContacts(c.id, contacts);
      assert.equal(result.added, 167);
      assert.equal(s.campaign(c.id).steps[0].body, "");
      assert.equal(s.campaign(c.id).steps[0].subject, subject);
      assert.throws(
        () => s.setCampaignStatus(c.id, "active"),
        /тему первого письма и текст каждого письма/,
      );
      assert.equal(s.campaign(c.id).status, "draft");
    } finally {
      s.close();
    }
  });
test("draft saving still rejects malformed and oversized letter content", () => {
  const s = new Store(":memory:", "a".repeat(64));
  try {
    const c = s.createCampaignDraft("Invalid");
    for (const body of [null, 12, "x".repeat(100001)])
      assert.throws(() =>
        s.saveCampaign({ ...c, steps: [{ ...c.steps[0], body }] }),
      );
  } finally {
    s.close();
  }
});
