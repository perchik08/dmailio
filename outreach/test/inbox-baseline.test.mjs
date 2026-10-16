import test from "node:test";
import assert from "node:assert/strict";
import { MailGateway } from "../mail.mjs";
const since = Date.now() - 10000;
const raw = Buffer.from(
  "From: other@example.com\r\nTo: owner@example.com\r\nSubject: Hello\r\n\r\nBody",
);
function fixture(matches, failure) {
  const ranges = [],
    searches = [],
    received = [];
  const g = new MailGateway({}, "https://example.com");
  g.imap = () => ({
    connect: async () => {},
    close() {},
    list: async () => [{ path: "INBOX" }],
    getMailboxLock: async () => ({ release() {} }),
    mailbox: { uidValidity: 1, uidNext: 10001 },
    search: async (query, options) => {
      searches.push({ query, options });
      if (failure === "search") throw Error("Search unavailable");
      return matches.filter((uid) => uid >= Number(query.uid.split(":")[0]));
    },
    async *fetch(range) {
      ranges.push(range);
      if (failure === "fetch") throw Error("Fetch unavailable");
      for (const uid of String(range).split(",").map(Number))
        yield {
          uid,
          source: raw,
          internalDate: new Date(uid === 9001 ? since - 1 : since + 1),
          flags: new Set(),
        };
    },
  });
  return {
    ranges,
    searches,
    received,
    sync: (cursor) =>
      g.sync({ id: "box", cursor }, (m) => received.push(m.uid)),
  };
}
const prior = () => ({
  since,
  folders: { INBOX: { validity: "1", uid: 3400 } },
});
test("date search skips old UID backlog and preserves exact connection baseline", async () => {
  const f = fixture([9001, 9999, 10000]);
  const cursor = await f.sync(prior());
  assert.deepEqual(f.ranges, ["9001,9999,10000"]);
  assert.deepEqual(f.received, [9999, 10000]);
  assert.equal(f.searches[0].query.uid, "3401:10000");
  assert.equal(f.searches[0].options.uid, true);
  assert.ok(f.searches[0].query.since.getTime() <= since - 86400000);
  assert.equal(cursor.folders.INBOX.uid, 10000);
  assert.equal(cursor.caughtUp, true);
});
test("empty recent search catches up without downloading old mail", async () => {
  const f = fixture([]),
    cursor = await f.sync(prior());
  assert.deepEqual(f.ranges, []);
  assert.equal(cursor.folders.INBOX.uid, 10000);
  assert.equal(cursor.caughtUp, true);
});
test("recent search stays bounded and resumes after 200 matches", async () => {
  const f = fixture(Array.from({ length: 205 }, (_, i) => 9500 + i));
  let cursor = await f.sync(prior());
  assert.equal(f.received.length, 200);
  assert.equal(cursor.caughtUp, false);
  cursor = await f.sync(cursor);
  assert.equal(f.received.length, 205);
  assert.equal(new Set(f.received).size, 205);
  assert.equal(f.ranges[0].split(",").length, 200);
  assert.equal(cursor.caughtUp, true);
});
for (const failure of ["search", "fetch"])
  test(`${failure} failure does not advance cursor or allow sending`, async () => {
    const f = fixture([9999], failure),
      cursor = await f.sync(prior());
    assert.equal(cursor.folders.INBOX.uid, 3400);
    assert.equal(cursor.caughtUp, false);
    assert.equal(cursor.errors.length, 1);
  });
