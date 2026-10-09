# Unisender implementation record

## Base and integration

- Base test branch: b82380fcb0b27bf9430aa0ad7423a9f018208c33.
- Existing outreach base: master 2e694f5f4cca4164bb4fee1ef5fa8262c4803abd.
- Phrase rotation: 606e7d39aa6fc32f0ab2c4259b6cd29f89b1ad1c (PR13).
- Full inbox: da90c3c8485e3376111c41bc2df94e4552415835 (PR14).
- Feature work: codex/unisender; requested PR target: test. Production is unchanged.
- Existing Dmailio password/session protects the marketing API; no new cabinets,
  organizations, tenant IDs or user roles.

## Storage and configuration

Outreach remains in its own SQLite file. Existing migrations run via Store and
FullInboxStore; rotation stores fixed recipient variants and full inbox stores
folder/message state. Marketing contact/subscription authority is listmonk and
its isolated PostgreSQL. The adapter owns document versions, operation IDs and
immutable run snapshots, separate from outreach queues.

Server-only listmonk URL/token and marketing secrets must never enter browser
responses. A missing service returns a controlled unavailable error, never a
successful empty contact list. No external email validator is required (#9).

## Checks and release

Node24 unit tests, a separate PostgreSQL/listmonk integration fixture, Playwright
browser scenarios and Docker build run in CI. A suite with no tests fails rather
than reporting success. No push/PR deploys production; this PR is for test only.
Use explicit test mailboxes/recipients. The selected transport is the user's own
connected mailbox, with shared provider limits (see transport.md). Sending is a
later stage; SMTP acceptance must never be presented as confirmed delivery.

Each stage is recorded with commands/results and limitations. Real-provider
acceptance and production release remain separate gates (#31/#32).

## Stage 01 evidence

Baseline Windows 102/102; integrated rotation/inbox 150/150; foundation unit
89/89, browser login/inbox 1/1, formatting PASS. Linux CI
[37907296414](https://github.com/perchik08/dmailio/actions/runs/37907296414)
passed PostgreSQL fixture, E2E and Docker image build on 07d05fa4.

## Marketing API foundation

All admin endpoints are under `/api/marketing/`, behind the existing Dmailio
session and mutation Origin check. Errors: `{code,message,fields,retryable}`.
GET `/status` checks the database and authenticated listmonk access; unavailable
configuration returns 503, not empty data. GET `/operations/:operationId` retrieves
an idempotent command result. SQL expressions are not accepted from the browser.

Configuration: `MARKETING_DATABASE_URL`, `LISTMONK_URL`, `LISTMONK_API_USER`,
`LISTMONK_API_TOKEN`, all server-only. Startup migrates only the `marketing`
PostgreSQL schema; failures leave outreach available and marketing unavailable.
Use a service token with only required list/subscriber permissions. A fixture-only
API identity in CI uses a dedicated disposable database, never production secrets.
Fixture image is pinned to listmonk v6.2.0 (official release verified 09.10.2026).

The schema contains immutable document versions, operation fingerprints/results,
external ID links, run and recipient snapshots, and event IDs. Database updates
use parameterized SQL. Optimistic updates return 409 on stale versions; equal
operation IDs with different inputs return 409. Take PostgreSQL backups with
`pg_dump` and restore to a separate database before switching configuration;
preserve listmonk public schema and marketing schema in the same backup.

## Contacts and lists

The existing login opens Contacts and Mailing Lists through hash routes; filters
survive a reload. Contact fields, custom variables, tags, source and marketing
permission are editable. Subscription state and provider blocks are preserved.
Lists support editing and reversible archival; membership removal does not delete
the subscriber. Server-side search, status/date/custom-field filters and sorting
are controlled expressions; arbitrary SQL from the browser is rejected.

Selection supports a page or the full filtered audience (10,000 per operation).
CSV/XLSX exports neutralize spreadsheet formula cells. List audience preview
deduplicates contacts and checks confirmed membership, permission and blocking.
No external address validator is required. Import mapping is implemented below;
delivery is a later stage, with no inactive send controls presented here.

Windows regression156/156, formatting and browser2/2 passed on 2a838bc0.
Linux CI [37909759367](https://github.com/perchik08/dmailio/actions/runs/37909759367)
passed real PostgreSQL/listmonk browser CRUD, reload, field search, XLSX export,
membership removal, regression and Docker build. Additional eligibility checks
on eeb59ad2 verify overlapping lists, disabled/blocked contacts and status filters.

## CSV / Excel import — #18

Upload CSV or XLSX (25 MB), select the Excel sheet, map columns to standard or
custom fields, choose lists, duplicate policy and whether to replace empty values.
Preview shows invalid emails and duplicates before starting. Import runs as a
resumable server job with a durable cursor and a downloadable row report. Retries
after a remote commit do not create duplicate subscribers. Updates preserve
blocklists, opt-outs and existing permission. XLS, XLSM and password-protected
workbooks are not accepted. No dependency on external validator #9.

Unit158/158 and real PostgreSQL/listmonk/browser CI
[37980174592](https://github.com/perchik08/dmailio/actions/runs/37980174592) passed.

## Letter library and editors — #19–#22

Letters have separate HTML, Markdown and versioned Waypoint JSON sources, an
editable title/subject/preheader, autosave, manual save, local recovery, copies,
archive and immutable versions. Conflicting tabs cannot overwrite newer changes.
The server compiles and sanitizes letters; client-provided compiled HTML is never
trusted. Variables (`{{firstName}}`), fallback (`{{firstName|коллега}}`) and rotation
(`{Привет|Здравствуйте}`) share the same renderer. Missing variables show an error.
Preview uses a sample or a selected contact, is sandboxed, blocks external images
by default and has an inert unsubscribe footer. Export uses the same rendering.

Images: PNG/JPEG/GIF/WebP, 2 MB each, 100 MB library; up to 300 latest assets in
the picker. Public image URLs work without admin sessions. HTTPS remote import
checks DNS and every redirect, pins a public IPv4 and bounds time/bytes; private
networks, credentials, arbitrary ports and SVG are rejected. Remote hosts that
only support IPv6 can be uploaded manually. Public URLs use DMAILIO_PUBLIC_URL.

The visual editor reuses Waypoint's document/store/block components with a
Dmailio palette and property controls. Content/Rows/Settings, 1/2/3/4/6-column
rows with ratios/mobile order, insert/drop at a chosen parent/column/index,
keyboard insertion and movement between parents, duplicate/move/delete,
undo/redo, width/colors/font/padding and image selection are wired to saved JSON.
The frame has an opaque sandbox origin and no access to the admin session; the
bridge checks source window, expected origin, nonce, channel and schema version.
The server validates the block graph, limits depth/count and independently
compiles supported blocks through the shared sanitization pipeline.

Additional blocks: tables (100×10), text-based social links/menu (20 links),
Unicode icons, raster stickers, GIF, linked video thumbnail and gallery (12 images).
Gallery uses a sequence of images, which remains readable without carousel
support. Video opens a link, with no embedded player. Broken/blocked images retain
alt text; GIF clients may show only their first frame. No paid BEE SDK is used.

Countdown: explicit ISO date with UTC offset; IANA timezone controls its label.
Public GIF endpoint computes remaining time on each load, animates the next
60 seconds once, then holds its last frame. After the deadline it shows zeros.
Clients/proxies may cache images: this is not an exact live clock in every inbox.
The endpoint caches 10-second buckets (100-entry bound), caps generation at 5/s
and total requests at 100/s per process, and returns 404 for invalid paths and
429 with Retry-After when busy.

### Build and verification

From `outreach/`, run `npm ci --ignore-scripts`, `npm run build:marketing:builder`,
`npm test`, `npm run format:check`, `npm run format:check:marketing`, then
`npm run test:marketing:e2e`. The builder command installs the existing locked
frontend dependencies and emits ignored assets into `public/marketing/builder-dist/`.
Build these before `docker build`; the Dockerfile fails if the bundle is absent.
Marketing CI also runs real PostgreSQL/listmonk integration/browser tests.
The dedicated builder UI tests use a controlled persistence fixture plus the real
renderer and public GIF endpoint; integration tests separately verify PostgreSQL
JSON/version persistence. Real provider delivery is outside this editor stage.

HTML/Markdown/images: unit161/161 and real-browser/database CI
[37982260421](https://github.com/perchik08/dmailio/actions/runs/37982260421) passed.
Builder checks and final branch review are recorded in PR #33 before acceptance.
These changes are not deployed to test or production by opening the draft PR.

### Final review corrections (09 October 2026)

A fresh-context review found six Important issues. The bounded repair pass adds:
validated responsive stylesheets and CSS zero/decimal spacing; escaped hidden
personalized preheaders; insert-only list memberships that respect consent and
existing opt-outs; separate video destination/thumbnail; column-aware insertion
and keyboard movement; durable per-tab drafts with unload warnings and editor
cleanup on navigation. No Critical issues were reported.

Local verification: 169/169 unit tests, 10/10 browser scenarios, builder build and
both formatting gates pass. Without local PostgreSQL, backend browser scenarios
exercise the unavailable state; dedicated builder/recovery scenarios use explicit
fixtures. GitHub Marketing CI verifies the real PostgreSQL/listmonk paths.

Scope ruling: attachments remain in the agreed backlog and are not implemented
by this import/editor delivery. Sending, scheduling and reports (stages09+) also
remain planned. The draft PR targets test; neither test nor production is deployed.
