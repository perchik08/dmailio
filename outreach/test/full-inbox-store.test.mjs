import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import { FullInboxStore } from "../full-inbox-store.mjs";

function setup(t) {
  const owner = new Store(":memory:", "a".repeat(64));
  t.after(() => owner.close());
  const mailbox = owner.saveMailbox({
    email: "me@example.com",
    limit: 2,
    smtp: {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "me",
      password: "secret",
    },
    imap: {
      host: "imap.example.com",
      port: 993,
      secure: true,
      user: "me",
      password: "secret",
    },
  });
  owner.db
    .prepare("UPDATE mailboxes SET verified=1 WHERE id=?")
    .run(mailbox.id);
  return { owner, mailbox, inbox: new FullInboxStore(owner) };
}
const incoming = (identity, overrides = {}) => ({
  identity,
  folder: "INBOX",
  validity: "1",
  uid: 1,
  from: "broken sender",
  to: ["me@example.com"],
  messageId: "<collision@test>",
  subject: "Invoice",
  text: "hello",
  internalDate: 1000,
  flags: [],
  ...overrides,
});

test("canonical incoming mail accepts malformed senders, deduplicates locations, never Message-ID", (t) => {
  const { inbox, mailbox } = setup(t);
  const first = inbox.capture(mailbox.id, incoming("a"), 2000);
  assert.equal(first.fresh, true);
  assert.equal(
    inbox.capture(
      mailbox.id,
      incoming("a", { folder: "Archive", uid: 8 }),
      2001,
    ).id,
    first.id,
  );
  assert.equal(
    inbox.capture(mailbox.id, incoming("b", { uid: 2 }), 2001).fresh,
    true,
  );
  assert.equal(
    inbox.capture(mailbox.id, incoming("c", { uid: 3, messageId: "" }), 2001)
      .fresh,
    true,
  );
  assert.equal(inbox.list({}).total, 3);
  assert.deepEqual(inbox.get(first.id).folders, ["Archive", "INBOX"]);
});

test("safe bodies, attachments, flags, folder reconciliation and search pagination", (t) => {
  const { inbox, mailbox } = setup(t);
  const row = inbox.capture(
    mailbox.id,
    incoming("safe", {
      html: '<script>alert(1)</script><img src="https://track.test"><p onclick="evil()">Hello</p>',
      attachments: [
        { name: "a.txt", type: "text/plain", data: Buffer.from("abc") },
      ],
    }),
    2000,
  );
  const full = inbox.get(row.id);
  assert.equal(full.html, "<p>Hello</p>");
  assert.equal(inbox.attachment(full.attachments[0].id).data.toString(), "abc");
  inbox.setLocalFlags(row.id, { read: true, starred: true });
  assert.equal(inbox.get(row.id).read, true);
  assert.equal(inbox.get(row.id).starred, true);
  inbox.capture(
    mailbox.id,
    incoming("two", { uid: 2, subject: "Another" }),
    2001,
  );
  assert.equal(inbox.list({ search: "invoice", pageSize: 1 }).total, 1);
  assert.equal(inbox.list({ pageSize: 1, page: 2 }).items.length, 1);
  inbox.reconcileFolder(
    mailbox.id,
    "INBOX",
    "1",
    [{ uid: 2, flags: ["\\Seen"] }],
    false,
  );
  assert.equal(inbox.get(row.id).locations.length, 1);
  inbox.reconcileFolder(
    mailbox.id,
    "INBOX",
    "1",
    [{ uid: 2, flags: ["\\Seen"] }],
    true,
  );
  assert.equal(inbox.get(row.id).locations.length, 0);
});

test("draft snapshots and ordinary outgoing share quotas with campaign messages and deduplicate requests", (t) => {
  const { inbox, mailbox, owner } = setup(t);
  owner.saveSignature(mailbox.id, {
    body: "Original signature",
    format: "plain",
    enabled: true,
  });
  const input = {
    mailboxId: mailbox.id,
    to: ["friend@example.com"],
    subject: "Hi",
    body: "Hello",
    attachments: [
      {
        name: "a.txt",
        type: "text/plain",
        data: Buffer.from("abc").toString("base64"),
      },
    ],
  };
  const draft = inbox.saveDraft(input);
  assert.equal(inbox.drafts().length, 1);
  const row = inbox.reserveOutgoing(
    { ...input, draftId: draft.id, requestId: "request-1" },
    1000000,
  );
  assert.equal(row.reservationFresh, true);
  assert.equal(row.kind, "mail");
  assert.equal(row.signature, "Original signature");
  const duplicate = inbox.reserveOutgoing(
    { ...input, requestId: "request-1" },
    1000000,
  );
  assert.equal(duplicate.id, row.id);
  assert.equal(duplicate.reservationFresh, false);
  assert.equal(inbox.drafts().length, 0);
  assert.equal(inbox.outgoing(row.id).attachments[0].data.toString(), "abc");
  owner.finish(row.id, "unknown", 1000001);
  assert.equal(
    inbox.reserveOutgoing({ ...input, requestId: "request-1" }, 1000010).status,
    "unknown",
  );
  owner.insertMessage(
    {
      mailbox_id: mailbox.id,
      kind: "campaign",
      recipient: "lead@example.com",
      subject: "Campaign",
      body: "Hi",
    },
    1060000,
  );
  assert.throws(
    () => inbox.reserveOutgoing({ ...input, requestId: "request-2" }, 1120000),
    /лимит|Лимит/,
  );
  inbox.recordSentCopy(row.id, new Error("append failed"));
  assert.equal(inbox.outgoing(row.id).sentCopyError, "append failed");
  assert.equal(owner.message(row.id).status, "unknown");
});

