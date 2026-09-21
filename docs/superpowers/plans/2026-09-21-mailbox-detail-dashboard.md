# Mailbox Detail Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-data mailbox detail screen with warmup analytics, DNS diagnostics, editable mailbox settings, custom warmup controls, and a reset to Dmailio defaults.

**Architecture:** Keep the existing single-process Node.js application and SQLite store. Add a focused DNS service, additive placement-event storage, per-folder IMAP inspection for Dmailio warmup messages, authenticated mailbox-detail endpoints, and one SPA detail view with three tabs. Preserve the current mailbox list and use its address button as the entry point.

**Tech Stack:** Node.js 24, `node:sqlite`, `node:dns/promises`, ImapFlow, vanilla JavaScript/CSS, Node test runner, Prettier.

**Spec:** `docs/superpowers/specs/2026-09-21-mailbox-detail-dashboard-design.md`

## Global Constraints

- All statistics must come from stored events; empty states show zero or «Нет данных».
- Automatic warmup defaults remain `2 / +1 / 10` over 14 active days.
- Resetting warmup settings must preserve history, active day, and readiness score.
- Only Dmailio warmup messages identified by `Message-ID` may be classified or moved; unrelated personal mail must not be persisted or changed.
- SMTP acceptance must not be presented as inbox placement.
- DNS checks are read-only and remain separate from the existing technical health score.
- Existing authentication, same-origin checks, credential encryption, and additive database migration behavior must remain intact.

## File Structure

- Create `outreach/dns.mjs`: bounded MX/SPF/DMARC/DKIM lookup and normalized results.
- Create `outreach/test/dns.test.mjs`: deterministic DNS tests with an injected resolver.
- Modify `outreach/store.mjs`: warmup configuration, mailbox profile updates, placement events, and mailbox-detail aggregation.
- Modify `outreach/mail.mjs`: discover relevant IMAP folders and inspect/move only known warmup messages.
- Modify `outreach/worker.mjs`: feed placement observations into the store without blocking campaign delivery on unsupported folders.
- Modify `outreach/server.mjs`: authenticated detail, DNS, and settings routes.
- Modify `outreach/public/app.js`: detail-page navigation, three tabs, forms, chart, and provider bars.
- Modify `outreach/public/style.css`: responsive mailbox-detail layout matching the supplied screenshots.
- Modify `outreach/test/store.test.mjs`, `outreach/test/mail.test.mjs`, `outreach/test/worker.test.mjs`, and `outreach/test/server.test.mjs`: behavior coverage.
- Modify `outreach/README.md` and `design-qa.md`: operator documentation and visual evidence.

## Review Focus

- A DNS timeout or malformed TXT record returns a per-record error while other DNS cards still load; Task 1 tests partial failure.
- A mailbox profile-only save keeps verification and encrypted credentials unchanged; Task 2 tests both properties.
- Repeated scans of the same IMAP message do not inflate placement or rescued counts; Task 3 tests uniqueness.
- An unrelated message in Junk is never stored or moved; Task 4 tests the `Message-ID` allowlist.
- Resetting a custom warmup while paused preserves `since`, prior messages, program day, and score; Task 2 tests the complete reset state.

---

### Task 1: DNS diagnostics service

**Files:**
- Create: `outreach/dns.mjs`
- Create: `outreach/test/dns.test.mjs`

**Interfaces:**
- Consumes: resolver methods `resolveMx(name)` and `resolveTxt(name)` compatible with `node:dns/promises`.
- Produces: `checkDomainDNS(emailAddress, options?) -> Promise<{domain, checkedAt, mx, spf, dmarc, dkim}>` where every record is `{status, values, error}`.

- [ ] **Step 1: Write failing tests for complete and partial DNS results**

```js
test("DNS diagnostics normalize MX, SPF, DMARC and DKIM", async () => {
  const resolver = {
    resolveMx: async () => [{ priority: 10, exchange: "mx.example.com" }],
    resolveTxt: async (name) =>
      name === "example.com"
        ? [["v=spf1 include:_spf.example.com -all"]]
        : name === "_dmarc.example.com"
          ? [["v=DMARC1; p=quarantine"]]
          : [["v=DKIM1; k=rsa; p=abc"]],
  };
  const result = await checkDomainDNS("sender@example.com", {
    resolver,
    selectors: ["default"],
    now: () => 123,
  });
  assert.equal(result.mx.status, "ok");
  assert.equal(result.spf.status, "ok");
  assert.equal(result.dmarc.status, "ok");
  assert.equal(result.dkim.selector, "default");
  assert.equal(result.checkedAt, 123);
});

test("one failed DNS lookup does not hide successful records", async () => {
  const resolver = {
    resolveMx: async () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    },
    resolveTxt: async (name) =>
      name === "example.com" ? [["v=spf1 -all"]] : [],
  };
  const result = await checkDomainDNS("sender@example.com", { resolver });
  assert.equal(result.mx.status, "unavailable");
  assert.equal(result.spf.status, "ok");
  assert.equal(result.dmarc.status, "missing");
});
```

