# Mailbox connection and DKIM diagnosis — 2026-10-16

## Observed issue
New or reconnected Yandex corporate mailboxes could authenticate successfully over SMTP and IMAP but remained unverified in Dmailio. The warmup switch correctly rejected unverified credentials. The normal connection form saved settings and required a second manual verification click; a transient notice was the only explanation. A domain shared by two mailboxes showed inconsistent DKIM diagnostics because the first mailbox had a manually configured selector and the new one did not.

## Causes
1. Saving and verifying were separate steps, with no automatic check from the connection form.
2. Verification errors discarded the failing SMTP/IMAP stage and returned a generic message.
3. Automatic DKIM discovery checked default/google/selector1/selector2 but omitted Yandex's existing mail selector. DNS tests mostly supplied explicit selectors or returned a key for arbitrary names, so this realistic gap was not covered.
4. The UI described an unsuccessful selector search as a missing record that needed configuration. DNS cannot enumerate arbitrary DKIM selectors.

## Prevention shipped
- Default DKIM discovery includes mail; a regression covers two addresses on one domain without per-mailbox configuration.
- The connection form requests automatic SMTP/IMAP verification on every save, including reconnect and credential changes. A successful save unlocks warmup; a failed check preserves editable settings and a persistent error. API callers may opt in with verify:true; ordinary save semantics remain compatible.
- The form prevents duplicate submissions while checking. Warmup never starts automatically: owner confirmation is still required.
- Verification errors identify the failing protocol and distinguish authentication from network failures using error codes. Raw provider errors and credentials are never shown.
- Unknown DKIM selector wording explains the search limitation and points to the selector setting. DKIM discovery is separate from mailbox authentication and does not block warmup.

## Regression gates
Unit/API coverage: successful automatic check, failed IMAP check and retry, cursor initialization, disabled warmup, secret-safe errors, SMTP/IMAP attribution and client cleanup. Existing disconnect/revision race tests remain required. Browser coverage: normal connection, failure and correction, reload persistence, reconnect, and accurate DKIM unknown-selector wording. Production smoke uses read-only existing account/DNS checks; destructive tests use disposable staging fixtures.

A successful connection check proves protocol access at that time, not message delivery. A found DKIM key proves DNS publication, not signing of every outgoing message.
