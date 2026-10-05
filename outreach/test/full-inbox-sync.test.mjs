import test from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { MailGateway } from "../mail.mjs";
const since = Date.now() - 10000;
const raw = Buffer.from(
  "From: other@example.com\r\nTo: owner@example.com\r\nMessage-ID: <same@example.com>\r\nSubject: Hello\r\n\r\nBody",
);
function gateway(folders, messages = {}, overrides = {}) {
  const g = new MailGateway({}, "https://example.com");
  let path;
  const c = {
    connect: async () => {},
    close() {},
    list: async () => folders,
    getMailboxLock: async (p) => {
      path = p;
      if (p === "Broken") throw Error("denied");
      return { release() {} };
    },
    get mailbox() {
      return {
        uidValidity: overrides.validity || 1,
        uidNext: Math.max(0, ...(messages[path] || []).map((m) => m.uid)) + 1,
      };
    },
    async *fetch(range, query) {
      for (const m of messages[path] || []) {
        const [start, end] = String(range).split(":").map(Number);
        if (m.uid >= start && m.uid <= (end || start))
          yield {
            ...m,
            source: m.source || raw,
            internalDate: m.internalDate || new Date(since + 1),
            flags: new Set(m.flags || []),
          };
      }
    },
    ...overrides,
  };
  g.imap = () => c;
  return g;
}
test("full sync includes custom and spam folders, excludes Sent and Drafts, skips old internal dates", async () => {
  const g = gateway(
    [
      { path: "INBOX" },
      { path: "Custom" },
      { path: "Spam", specialUse: "\\Junk" },
      { path: "Sent", specialUse: "\\Sent" },
      { path: "Drafts", specialUse: "\\Drafts" },
    ],
    {
      INBOX: [{ uid: 1 }],
      Custom: [{ uid: 1, internalDate: new Date(since - 1) }, { uid: 2 }],
      Spam: [{ uid: 1 }],
      Sent: [{ uid: 1 }],
      Drafts: [{ uid: 1 }],
    },
  );
  const received = [];
  const cursor = await g.sync(
    { id: "box", email: "owner@example.com", cursor: { since, folders: {} } },
    (m) => received.push(m),
  );
  assert.deepEqual(
    received.map((m) => m.folder),
    ["INBOX", "Custom", "Spam"],
  );
  assert.equal(cursor.caughtUp, true);
  assert.equal(cursor.folders.Custom.uid, 2);
  assert.match(received[0].identity, /^sha256:/);
  assert.notEqual(received[0].remoteId, received[1].remoteId);
});
test("UID reset retains connection baseline and folder failures do not block others", async () => {
  const g = gateway(
    [{ path: "Broken" }, { path: "INBOX" }],
    { INBOX: [{ uid: 1, internalDate: new Date(since - 1) }, { uid: 2 }] },
    { validity: 2 },
  );
  const received = [];
  const cursor = await g.sync(
    {
      id: "box",
      cursor: { since, folders: { INBOX: { uid: 50, validity: "1" } } },
    },
    (m) => received.push(m),
  );
  assert.equal(received.length, 1);
  assert.equal(cursor.caughtUp, false);
  assert.equal(cursor.errors[0].folder, "Broken");
  assert.equal(cursor.since, since);
});
test("legacy real mailbox gets rollout baseline and does not import old messages", async () => {
  const g = gateway([{ path: "INBOX" }], {
    INBOX: [{ uid: 1, internalDate: new Date(0) }],
  });
  const received = [];
  const cursor = await g.sync(
    { id: "box", cursor: { validity: "1", uid: 0 } },
    (m) => received.push(m),
  );
  assert.equal(received.length, 0);
  assert.ok(cursor.since >= since);
  assert.match(cursor.warnings[0], /baseline/i);
});
test("full sync caps each folder at 200 and resumes a finite rotating folder batch", async () => {
  const folders = Array.from({ length: 25 }, (_, i) => ({
    path: i ? "F" + i : "INBOX",
  }));
  const messages = {
    INBOX: Array.from({ length: 205 }, (_, i) => ({ uid: i + 1 })),
  };
  const g = gateway(folders, messages);
  let count = 0;
  let cursor = await g.sync(
    { id: "box", cursor: { since, folders: {} } },
    () => count++,
  );
  assert.equal(count, 200);
  assert.equal(cursor.caughtUp, false);
  assert.ok(Object.keys(cursor.folders).length <= 20);
  cursor = await g.sync({ id: "box", cursor }, () => count++);
  assert.ok(cursor.folders.F24);
});
test("stale location refuses remote action", async () => {
  const g = gateway([{ path: "INBOX" }], {}, { validity: 2 });
  await assert.rejects(
    g.updateFullMessage({}, [{ folder: "INBOX", validity: "1", uid: 1 }], {
      read: true,
    }),
    /UIDVALIDITY/,
  );
});
test("accepted SMTP uses identical MIME in Sent and append failure remains accepted", async () => {
  const g = gateway(
    [{ path: "Sent", specialUse: "\\Sent" }],
    {},
    {
      append: async (path, raw) => {
        assert.equal(raw, sentRaw);
        throw Error("disk full");
      },
    },
  );
  let sentRaw,
    copies = [],
    sends = 0;
  g.store = {
    image: () => null,
    fullInbox: {
      outgoing: () => ({
        to: ["to@example.com"],
        cc: [],
        bcc: ["hidden@example.com"],
        attachments: [
          { name: "file.txt", type: "text/plain", data: Buffer.from("file") },
        ],
      }),
      recordSentCopy: (id, error) => copies.push(error),
    },
  };
  g.transport = () => ({
    close() {},
    sendMail: async (opts) => {
      sends++;
      sentRaw = opts.raw;
      assert.deepEqual(opts.envelope.to, [
        "to@example.com",
        "hidden@example.com",
      ]);
      return { accepted: ["to@example.com"] };
    },
  });
  await g.send(
    { email: "owner@example.com" },
    {
      id: "m",
      kind: "mail",
      subject: "Subject",
      body: "Hi",
      signature: "Regards",
      message_id: "<m@example.com>",
    },
  );
  assert.equal(sends, 1);
  assert.match(copies[0], /disk full/);
  const parsed = await simpleParser(sentRaw);
  assert.equal(parsed.attachments[0].filename, "file.txt");
  assert.equal(parsed.bcc, undefined);
  assert.match(parsed.text, /Regards/);
});
test("verification initializes all folder cursors at connection time", async () => {
  const g = gateway([{ path: "INBOX" }, { path: "Archive" }], {
    INBOX: [{ uid: 4 }],
    Archive: [{ uid: 9 }],
  });
  g.transport = () => ({ verify: async () => {}, close() {} });
  const cursor = await g.verify({ id: "box" });
  assert.ok(cursor.since >= since);
  assert.equal(cursor.uid, 0);
  assert.equal(cursor.folders.Archive.uid, 0);
});
test("provider identity, attachments and partial MIME warning survive capture", async () => {
  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });
  const composed = await composer.sendMail({
    from: "other@example.com",
    to: "owner@example.com",
    text: "Hi",
    attachments: [{ filename: "a.txt", content: "abc" }],
  });
  const g = gateway([{ path: "INBOX" }], {
    INBOX: [
      {
        uid: 1,
        source: composed.message,
        emailId: "gmail123",
        size: 20_000_000,
      },
    ],
  });
  const received = [];
  await g.sync({ id: "box", cursor: { since, folders: {} } }, (m) =>
    received.push(m),
  );
  assert.equal(received[0].identity, "provider:gmail123");
  assert.deepEqual(received[0].attachments[0].data, Buffer.from("abc"));
  assert.match(received[0].text, /partially/);
});
test("arbitrary __proto__ folder is stored as an own cursor property", async () => {
  const messages = Object.create(null);
  messages.__proto__ = [{ uid: 1 }];
  const g = gateway([{ path: "__proto__" }], messages);
  const cursor = await g.sync(
    { id: "box", cursor: { since, folders: {} } },
    () => {},
  );
  assert.equal(Object.hasOwn(cursor.folders, "__proto__"), true);
  assert.equal(cursor.folders.__proto__.uid, 1);
});
test("flags refresh and vanished locations use bounded source UID batches", async () => {
  const g = gateway([{ path: "INBOX" }], {
    INBOX: [{ uid: 1, flags: ["\\Seen"] }],
  });
  let flags, removed;
  g.store.fullInbox = {
    locations: () => [
      { uid: 1, validity: "1" },
      { uid: 2, validity: "1" },
    ],
    updateLocationFlags: (...args) => (flags = args),
    removeLocations: (...args) => (removed = args),
  };
  g.imap = () => ({
    connect: async () => {},
    close() {},
    list: async () => [{ path: "INBOX" }],
    getMailboxLock: async () => ({ release() {} }),
    mailbox: { uidValidity: 1, uidNext: 3 },
    async *fetch(range) {
      assert.equal(range, "1,2");
      yield { uid: 1, flags: new Set(["\\Seen"]) };
    },
  });
  await g.sync(
    {
      id: "box",
      cursor: { since, folders: { INBOX: { validity: "1", uid: 2 } } },
    },
    () => {},
  );
  assert.deepEqual(flags.slice(3), [1, ["\\Seen"]]);
  assert.deepEqual(removed.slice(3), [[2]]);
});
test("archive resolves provider special folder and seen flags apply to every location", async () => {
  const changed = [];
  const g = gateway(
    [{ path: "INBOX" }, { path: "Archive", specialUse: "\\Archive" }],
    {},
    {
      messageMove: async (uid, path) => {
        changed.push([uid, path]);
        return { uidValidity: 1, uidMap: new Map([[uid, 7]]) };
      },
      messageFlagsAdd: async (uid, flags) => {
        changed.push([uid, flags]);
        return true;
      },
    },
  );
  assert.deepEqual(
    await g.updateFullMessage(
      {},
      [{ folder: "INBOX", validity: "1", uid: 1 }],
      { action: "archive" },
    ),
    {
      folder: "Archive",
      oldFolder: "INBOX",
      validity: "1",
      uid: 7,
      moves: [{ folder: "Archive", oldFolder: "INBOX", validity: "1", uid: 7 }],
    },
  );
  await g.updateFullMessage(
    {},
    [
      { folder: "INBOX", validity: "1", uid: 2 },
      { folder: "Archive", validity: "1", uid: 3 },
    ],
    { read: true },
  );
  assert.deepEqual(changed, [
    [1, "Archive"],
    [2, ["\\Seen"]],
    [3, ["\\Seen"]],
  ]);
});
test("accessible received folders retain self-originated deliveries", async () => {
  const mine = (to) =>
    Buffer.from(
      `From: owner@example.com\r\nTo: ${to}\r\nSubject: Self\r\n\r\nHi`,
    );
  const g = gateway([{ path: "AllMail" }], {
    AllMail: [
      { uid: 1, source: mine("other@example.com") },
      { uid: 2, source: mine("owner@example.com") },
    ],
  });
  const received = [];
  await g.sync(
    { id: "box", email: "owner@example.com", cursor: { since, folders: {} } },
    (m) => received.push(m),
  );
  assert.deepEqual(
    received.map((m) => m.uid),
    [1, 2],
  );
});
test("refresh resumes after first200 persisted source locations", async () => {
  const g = gateway([{ path: "INBOX" }], {});
  let options;
  g.store.fullInbox = {
    locations: (mid, path, opt) => {
      options = opt;
      return [];
    },
  };
  await g.sync(
    {
      id: "box",
      cursor: {
        since,
        folders: { INBOX: { validity: "1", uid: 0, refreshUid: 200 } },
      },
    },
    () => {},
  );
  assert.equal(options.afterUid, 200);
});
test("Gmail All folder is accepted archive destination", async () => {
  const g = gateway(
    [{ path: "INBOX" }, { path: "All", specialUse: "\\All" }],
    {},
    { messageMove: async () => ({ uidValidity: 1 }) },
  );
  assert.equal(
    (
      await g.updateFullMessage(
        {},
        [{ folder: "INBOX", validity: "1", uid: 1 }],
        { action: "archive" },
      )
    ).folder,
    "All",
  );
});
test("automatic provider Sent copy prevents a duplicate append", async () => {
  let appends = 0;
  const g = gateway(
    [{ path: "Sent", specialUse: "\\Sent" }],
    {},
    {
      search: async () => [7],
      append: async () => {
        appends++;
      },
    },
  );
  g.store = {
    fullInbox: {
      outgoing: () => ({ to: ["to@example.com"] }),
      recordSentCopy() {},
    },
  };
  g.transport = () => ({
    close() {},
    sendMail: async () => ({ accepted: ["to@example.com"] }),
  });
  await g.send(
    { email: "owner@example.com" },
    {
      id: "m",
      kind: "mail",
      subject: "Hi",
      body: "Hi",
      message_id: "<m@example.com>",
    },
  );
  assert.equal(appends, 0);
});
test("IMAP initialization failure still returns persisted rollout baseline", async () => {
  const g = gateway([]);
  g.imap = () => {
    throw Error("config");
  };
  const cursor = await g.sync({ id: "box" }, () => {});
  assert.ok(cursor.since >= since);
  assert.equal(cursor.caughtUp, false);
  assert.match(cursor.errors[0].error, /config/);
});
test("archive chooses INBOX even when Archive location sorts first", async () => {
  const moved = [];
  const g = gateway(
    [{ path: "Archive", specialUse: "\\Archive" }, { path: "INBOX" }],
    {},
    {
      messageMove: async (uid, folder) => {
        moved.push([uid, folder]);
        return { uidValidity: 1, uidMap: new Map([[uid, 9]]) };
      },
    },
  );
  const result = await g.updateFullMessage(
    {},
    [
      { folder: "Archive", validity: "1", uid: 1 },
      { folder: "INBOX", validity: "1", uid: 2 },
    ],
    { action: "archive" },
  );
  assert.deepEqual(moved, [[2, "Archive"]]);
  assert.equal(result.moves[0].oldFolder, "INBOX");
});
test("archive already in destination is a remote no-op", async () => {
  const g = gateway(
    [{ path: "Archive", specialUse: "\\Archive" }],
    {},
    {
      messageMove: async () => {
        throw Error("Must not move to self");
      },
    },
  );
  assert.deepEqual(
    await g.updateFullMessage(
      {},
      [{ folder: "Archive", validity: "1", uid: 1 }],
      { action: "archive" },
    ),
    { folder: "Archive", moves: [] },
  );
});
test("trash moves every independent non-destination copy", async () => {
  const moved = [];
  const g = gateway(
    [
      { path: "Trash", specialUse: "\\Trash" },
      { path: "INBOX" },
      { path: "Custom" },
    ],
    {},
    {
      messageMove: async (uid, folder) => {
        moved.push([uid, folder]);
        return { uidValidity: 1 };
      },
    },
  );
  const result = await g.updateFullMessage(
    {},
    [
      { folder: "Trash", validity: "1", uid: 1 },
      { folder: "Custom", validity: "1", uid: 2 },
      { folder: "INBOX", validity: "1", uid: 3 },
    ],
    { action: "trash" },
  );
  assert.deepEqual(moved, [
    [3, "Trash"],
    [2, "Trash"],
  ]);
  assert.equal(result.moves.length, 2);
});
test("APPEND false records copy failure after accepted SMTP", async () => {
  let warning;
  const g = gateway(
    [{ path: "Sent", specialUse: "\\Sent" }],
    {},
    { append: async () => false },
  );
  g.store = {
    fullInbox: {
      outgoing: () => ({ to: ["to@example.com"] }),
      recordSentCopy: (id, error) => (warning = error),
    },
  };
  g.transport = () => ({
    close() {},
    sendMail: async () => ({ accepted: ["to@example.com"] }),
  });
  await g.send(
    { email: "owner@example.com" },
    {
      id: "m",
      kind: "mail",
      subject: "Hi",
      body: "Hi",
      message_id: "<m@example.com>",
    },
  );
  assert.match(warning, /append.*failed/i);
});
test("server FETCH UID ranges are bounded before request, including UID gaps", async () => {
  let range;
  const g = gateway(
    [{ path: "INBOX" }],
    {},
    {
      mailbox: { uidValidity: 1, uidNext: 100001 },
      async *fetch(value) {
        range = value;
        yield { uid: 7, source: raw, internalDate: new Date(since + 1) };
      },
    },
  );
  const cursor = await g.sync(
    {
      id: "box",
      cursor: { since, folders: { INBOX: { validity: "1", uid: 0 } } },
    },
    () => {},
  );
  assert.equal(range, "1:200");
  assert.equal(cursor.uid, 200);
  assert.equal(cursor.caughtUp, false);
});
test("verification baseline captures a message arriving during folder scan", async () => {
  const g = gateway([{ path: "INBOX" }], {
    INBOX: [{ uid: 1, internalDate: new Date(Date.now() + 1000) }],
  });
  g.transport = () => ({ verify: async () => {}, close() {} });
  const cursor = await g.verify({ id: "box" });
  const received = [];
  await g.sync({ id: "box", cursor }, (m) => received.push(m));
  assert.equal(received.length, 1);
});
test("self-originated inbox delivery with no known outgoing id is captured", async () => {
  const source = Buffer.from(
    "From: owner@example.com\r\nTo: distribution@example.com\r\nSubject: BCC copy\r\n\r\nHi",
  );
  const g = gateway([{ path: "INBOX" }], { INBOX: [{ uid: 1, source }] });
  const received = [];
  await g.sync(
    { id: "box", email: "owner@example.com", cursor: { since, folders: {} } },
    (m) => received.push(m),
  );
  assert.equal(received.length, 1);
});
test("partial SMTP acceptance remains delivered and records rejected recipients separately", async () => {
  let deliveryWarning,
    sends = 0;
  const g = gateway(
    [{ path: "Sent", specialUse: "\\Sent" }],
    {},
    { append: async () => true },
  );
  g.store = {
    fullInbox: {
      outgoing: () => ({ to: ["good@example.com", "bad@example.com"] }),
      recordSentCopy() {},
      recordDeliveryWarning: (id, warning) => (deliveryWarning = warning),
    },
  };
  g.transport = () => ({
    close() {},
    sendMail: async () => {
      sends++;
      return { accepted: ["good@example.com"], rejected: ["bad@example.com"] };
    },
  });
  await g.send(
    { email: "owner@example.com" },
    {
      id: "m",
      kind: "mail",
      subject: "Hi",
      body: "Hi",
      message_id: "<m@example.com>",
    },
  );
  assert.equal(sends, 1);
  assert.match(deliveryWarning, /bad@example.com/);
  assert.match(deliveryWarning, /rejected/i);
});