- [ ] **Step 2: Run `node --test test/dns.test.mjs` and verify it fails because `dns.mjs` does not exist**

- [ ] **Step 3: Implement bounded independent lookups**

Use `Promise.all` over independently caught lookups, flatten TXT chunks with `row.join("")`, accept only SPF/DMARC/DKIM records with the correct version prefix, cap rendered values at 20 entries and 4,000 characters, and wrap the whole operation in a 10-second timeout. Try the saved selector first, followed by provider defaults without duplicates.

- [ ] **Step 4: Run `node --test test/dns.test.mjs` and verify both tests pass**

- [ ] **Step 5: Commit**

```bash
git add outreach/dns.mjs outreach/test/dns.test.mjs
git commit -m "Add mailbox DNS diagnostics"
```

### Task 2: Mailbox profile and configurable warmup

**Files:**
- Modify: `outreach/store.mjs`
- Modify: `outreach/test/store.test.mjs`

**Interfaces:**
- Produces: `saveMailboxSettings(id, {name, surname, limit, dkimSelector})`.
- Produces: `warmup(id, {enabled, consent, mode, start, increase, max, providers, reset}, now)`.
- Preserves: existing `since`, `pausedAt`, message history, verification, and encrypted secrets for profile-only changes.

- [ ] **Step 1: Write failing profile preservation and warmup reset tests**

```js
test("mailbox profile save keeps verified connection and secrets", () => {
  const s = new Store(":memory:", "a".repeat(64));
  const m = s.saveMailbox(mailbox);
  s.markMailbox(m.id, true);
  const before = s.mailbox(m.id, true);
  const saved = s.saveMailboxSettings(m.id, {
    name: "Анна",
    surname: "Иванова",
    limit: 30,
    dkimSelector: "mail",
  });
  assert.equal(saved.verified, true);
  assert.equal(saved.limit, 30);
  assert.equal(s.mailbox(m.id, true).smtp.password, before.smtp.password);
});

test("warmup reset restores automatic plan without losing history", () => {
  const s = new Store(":memory:", "a".repeat(64));
  const m = s.saveMailbox(mailbox);
  s.markMailbox(m.id, true);
  s.warmup(m.id, {
    enabled: true,
    consent: true,
    mode: "custom",
    start: 4,
    increase: 2,
    max: 20,
    providers: ["google"],
  }, 1000);
  const reset = s.warmup(m.id, { reset: true, enabled: true, consent: true }, 2000);
  assert.deepEqual(
    { mode: reset.warmup.mode, start: reset.warmup.start, increase: reset.warmup.increase, max: reset.warmup.max },
    { mode: "automatic-v1", start: 2, increase: 1, max: 10 },
  );
  assert.equal(reset.warmup.since, 1000);
});
```

- [ ] **Step 2: Run the two named tests and verify expected missing-method/custom-config failures**

- [ ] **Step 3: Implement validated profile saves and warmup modes**

Default `providers` to `['google','yandex','mailru','other']`. Validate unique known provider IDs, integers from 1 to 100, and `start <= max`. Replace the fixed plan in overview and reservation with `warmupTargets(warmup)`, returning 14 values from either automatic defaults or the custom formula. A reset changes configuration only.

- [ ] **Step 4: Add and pass a test that reset while paused preserves the same program day and readiness score**

- [ ] **Step 5: Run `node --test test/store.test.mjs`**

- [ ] **Step 6: Commit**

```bash
git add outreach/store.mjs outreach/test/store.test.mjs
git commit -m "Add configurable mailbox warmup settings"
```

### Task 3: Placement events and mailbox detail aggregation

**Files:**
- Modify: `outreach/store.mjs`
- Modify: `outreach/test/store.test.mjs`

**Interfaces:**
- Produces: `recordPlacement(mailboxId, {messageId, provider, placement, folder, observedAt, rescuedAt})`.
- Produces: `mailboxDetail(id, now) -> {mailbox, summary, activity, providers}`.
- Produces: `placementCursor(mailboxId, folder) -> {validity, uid}` and `savePlacementCursor(mailboxId, folder, cursor)`.
- Adds table `warmup_placement` with unique `(mailbox_id, message_id, placement)` and table `warmup_folder_cursor` with primary key `(mailbox_id, folder)`.

- [ ] **Step 1: Write a failing additive migration/idempotency test**

