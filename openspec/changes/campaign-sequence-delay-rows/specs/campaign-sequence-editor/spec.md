# Campaign sequence editor

## Requirements

### Requirement: Delays are shown between messages
The campaign sequence editor MUST show a delay control between each consecutive pair of emails, representing the wait before the later email.

#### Scenario: First email has no preceding delay
- GIVEN a campaign sequence with at least one email
- WHEN the sequence editor is displayed
- THEN the first email is shown without a delay control before it
- AND the email editor does not show a delay field

#### Scenario: Follow-up email delay is editable
- GIVEN a campaign sequence with a follow-up email
- WHEN the sequence is displayed in an editable draft
- THEN a delay row appears before that follow-up email with the text “Отправить через”
- AND its numeric value is that email's stored delay in days
- AND changing the value updates that email's delay

#### Scenario: Delay controls are unavailable for read-only campaigns
- GIVEN a campaign sequence the user cannot edit
- WHEN the sequence is displayed
- THEN delay values are visible but disabled

#### Scenario: Existing sequence timing remains compatible
- GIVEN a saved campaign with existing step delays
- WHEN the campaign is opened and saved without changing those values
- THEN the step delays remain unchanged and continue to control scheduling before their respective follow-up emails
