# Design: campaign sequence delay rows

The sequence sidebar will render each email as a selectable card. Before every email after the first, it will render a compact delay row with a numeric input and Russian day label. The value belongs to that following email (`steps[index].delay`), preserving the existing API and scheduler semantics. The email editor will only contain subject and body fields.

Delay inputs are enabled only for editable drafts, use the existing 0–365 range, and update the in-memory step when edited. Switching emails or tabs and saving the campaign will retain the value. Adding an email keeps the current 3-day default; deleting an email naturally removes the delay preceding that email.

No database migration or delivery-worker change is needed. Existing saved delays remain associated with the same steps.