```js
test("placement observations are idempotent and preserve rescued time", () => {
  const s = new Store(":memory:", "a".repeat(64));
  const m = s.saveMailbox(mailbox);
  const event = {
    messageId: "<warmup@example.com>",
    provider: "google",
    placement: "spam",
    folder: "[Gmail]/Spam",
    observedAt: 1000,
    rescuedAt: 1100,
  };
  s.recordPlacement(m.id, event);
  s.recordPlacement(m.id, { ...event, observedAt: 1200, rescuedAt: 1300 });
  const rows = s.db.prepare("SELECT * FROM warmup_placement").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rescued_at, 1100);
});
```

- [ ] **Step 2: Run the named test and verify failure because the table/method is absent**

- [ ] **Step 3: Add both tables and implement normalized placement writes**

Allow only `inbox`, `spam`, `promotions`, and `unknown`; allow only known provider IDs; truncate folder to 500 characters; ignore updates that would replace an earlier `rescued_at`.

- [ ] **Step 4: Add and pass a cursor test**

Save independent cursors for `INBOX` and `Junk`, reopen the store, and assert both cursors survive while the existing mailbox `cursor` JSON remains unchanged. Reset a folder cursor to UID zero when its UID validity changes.

- [ ] **Step 5: Write failing aggregation tests with messages and placements across two days/providers**

Assert that `activity` always contains 30 ordered UTC dates, provider totals equal stored events, empty providers are omitted, sent SMTP messages do not increment inbox placement, and repeated events do not inflate counts.

- [ ] **Step 6: Implement `mailboxDetail` with SQL grouping and pass the aggregation tests**

- [ ] **Step 7: Run `node --test test/store.test.mjs` and commit**

```bash
git add outreach/store.mjs outreach/test/store.test.mjs
git commit -m "Store warmup placement analytics"
```

### Task 4: Safe IMAP placement inspection

**Files:**
- Modify: `outreach/mail.mjs`
- Modify: `outreach/worker.mjs`
- Modify: `outreach/test/mail.test.mjs`
- Modify: `outreach/test/worker.test.mjs`

**Interfaces:**
- Produces: `MailGateway.inspectWarmupPlacement(mailbox, knownMessageIds, onPlacement)`.
- Consumes: `knownMessageIds` as a `Set<string>` returned by `Store.pendingPlacementMessageIds(mailboxId)`.
- Consumes: `Store.placementCursor(mailboxId, folder)` and `Store.savePlacementCursor(mailboxId, folder, cursor)` for independent per-folder progress.
- Calls: `onPlacement({messageId, provider, placement, folder, observedAt, rescuedAt})` only for allowlisted IDs.

- [ ] **Step 1: Write a failing mail test with a fake IMAP client**

The fake client lists `INBOX` and a `\\Junk` folder, yields one known and one unrelated `Message-ID`, and records calls to `messageMove`. Assert that the known warmup message reports `spam` and moves to `INBOX`, while the unrelated message produces no event and no move.

- [ ] **Step 2: Run the named mail test and verify failure because inspection is absent**

- [ ] **Step 3: Implement folder discovery and bounded inspection**

Inspect `INBOX`, `\\Junk`, and Gmail category folders/labels when advertised. Fetch headers plus labels for at most 200 new candidates per folder. Normalize folders with a pure helper. Move only an allowlisted warmup message from `\\Junk` to `INBOX`; report `rescuedAt` only after a successful move. Close locks and connections in `finally` blocks.

- [ ] **Step 4: Add tests for unsupported special-use folders and failed moves**

Assert unsupported providers return no observations without failing ordinary INBOX sync, and a move failure records `spam` without `rescuedAt`.

- [ ] **Step 5: Add a worker test proving placement inspection failures do not block campaign delivery**

- [ ] **Step 6: Implement worker integration and per-folder cursors, then run mail and worker tests**

- [ ] **Step 7: Commit**

```bash
git add outreach/mail.mjs outreach/worker.mjs outreach/test/mail.test.mjs outreach/test/worker.test.mjs
git commit -m "Track warmup inbox placement safely"
```

### Task 5: Authenticated mailbox detail API

**Files:**
- Modify: `outreach/server.mjs`
- Modify: `outreach/test/server.test.mjs`

**Interfaces:**
- Consumes: `checkDomainDNS`, `store.mailboxDetail`, `store.saveMailboxSettings`, and extended `store.warmup`.
- Produces routes from the approved spec.

- [ ] **Step 1: Write failing route tests after authenticated login**

Cover successful detail retrieval, 404-style validation for an unknown mailbox, same-origin rejection on settings writes, profile save preservation, DNS partial results through an injected checker, custom warmup save, and reset.

