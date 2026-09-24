# Changelog

## 0.1.0 (unreleased)

First version.

- **Hesperan API** credential: API key and base URL, tested with the free `GET /v1/me`.
- **Hesperan** node
  - Decision → Decide: calibrated decision with a profile; items leave on the **Auto** or the **Review** output.
    Profile picker (`GET /v1/profiles`) or slug, optional Idempotency Key, Simplify.
  - Decision → Report Outcome: the correct answer for a decision; the answer list comes from the profile.
  - Question → Ask: choice, yes/no and score questions (list or JSON); optional routing by the first answer.
  - Plain messages for 401, 402, 404, 409, 413, 429, 502 and 503 ("opens soon" vs. a starting model); up to 3
    retries for failures that are never charged; "continue on fail" and the error output; usable as an AI tool.
- Workflow templates: Zammad ticket triage, mailbox triage (IMAP and Gmail), Zammad outcome feedback.
