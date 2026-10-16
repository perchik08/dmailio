# Mailbox disconnect

The Mailboxes page offers Disconnect with confirmation. The connection disappears from the Mailboxes page and its counters; reconnect is available through the ordinary Connect mailbox dialog. Internally its disconnected identity remains to preserve history; mailbox identity, inbox history, campaigns, drafts, attachments and delivery records remain intact. Provider accounts and remote messages are never deleted by this action.

The authenticated, same-origin POST /api/mailboxes/:id/disconnect atomically disables the mailbox and warmup consent, removes both encrypted application passwords, revokes marketing permission/default sender and pauses active campaigns referencing this mailbox. Repeated disconnect is idempotent.

Provider operations acquire shared SQLite leases before starting. While an operation is running the endpoint returns 409 MAILBOX_BUSY and makes no changes; the user waits for completion and retries. Already accepted SMTP messages cannot be recalled. Leases expire after 90 seconds and renew every 15 seconds. Lost leases close local clients; generation checks reject stale work. Saves and completion guards hold a write transaction to prevent reconnect races.

Reconnect reuses the same identity/address/history, requires both application passwords, resets the synchronization cursor, and requires a new connection verification. Warmup, marketing permission and paused campaigns require explicit reactivation. Existing quota/history is retained.

Disconnected history allows local read/star updates and attachment download; provider moves and replies are disabled. New compose sender lists exclude disconnected mailboxes.

Verification: unit coverage includes secret erasure, preserved history, active I/O, cross-connection write locking, stale completions, worker exclusion, login/origin protection and historical inbox actions. Browser coverage checks cancellation/confirmation, reload persistence and reconnect with required passwords. Use disposable mailboxes only for destructive disconnect testing; production smoke checks UI without disconnecting user mailboxes.
