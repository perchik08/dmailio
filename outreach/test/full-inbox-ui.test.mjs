import test from "node:test";
import assert from "node:assert/strict";
import { parseRecipients, replyRecipients } from "../public/full-inbox.js";

test("compose parses comma, semicolon and newline separated recipients", () => {
  assert.deepEqual(
    parseRecipients(
      " first@example.test; second@example.test\nfirst@example.test, ",
    ),
    ["first@example.test", "second@example.test"],
  );
});

test("reply respects Reply-To and reply-all excludes sender mailbox and duplicate addresses", () => {
  const message = {
    from: "sender@example.test",
    replyTo: ["Reply <reply@example.test>"],
    to: ["Me <me@example.test>", "reply@example.test", "other@example.test"],
    cc: [
      "ME@example.test",
      "other@example.test",
      "copy@example.test",
      "Copy <copy@example.test>",
    ],
  };
  assert.deepEqual(replyRecipients(message, "me@example.test"), {
    to: ["reply@example.test"],
    cc: [],
  });
  assert.deepEqual(replyRecipients(message, "me@example.test", true), {
    to: ["reply@example.test", "other@example.test"],
    cc: ["copy@example.test"],
  });
});

test("reply to a sent message preserves original recipients and reply-all includes original cc", () => {
  const message = {
    direction: "out",
    from: "Me <me@example.test>",
    replyTo: ["me@example.test"],
    to: ["Recipient <recipient@example.test>", "me@example.test"],
    cc: [
      "Copy <copy@example.test>",
      "ME@example.test",
      "recipient@example.test",
    ],
  };
  assert.deepEqual(replyRecipients(message, "me@example.test"), {
    to: ["recipient@example.test"],
    cc: [],
  });
  assert.deepEqual(replyRecipients(message, "me@example.test", true), {
    to: ["recipient@example.test"],
    cc: ["copy@example.test"],
  });
});

test("reply falls back to From when Reply-To is absent", () => {
  assert.deepEqual(
    replyRecipients(
      { from: "sender@example.test", to: ["me@example.test"], cc: [] },
      "me@example.test",
      true,
    ),
    { to: ["sender@example.test"], cc: [] },
  );
});
