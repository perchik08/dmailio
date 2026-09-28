# Campaign sequence delay rows

## Why

The first email has no previous email, so showing a disabled delay field in its editor is confusing. Delays describe the gap between messages and should be visible between their cards, matching the Trigga sequence model.

## What changes

- Remove the per-email delay field from the message editor.
- Show an editable “Отправить через [N] дня” row between each pair of email cards.
- Keep the first email free of a delay row; the delay attached to email N continues to mean the wait before email N.
- Preserve current defaults (3 days for newly added follow-up emails), limits (0–365 days), and persisted campaign format.

## Impact

Only the outreach campaign sequence editor changes. Existing campaigns keep their stored delays and delivery scheduling behavior.
