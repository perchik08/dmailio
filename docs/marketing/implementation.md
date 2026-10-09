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
Use explicit test mailboxes/recipients. A mass-mail provider has not yet been
selected; do not enable mass sends or treat SMTP acceptance as delivery.

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
No external address validator is required. Import mapping and delivery are later
stages; no inactive import or send controls are presented in this stage.

Windows regression156/156, formatting and browser2/2 passed on 2a838bc0.
Linux CI [37909759367](https://github.com/perchik08/dmailio/actions/runs/37909759367)
passed real PostgreSQL/listmonk browser CRUD, reload, field search, XLSX export,
membership removal, regression and Docker build. Additional eligibility checks
on eeb59ad2 verify overlapping lists, disabled/blocked contacts and status filters.
