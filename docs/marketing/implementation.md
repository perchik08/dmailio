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
