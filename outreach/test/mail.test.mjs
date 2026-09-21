import test from "node:test";
import assert from "node:assert/strict";
import { MailGateway, classify } from "../mail.mjs";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
test("SMTP preserves rich signature, CID image and plain alternative in MIME", async () => {
  const id = "b".repeat(32),
    png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
  const gateway = new MailGateway(
    { image: () => ({ mime: "image/png", data: png }) },
    "https://outreach.example.com",
  );
  let raw;
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });
  gateway.transport = () => ({
    close() {},
    async sendMail(v) {
      raw = (await transport.sendMail(v)).message;
      return { accepted: ["lead@example.com"] };
    },
  });
  await gateway.send(
    { email: "sender@example.com" },
    {
      recipient: "lead@example.com",
      subject: "Hello",
      body: "**Привет**",
      format: "markdown",
      signature: `С уважением, **Иван**\n![Logo](/api/images/${id})`,
      signature_format: "markdown",
      kind: "manual",
      message_id: "<rich@example.com>",
    },
  );
  const parsed = await simpleParser(raw, { skipImageLinks: true });
  assert.match(parsed.html, /<strong>Иван<\/strong>/);
  assert.match(parsed.html, new RegExp(`cid:${id}@dmailio`));
  assert.equal(parsed.attachments.length, 1);
  assert.deepEqual(parsed.attachments[0].content, png);
  assert.match(parsed.text, /С уважением, Иван/);
  assert.doesNotMatch(parsed.text, /\*\*/);
});
test("oversized inbox messages preserve reply headers and advance sync cursor", async () => {
  const gateway = new MailGateway({}, "https://example.com");
  gateway.imap = () => ({
    connect: async () => {},
    getMailboxLock: async () => ({ release() {} }),
    mailbox: { uidValidity: 1, uidNext: 3 },
    close() {},
    async *fetch() {
      yield {
        uid: 2,
        size: 8_000_000,
        source: Buffer.from(
          "From: lead@example.com\r\nMessage-ID: <reply@example.com>\r\nIn-Reply-To: <original@example.com>\r\nSubject: Reply\r\n\r\nYes",
        ),
      };
    },
  });
  const received = [];
  const cursor = await gateway.sync(
    { cursor: { validity: "1", uid: 1 } },
    (m) => received.push(m),
  );
  assert.equal(cursor.uid, 2);
  assert.equal(cursor.caughtUp, true);
  assert.deepEqual(received[0].references, ["<original@example.com>"]);
});
test("automatic replies are not human replies", async () => {
  const parsed = await simpleParser(
    "From: lead@example.com\r\nAuto-Submitted: auto-replied\r\n\r\nOut of office",
  );
  assert.equal(classify(parsed), "auto");
});
test("SMTP adapter generates threaded MIME with opt-out headers and escaped content", async () => {
  const g = new MailGateway(
    { campaign: () => ({ trackOpens: true }) },
    "https://outreach.example.com",
  );
  let raw;
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });
  g.transport = () => ({
    close() {},
    async sendMail(options) {
      raw = (await transport.sendMail(options)).message;
      return { accepted: ["lead@example.com"] };
    },
  });
  await g.send(
    { email: "sender@example.com", name: "Даниил" },
    {
      recipient: "lead@example.com",
      subject: "Привет",
      body: "<script>alert(1)</script>",
      message_id: "<step2@example.com>",
      parent: "<step1@example.com>",
      token: "a".repeat(48),
      kind: "campaign",
      campaign_id: "c",
    },
  );
  const p = await simpleParser(raw);
  assert.equal(p.messageId, "<step2@example.com>");
  assert.equal(p.inReplyTo, "<step1@example.com>");
  assert.match(p.text, /Отписаться:/);
  assert.match(p.html, /&lt;script&gt;/);
  assert.match(
    raw.toString(),
    /List-Unsubscribe-Post: List-Unsubscribe=One-Click/i,
  );
  assert.match(p.html, /\/open\//);
});
test("delivery status report is classified separately from a human response", async () => {
  const raw =
    'From: mailer-daemon@example.com\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nFailed\r\n--b\r\nContent-Type: message/delivery-status\r\n\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n--b--';
  assert.equal(classify(await simpleParser(raw)), "bounce");
});