- [ ] **Step 2: Run `node --test test/server.test.mjs` and verify route-not-found assertions fail**

- [ ] **Step 3: Add `dnsChecker = checkDomainDNS` dependency injection to `createApp` and implement exact routes**

Use these paths:

```text
GET  /api/mailboxes/:id/detail
GET  /api/mailboxes/:id/dns
POST /api/mailboxes/:id/settings
POST /api/mailboxes/:id/warmup
POST /api/mailboxes/:id/signature
```

Derive the DNS domain from the stored mailbox, pass its saved selector, and never accept an arbitrary lookup domain from the client.

- [ ] **Step 4: Run `node --test test/server.test.mjs` and the full `npm test` suite**

- [ ] **Step 5: Commit**

```bash
git add outreach/server.mjs outreach/test/server.test.mjs
git commit -m "Expose mailbox detail and DNS APIs"
```

### Task 6: Three-tab mailbox detail interface

**Files:**
- Modify: `outreach/public/app.js`
- Modify: `outreach/public/style.css`

**Interfaces:**
- Consumes: the Task 5 JSON endpoints.
- Produces: `mailboxDetail(id)`, `mailboxStatsTab(detail)`, `mailboxDnsTab(detail)`, and `mailboxSettingsTab(detail)` render flows.

- [ ] **Step 1: Change the mailbox address action to open detail state**

Add `mailboxDetailId` and `mailboxDetailTab` to SPA state. Keep «Почты» active in the sidebar, provide «← Все почты», and restore the list without refetching unrelated campaign detail.

- [ ] **Step 2: Implement the statistics tab from real response fields**

Render progress, health, sent, replies, rescued count, a CSS/SVG-free HTML bar chart using ordinary semantic elements, provider stacked bars, explicit zeros, and «Пока нет данных». Use existing Dmailio colors and the supplied screenshot hierarchy; use the existing icon treatment or text labels rather than handcrafted SVG.

- [ ] **Step 3: Implement DNS cards and reload behavior**

Show independent status badges, values, errors, last-check time, and a «Проверить заново» button with disabled/loading state. Long TXT values wrap without widening the page.

- [ ] **Step 4: Implement settings forms**

The main form saves name, surname, daily campaign limit, and DKIM selector. Mount the existing Markdown signature editor inline. The warmup panel starts collapsed in automatic mode, displays the approved warning, validates custom values before POST, and exposes «Вернуть автоматические настройки» with an inline confirmation panel.

- [ ] **Step 5: Add responsive styles**

At desktop widths use the screenshot's tab row, card grid, two-column DNS grid, and two-column settings form. Below 900px use one column, horizontally scroll only provider details, keep primary actions visible, and ensure keyboard focus states are present.

- [ ] **Step 6: Run `npm run format:check`, `node --check public/app.js`, and `git diff --check`**

- [ ] **Step 7: Commit**

```bash
git add outreach/public/app.js outreach/public/style.css
git commit -m "Add mailbox detail dashboard"
```

### Task 7: Documentation, browser QA, and branch verification

**Files:**
- Modify: `outreach/README.md`
- Modify: `design-qa.md`

**Interfaces:**
- Consumes: completed Tasks 1–6.
- Produces: reviewable documentation, visual evidence, and a clean tested branch.

- [ ] **Step 1: Document the detail screen and metric limitations**

Explain health versus warmup, real placement collection, provider-dependent Promotions support, DNS read-only behavior, automatic/custom modes, and reset semantics.

- [ ] **Step 2: Run complete automated verification**

```bash
cd outreach
npm test
npm run format:check
node --check public/app.js
cd ..
git diff --check
```

Expected: all tests pass, Prettier reports all files formatted, syntax check exits zero, and diff check prints nothing.

- [ ] **Step 3: Restart the local service and verify the primary flow in the browser**

Open `http://localhost:9100/`, authenticate, open «Почты», click a mailbox, visit all three tabs, exercise DNS refresh, save profile fields, switch to custom warmup, reset to automatic, and verify the list reflects saved values. Do not send real mail during UI QA.

- [ ] **Step 4: Perform design QA against all three supplied screenshots**

Capture the same desktop state for each tab plus one narrow viewport. Update `design-qa.md` with evidence, P0–P3 findings, fixes, and `final result: passed`. Fix every P0/P1/P2 issue and repeat the affected capture.

- [ ] **Step 5: Request whole-branch code review and resolve Critical/Important findings**

- [ ] **Step 6: Repeat Step 2 after review fixes**

- [ ] **Step 7: Commit documentation and QA evidence**

```bash
git add outreach/README.md design-qa.md
git commit -m "Document mailbox diagnostics dashboard"
```

- [ ] **Step 8: Push `codex/outreach` so the existing pull request updates**
