import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { classify } from "./mail.mjs";
import { renderContent } from "./content.mjs";
const MIME_LIMIT = 12_000_000;
const ATTACHMENT_LIMIT = 8_000_000;
const FOLDER_BATCH = 20;
const MESSAGE_BATCH = 200;
const pathOf = (f) => String(f.path || f.name || "");
const selectable = (f) =>
  pathOf(f) && !Array.from(f.flags || []).includes("\\Noselect");
const outgoingFolder = (f) =>
  ["\\Sent", "\\Drafts"].includes(f.specialUse) ||
  /^(sent|sent items|sent mail|drafts|отправленные|черновики)$/i.test(
    pathOf(f),
  );
const addresses = (value) =>
  (value?.value || []).map((a) => a.address).filter(Boolean);
const errorText = (error) => String(error?.message || error).slice(0, 500);
export async function initializeFullInbox(c, now = Date.now()) {
  const folders = Object.create(null),
    errors = [];
  for (const folder of (await c.list()).filter(selectable)) {
    const path = pathOf(folder);
    let lock;
    try {
      lock = await c.getMailboxLock(path);
      folders[path] = {
        validity: String(c.mailbox.uidValidity),
        // Starting at zero preserves mail arriving during verification. The
        // timestamp baseline filters old messages during bounded background scans.
        uid: 0,
        caughtUp: Number(c.mailbox.uidNext || 1) <= 1,
      };
    } catch (e) {
      errors.push({ folder: path, error: errorText(e) });
    } finally {
      lock?.release();
    }
  }
  const inbox = folders.INBOX || {};
  return {
    ...inbox,
    since: now,
    folders,
    errors,
    caughtUp:
      errors.length === 0 && Object.values(folders).every((f) => f.caughtUp),
  };
}
export async function syncFullInbox(gateway, m, onMessage) {
  let c;
  const prior = m.cursor || {};
  const cursor = {
    since: Number(prior.since) || Date.now(),
    folders: Object.assign(Object.create(null), prior.folders || {}),
    errors: [],
    warnings: [...(prior.warnings || [])],
    nextFolder: Number(prior.nextFolder) || 0,
    caughtUp: false,
  };
  if (!prior.since)
    cursor.warnings.push(
      "Full inbox baseline begins at rollout; earlier messages are excluded.",
    );
  try {
    c = gateway.imap(m);
    await c.connect();
    const folders = (await c.list()).filter(selectable),
      paths = new Set(folders.map(pathOf));
    for (const path of Object.keys(cursor.folders))
      if (!paths.has(path))
        cursor.errors.push({
          folder: path,
          error: "Previously accessible folder is missing",
        });
    const start = cursor.nextFolder % Math.max(1, folders.length),
      count = Math.min(FOLDER_BATCH, folders.length);
    for (let index = 0; index < count; index++) {
      const folder = folders[(start + index) % folders.length],
        path = pathOf(folder);
      let lock;
      try {
        lock = await c.getMailboxLock(path);
        const validity = String(c.mailbox.uidValidity),
          max = Math.max(0, Number(c.mailbox.uidNext || 1) - 1);
        const previous = Object.hasOwn(cursor.folders, path)
          ? cursor.folders[path]
          : {};
        const current = {
          validity,
          uid: previous.validity === validity ? Number(previous.uid || 0) : 0,
          caughtUp: true,
          refreshUid:
            previous.validity === validity
              ? Number(previous.refreshUid || 0)
              : 0,
        };
        cursor.folders[path] = current;
        if (outgoingFolder(folder)) {
          current.uid = max;
          continue;
        }
        let fetched = 0;
        if (current.uid < max) {
          const endUid = Math.min(max, current.uid + MESSAGE_BATCH);
          for await (const msg of c.fetch(
            `${current.uid + 1}:${endUid}`,
            {
              source: { maxLength: MIME_LIMIT },
              size: true,
              internalDate: true,
              flags: true,
              emailId: true,
            },
            { uid: true },
          )) {
            const internalDate = new Date(msg.internalDate).getTime();
            if (!Number.isFinite(internalDate))
              throw Error(
                "Provider returned no INTERNALDATE; baseline cannot be verified",
              );
            if (internalDate >= cursor.since) {
              const source = Buffer.from(msg.source || []).subarray(
                0,
                MIME_LIMIT,
              );
              const p = await simpleParser(source, {
                skipHtmlToText: false,
                skipTextToHtml: true,
                skipImageLinks: true,
              });
              const references = [
                p.inReplyTo,
                ...(Array.isArray(p.references)
                  ? [...p.references].reverse()
                  : p.references
                    ? [p.references]
                    : []),
              ].filter(Boolean);
              const type = classify(p);
              if (type === "bounce")
                for (const a of p.attachments || [])
                  if (
                    ["message/rfc822", "text/rfc822-headers"].includes(
                      a.contentType,
                    )
                  ) {
                    const match = a.content
                      .toString()
                      .match(/^Message-ID:\s*(<[^>]+>)/im);
                    if (match) references.unshift(match[1]);
                  }
              let attachmentBytes = 0,
                partial = Number(msg.size) > MIME_LIMIT;
              const attachments = [];
              for (const a of p.attachments || []) {
                if (
                  attachments.length >= 20 ||
                  attachmentBytes + a.content.length > ATTACHMENT_LIMIT
                ) {
                  partial = true;
                  continue;
                }
                attachmentBytes += a.content.length;
                attachments.push({
                  name: a.filename || "attachment",
                  type: a.contentType || "application/octet-stream",
                  data: a.content,
                });
              }
              const identity = msg.emailId
                ? `provider:${msg.emailId}`
                : `sha256:${createHash("sha256")
                    .update(source)
                    .update(`\n${internalDate}\n${msg.size || source.length}`)
                    .digest("hex")}`;
              await onMessage({
                remoteId: `${path}:${validity}:${msg.uid}`,
                folder: path,
                validity,
                uid: msg.uid,
                identity,
                messageId: p.messageId,
                references,
                from: addresses(p.from)[0] || "",
                to: addresses(p.to),
                cc: addresses(p.cc),
                replyTo: addresses(p.replyTo),
                subject: p.subject || "",
                text:
                  (p.text || "").slice(0, 200000) +
                  (partial
                    ? "\n\n[Large message processed partially; full content remains in the mailbox.]"
                    : ""),
                html: typeof p.html === "string" ? p.html.slice(0, 200000) : "",
                internalDate,
                flags: Array.from(msg.flags || []),
                type,
                attachments,
                partial,
              });
            }
            current.uid = Number(msg.uid);
            fetched++;
            if (fetched >= MESSAGE_BATCH) break;
          }
          if (fetched < MESSAGE_BATCH) current.uid = endUid;
        }
        current.caughtUp = current.uid >= max;
        const store = gateway.store.fullInbox;
        if (store?.locations) {
          const locations = store.locations(m.id, path, {
            afterUid: current.refreshUid,
            limit: MESSAGE_BATCH,
          });
          for (const staleValidity of new Set(
            locations
              .filter((l) => l.validity !== validity)
              .map((l) => l.validity),
          ))
            store.removeLocations?.(
              m.id,
              path,
              staleValidity,
              locations
                .filter((l) => l.validity === staleValidity)
                .map((l) => l.uid),
            );
          const batch = locations.filter((l) => l.validity === validity);
          if (batch.length) {
            const observed = new Set();
            for await (const msg of c.fetch(
              batch.map((l) => l.uid).join(","),
              { flags: true },
              { uid: true },
            )) {
              observed.add(Number(msg.uid));
              store.updateLocationFlags?.(
                m.id,
                path,
                validity,
                msg.uid,
                Array.from(msg.flags || []),
              );
            }
            store.removeLocations?.(
              m.id,
              path,
              validity,
              batch.filter((l) => !observed.has(l.uid)).map((l) => l.uid),
            );
            current.refreshUid = batch.at(-1).uid;
          }
          current.refreshUid = locations.length ? locations.at(-1).uid : 0;
        }
      } catch (e) {
        cursor.errors.push({ folder: path, error: errorText(e) });
        if (Object.hasOwn(cursor.folders, path))
          cursor.folders[path].caughtUp = false;
      } finally {
        lock?.release();
      }
    }
    cursor.nextFolder = folders.length ? (start + count) % folders.length : 0;
    cursor.caughtUp =
      cursor.errors.length === 0 &&
      folders.every(
        (f) =>
          Object.hasOwn(cursor.folders, pathOf(f)) &&
          cursor.folders[pathOf(f)].caughtUp,
      );
  } catch (e) {
    cursor.errors.push({ folder: "", error: errorText(e) });
  } finally {
    try {
      c?.close();
    } catch (e) {
      cursor.errors.push({ folder: "", error: errorText(e) });
      cursor.caughtUp = false;
    }
  }
  const inbox = cursor.folders.INBOX;
  if (inbox) {
    cursor.uid = inbox.uid;
    cursor.validity = inbox.validity;
  }
  return cursor;
}
export async function updateFullMessage(gateway, m, locations, action) {
  if (!locations.length) throw Error("Message has no remote locations");
  const c = gateway.imap(m);
  let result = {};
  try {
    await c.connect();
    const move = typeof action === "string" ? action : action.action;
    let destination;
    let sources = locations;
    if (move) {
      const special = {
        archive: "\\Archive",
        trash: "\\Trash",
        spam: "\\Junk",
      }[move];
      if (!special) throw Error("Invalid remote action");
      const folders = (await c.list()).filter(selectable);
      destination = pathOf(
        folders.find((f) => f.specialUse === special) ||
          (move === "archive"
            ? folders.find((f) => f.specialUse === "\\All")
            : null) ||
          {},
      );
      if (!destination) throw Error(`Provider has no ${move} folder`);
      sources = locations.filter((l) => l.folder !== destination);
      const inboxPaths = new Set(
        folders
          .filter(
            (f) =>
              f.specialUse === "\\Inbox" || pathOf(f).toUpperCase() === "INBOX",
          )
          .map(pathOf),
      );
      const allPaths = new Set(
        folders.filter((f) => f.specialUse === "\\All").map(pathOf),
      );
      const inboxSources = sources.filter((l) => inboxPaths.has(l.folder));
      if (move === "archive" && inboxSources.length) sources = inboxSources;
      else if (sources.some((l) => !allPaths.has(l.folder)))
        sources = sources.filter((l) => !allPaths.has(l.folder));
      sources.sort(
        (a, b) =>
          Number(inboxPaths.has(b.folder)) - Number(inboxPaths.has(a.folder)),
      );
      result = { folder: destination, moves: [] };
    }
    // Validate every location before any mutation.
    for (const location of locations) {
      const lock = await c.getMailboxLock(location.folder);
      try {
        if (String(c.mailbox.uidValidity) !== String(location.validity))
          throw Error("UIDVALIDITY changed; sync the mailbox before acting");
      } finally {
        lock.release();
      }
    }
    for (const location of sources) {
      const lock = await c.getMailboxLock(location.folder);
      try {
        if (String(c.mailbox.uidValidity) !== String(location.validity))
          throw Error("UIDVALIDITY changed; sync the mailbox before acting");
        if (destination) {
          const moved = await c.messageMove(location.uid, destination, {
            uid: true,
          });
          if (!moved) throw Error("Remote move failed");
          const relocation = {
            folder: destination,
            oldFolder: location.folder,
            validity: moved.uidValidity ? String(moved.uidValidity) : undefined,
            uid: moved.uidMap?.get(location.uid),
          };
          result.moves.push(relocation);
          if (result.moves.length === 1) Object.assign(result, relocation);
          continue;
        }
        for (const [key, flag] of [
          ["read", "\\Seen"],
          ["starred", "\\Flagged"],
        ])
          if (typeof action[key] === "boolean") {
            const done = await c[
              action[key] ? "messageFlagsAdd" : "messageFlagsRemove"
            ](location.uid, [flag], { uid: true });
            if (done === false) throw Error("Remote flags update failed");
          }
      } finally {
        lock.release();
      }
    }
    return result;
  } finally {
    c.close();
  }
}
export async function sendFullMessage(gateway, m, message) {
  const outgoing = gateway.store.fullInbox.outgoing(message.id);
  const formatted = renderContent(
    message,
    (id) => gateway.store.image(id),
    true,
  );
  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });
  const compiled = await composer.sendMail({
    from: {
      name: [m.name, m.surname].filter(Boolean).join(" "),
      address: m.email,
    },
    to: outgoing.to,
    cc: outgoing.cc,
    subject: message.subject,
    text: formatted.text,
    html: formatted.html,
    attachments: [
      ...formatted.attachments,
      ...(outgoing.attachments || []).map((a) => ({
        filename: a.name,
        contentType: a.type,
        content: a.data,
      })),
    ],
    messageId: message.message_id,
    inReplyTo: outgoing.inReplyTo || message.parent || undefined,
    references: outgoing.references,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const transport = gateway.transport(m);
  let deliveryWarning = null;
  try {
    const result = await transport.sendMail({
      raw: compiled.message,
      envelope: {
        from: m.email,
        to: [...outgoing.to, ...(outgoing.cc || []), ...(outgoing.bcc || [])],
      },
    });
    if (!result.accepted?.length) {
      const e = new Error("Rejected");
      e.definitive = true;
      throw e;
    }
    if (result.rejected?.length)
      deliveryWarning = `SMTP accepted delivery for ${result.accepted.length} recipient(s); rejected recipients: ${result.rejected.join(", ")}`;
  } catch (e) {
    if (
      ["EAUTH", "EENVELOPE"].includes(e.code) ||
      Number(e.responseCode) >= 400
    )
      e.definitive = true;
    throw e;
  } finally {
    transport.close();
  }
  if (deliveryWarning) {
    try {
      gateway.store.fullInbox.recordDeliveryWarning?.(
        message.id,
        deliveryWarning,
      );
    } catch {
      /* Accepted delivery must not become unknown when metadata cannot be saved. */
    }
  }
  // SMTP acceptance is final. A failed provider copy must never trigger SMTP retry.
  let c;
  let warning = null;
  try {
    c = gateway.imap(m);
    await c.connect();
    const folders = (await c.list()).filter(selectable);
    const sent =
      folders.find((f) => f.specialUse === "\\Sent") ||
      folders.find((f) =>
        /^(sent|sent items|sent mail|отправленные)$/i.test(pathOf(f)),
      );
    if (!sent) throw Error("Provider has no Sent folder");
    let alreadyCopied = false;
    if (c.search && message.message_id) {
      const lock = await c.getMailboxLock(pathOf(sent));
      try {
        alreadyCopied =
          (
            await c.search(
              { header: { "Message-ID": message.message_id } },
              { uid: true },
            )
          ).length > 0;
      } finally {
        lock.release();
      }
    }
    if (!alreadyCopied) {
      const appended = await c.append(
        pathOf(sent),
        compiled.message,
        ["\\Seen"],
        new Date(),
      );
      if (appended === false) throw Error("Sent APPEND failed");
    }
  } catch (e) {
    warning = errorText(e);
  } finally {
    try {
      c?.close();
    } catch (e) {
      warning ||= errorText(e);
    }
  }
  try {
    gateway.store.fullInbox.recordSentCopy(message.id, warning);
  } catch {
    /* Delivery remains accepted even when warning persistence fails. */
  }
}