test("outgoing validates headers, payload size and stored reply headers", (t) => {
  const { inbox, mailbox } = setup(t);
  const input = {
    mailboxId: mailbox.id,
    to: ["friend@example.com"],
    subject: "Hi",
    body: "Hello",
    requestId: "send",
  };
  assert.throws(() =>
    inbox.reserveOutgoing(
      { ...input, subject: "hi\r\nBcc:bad@test.com" },
      1000000,
    ),
  );
  assert.throws(() =>
    inbox.reserveOutgoing({ ...input, body: "x".repeat(200001) }, 1000000),
  );
  assert.throws(() =>
    inbox.reserveOutgoing(
      {
        ...input,
        attachments: [
          {
            name: "x",
            data: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"),
          },
        ],
      },
      1000000,
    ),
  );
  const parent = inbox.capture(
    mailbox.id,
    incoming("parent", {
      from: "friend@example.com",
      messageId: "<parent@example.com>",
      references: ["<root@example.com>"],
    }),
    2000,
  );
  const reply = inbox.reserveOutgoing(
    { ...input, replyToId: parent.id },
    1000000,
  );
  assert.equal(inbox.outgoing(reply.id).inReplyTo, "<parent@example.com>");
  assert.deepEqual(inbox.outgoing(reply.id).references, [
    "<root@example.com>",
    "<parent@example.com>",
  ]);
});

test("reply-all excludes own address and forwards trusted original body and attachments", (t) => {
  const { inbox, mailbox, owner } = setup(t);
  const parent = inbox.capture(
    mailbox.id,
    incoming("forward", {
      from: "friend@example.com",
      to: [mailbox.email, "other@example.com"],
      cc: ["copy@example.com"],
      text: "Trusted original",
      attachments: [
        {
          name: "original.txt",
          type: "text/plain",
          data: Buffer.from("trusted bytes"),
        },
      ],
    }),
    2000,
  );
  const reply = inbox.reserveOutgoing(
    {
      mailboxId: mailbox.id,
      replyToId: parent.id,
      replyAll: true,
      body: "Reply",
      requestId: "reply-all",
    },
    1000000,
  );
  assert.deepEqual(inbox.outgoing(reply.id).to, ["friend@example.com"]);
  assert.deepEqual(inbox.outgoing(reply.id).cc, [
    "other@example.com",
    "copy@example.com",
  ]);
  owner.finish(reply.id, "sent", 1000001);
  const forward = inbox.reserveOutgoing(
    {
      mailboxId: mailbox.id,
      forwardId: parent.id,
      to: ["next@example.com"],
      body: "",
      requestId: "forward",
    },
    1060001,
  );
  assert.match(forward.body, /Trusted original/);
  assert.equal(
    inbox.outgoing(forward.id).attachments[0].data.toString(),
    "trusted bytes",
  );
  const attachment = inbox.get(forward.id).attachments[0];
  assert.equal(
    inbox.attachment(attachment.id).data.toString(),
    "trusted bytes",
  );
  inbox.setLocalFlags(forward.id, { read: false, starred: true });
  assert.equal(inbox.get(forward.id).starred, true);
  assert.equal(inbox.list({ view: "sent" }).items[0].read, false);
  inbox.relocate(parent.id, "INBOX", "Archive");
  assert.deepEqual(inbox.get(parent.id).folders, ["Archive"]);
  assert.equal(inbox.list({ folder: "Archive" }).total, 1);
  inbox.capture(
    mailbox.id,
    incoming("forward", { folder: "Archive", uid: 10 }),
    2001,
  );
  assert.deepEqual(inbox.get(parent.id).folders, ["Archive"]);
});

test("legacy inbox survives additive backfill, campaign annotations and private cursor warnings", (t) => {
  const { inbox, mailbox, owner } = setup(t);
  owner.db
    .prepare(
      "INSERT INTO messages(id,message_id,mailbox_id,kind,direction,status,recipient,subject,body,created,token) VALUES(?,?,?,'reply','in','received',?,?,?,?,?)",
    )
    .run(
      "legacy-in",
      "<legacy@example.com>",
      mailbox.id,
      "friend@example.com",
      "Old conversation",
      "Old body",
      1000,
      "legacy-token",
    );
  const migrated = new FullInboxStore(owner);
  assert.equal(migrated.get("legacy-in").text, "Old body");
  assert.equal(new FullInboxStore(owner).list({}).total, 1);
  const row = inbox.capture(mailbox.id, incoming("campaign", { uid: 9 }), 2000);
  inbox.annotate(row.id, {
    id: "related",
    campaign_id: "campaign-id",
    kind: "reply",
  });
  assert.equal(inbox.list({ campaign: "campaign-id" }).total, 1);
  assert.equal(inbox.list({ kind: "campaign" }).total, 1);
  assert.equal(inbox.list({ kind: "reply" }).total, 2);
  inbox.capture(mailbox.id, incoming("bounce", { uid: 10, type: "bounce" }));
  assert.equal(inbox.list({ kind: "bounce" }).total, 1);
  inbox.annotate(row.id, { id: "warmup", kind: "warmup" });
  assert.equal(inbox.list({ kind: "warmup" }).total, 1);
  assert.equal(inbox.list({ kind: "reply" }).total, 1);
  owner.db
    .prepare("UPDATE mailboxes SET cursor=? WHERE id=?")
    .run(
      JSON.stringify({ since: 1000, errors: ["Folder unavailable"] }),
      mailbox.id,
    );
  const result = inbox.list({});
  assert.equal(result.warnings.length, 2);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
