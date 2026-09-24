# n8n-nodes-hesperan

An [n8n](https://n8n.io/) community node for [Hesperan](https://hesperan.com), a hosted API for calibrated decisions.

A Hesperan **decision profile** is one decision (for example "which team handles this ticket?") calibrated on
your own past cases, with a precision target you choose. Every answer comes back with a calibrated confidence and
an action: **auto**, act on it, or **review**, a person decides. This node turns that into two outputs, so a
workflow automates only the cases the profile clears and sends the rest to a person.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) ·
[Errors and retries](#errors-and-retries) · [Templates](#templates) · [Compatibility](#compatibility) ·
[Development](#development) · [n8n requirements](#n8n-requirements-followed) · [Resources](#resources)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/gui-installation):
in n8n, open **Settings → Community Nodes → Install**, enter `n8n-nodes-hesperan` and confirm. Once n8n has
verified the node, it can also be found and installed from the nodes panel.

## Credentials

Create an API key in the Hesperan console (it starts with `hsp_`) and add a **Hesperan API** credential:

| Field    | Value                                                                              |
| -------- | ---------------------------------------------------------------------------------- |
| API Key  | your `hsp_…` key; stored as a password field and sent as `Authorization: Bearer …` |
| Base URL | `https://api.hesperan.com` (change only if Hesperan gave you another address)      |

**Test** calls `GET /v1/me`, which checks the key without calling the model and is not charged. A rejected key
shows "Hesperan rejected the API key"; a wrong base URL shows "No Hesperan API was found at this base URL".

## Operations

### Decision → Decide

Decides with a calibrated profile (`POST /v1/decide/{profile}`) and sends each item to one of two outputs:

- **Auto**: the calibrated confidence reached the profile's threshold; act on `decision`.
- **Review**: everything else, including any action other than `auto`; a person decides.

| Parameter                        | Description                                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile                          | Pick from your profiles (`GET /v1/profiles`, free) or enter the slug, also as an expression                                                                                                                             |
| State Source                     | **Text** (usually an expression such as the ticket body), **JSON**, or the **Whole Input Item**                                                                                                                         |
| Idempotency Key                  | Optional, e.g. `ticket-{{ $json.id }}`. The same key with the same state within 24 hours returns the first decision (`replayed: true`) and is not charged again; the same key with a different state is refused (409)   |
| Simplify                         | On by default: `decision`, `confidence`, `action`, `decision_id`, `probabilities`, `profile`, `replayed`. Off: the full response, adding `threshold`, `target_precision`, `calibration_version` and `raw_probabilities` |
| Options → Put Output in Field    | Default `hesperan`; empty merges the fields into the item                                                                                                                                                               |
| Options → Retry Temporary Errors | Default on; see [Errors and retries](#errors-and-retries)                                                                                                                                                               |

The item keeps its own fields and gains the result, for example:

```json
{
	"id": 4812,
	"subject": "Charged twice",
	"hesperan": {
		"decision": "billing",
		"confidence": 0.9931,
		"action": "auto",
		"decision_id": "0f6c…",
		"probabilities": { "billing": 0.9931, "shipping": 0.0041, "technical": 0.0028 },
		"profile": "ticket-routing",
		"replayed": false
	}
}
```

Everything sent as state is read by the model and billed by tokens; leave out fields that do not matter. Profiles
are created and calibrated in the Hesperan console; see [Decision profiles](https://hesperan.com/docs/profiles).

### Decision → Report Outcome

Reports the answer that was right for an earlier decision (`POST /v1/outcomes`, free), for example the team
that finally handled the ticket. Hesperan uses outcomes to show the live precision of automated decisions.

| Parameter     | Description                                                                          |
| ------------- | ------------------------------------------------------------------------------------ |
| Decision ID   | The `decision_id` from Decide, e.g. `{{ $json.hesperan.decision_id }}`               |
| Profile       | Optional; only used to list the profile's answers for the next field. It is not sent |
| Actual Answer | One of the profile's answers, from the list or as an expression                      |

Each decision takes one outcome. Reporting the same answer again is accepted (`duplicate: true`); a different
answer is refused (409). Report all outcomes or a random sample, not only corrections.

### Question → Ask

Asks one or more typed questions about a state without a profile (`POST /v1/systemone`) and returns the answers
with probabilities under `hesperan.answers`.

| Type   | Enter                                                       | Answer                                                 |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------ |
| Choice | Options, one per line: `key` or `key: description`          | `choice` and `probabilities` per option                |
| Yes/No | Instructions as a statement; optional meaning of yes and no | `noul`, the probability of yes                         |
| Score  | Levels, one per line, lowest first                          | `score` (expected level) and `probabilities` per level |

Questions can also be given as the JSON `questions` object of the API (**Questions Input → JSON**).

**Route by First Answer** gives the node one output per option of the first question (Choice) or a **Yes** and a
**No** output (Yes/No; Yes when the probability is at least 0.5). The options must be plain text, not an
expression, because n8n draws the outputs from them. Ask answers are raw model probabilities; for calibrated,
automatable decisions use a profile and **Decide**.

### Use as an AI Agent tool

The node is usable as a tool of n8n's AI Agent (`usableAsTool`). As a tool it has a single output, so all
items are returned there; the `action` field still says `auto` or `review`.

## Errors and retries

Messages say what happened and what to do; nothing is charged for any of these.

| Status               | Message in n8n                                                                                                   | Retried                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 401                  | Hesperan rejected the API key                                                                                    | no                             |
| 402                  | the billing message from Hesperan, e.g. "your 1M free tokens this month are used up … top up …"                  | no                             |
| 404                  | Unknown decision profile "…" / Unknown decision ID                                                               | no                             |
| 409                  | e.g. the profile has no calibration yet, Idempotency-Key reused with a different state, outcome already reported | no                             |
| 413                  | The request is too large (at most 256 KB)                                                                        | no                             |
| 429                  | Hesperan rate limit reached                                                                                      | yes, after Retry-After         |
| 502                  | The Hesperan model could not answer                                                                              | yes, with backoff              |
| 503 with Retry-After | The Hesperan model is starting                                                                                   | yes, after Retry-After         |
| 503 "opens soon"     | Edge case, the Hesperan API is closed (no model connected)                                                       | **no**, retrying does not help |

With **Retry Temporary Errors** on (default), the node retries up to 3 times and waits at most 60 seconds per
attempt; the retried failures were not charged, so a retry never charges twice.

Hesperan 1 runs on serverless GPUs. The first request after a quiet period starts the model and can take about 2–3
minutes, or come back as 503 "model is starting" with Retry-After, which the node retries; later requests skip that
wait while the model is warm.

With the node setting **On Error → Continue**, a failed Decide item goes to **Review** with its own fields and
`hesperan.error`, `hesperan.status` and `hesperan.description`, so a person can take over. With **Continue (using
error output)** failed items go to n8n's separate error output instead.

## Templates

Importable workflows in [`templates/`](templates/) (in n8n: **Workflows → Import from File**). Each has sticky
notes with the setup steps.

| File                                                                     | What it does                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`zammad-ticket-triage.json`](templates/zammad-ticket-triage.json)       | New Zammad ticket (Webhook) → Decide → **Auto**: Zammad sets the group and adds an internal note; **Review**: tag `hesperan-review` and a note with the suggestion. Stores the decision in the Data Table `hesperan_decisions` |
| [`mailbox-triage-imap.json`](templates/mailbox-triage-imap.json)         | Email Trigger (IMAP) → Decide → **Auto**: forward to the team's address; **Review**: send to a triage address with the suggestion                                                                                              |
| [`mailbox-triage-gmail.json`](templates/mailbox-triage-gmail.json)       | Gmail Trigger → Decide (Gmail message ID as Idempotency Key) → **Auto**: team label; **Review**: _Needs review_ label                                                                                                          |
| [`zammad-outcome-feedback.json`](templates/zammad-outcome-feedback.json) | Zammad ticket closed (Webhook) → find the stored decision → Report Outcome with the final group                                                                                                                                |

The Zammad templates assume the profile's answers are your Zammad group names. Both were run end to end in
n8n 2.40.6 against local stand-ins for Hesperan and Zammad; the mailbox templates were checked against n8n's
node definitions only.

## Compatibility

- Built with `@n8n/node-cli` 0.49.1 and `n8n-workflow` 2.40 (`n8nNodesApiVersion` 1, strict mode, no runtime
  dependencies).
- Tested in n8n 2.40.6 (Docker image `n8nio/n8n:2.40.6`): node and credential loading, the credential test,
  Auto/Review routing, routing by answer, Report Outcome, both "continue on fail" modes, and the two Zammad
  templates.
- Requires a Hesperan API key (the free plan includes 1M input tokens a month). The first request after a quiet
  period can take about 2–3 minutes while the serverless model starts.

## Development

```bash
npm install
npm run build      # n8n-node build
npm run lint       # n8n-node lint (n8n's ESLint rules for community nodes, strict mode)
npm test           # vitest: the node against a fake HTTP layer
npm run dev        # n8n with this node loaded, http://localhost:5678
```

Releases are published to npm by [`.github/workflows/publish.yml`](.github/workflows/publish.yml) with npm
provenance; see [PUBLISHING.md](PUBLISHING.md).

## n8n requirements followed

Checked on 24 September 2026 against n8n's current documentation:

- Scaffolding and tooling from `npm create @n8n/node` / the `n8n-node` CLI (build, lint, release, strict mode):
  [Submit community nodes](https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes),
  [n8n-nodes-starter](https://github.com/n8n-io/n8n-nodes-starter).
- Publishing from GitHub Actions with a provenance statement, required for verification from 1 May 2026, with
  `@n8n/node-cli` ≥ 0.23.0: [Submit community nodes → Publishing to npm](https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes),
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements), [npm trusted publishing](https://docs.npmjs.com/trusted-publishers).
- [Verification guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines):
  one service per package, MIT license, no runtime dependencies, no environment variables or file access,
  English only, documentation, `npx @n8n/scan-community-package` must pass.
- [UX guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/ux-guidelines): password
  fields for keys, resource locator defaulting to _From list_, _Simplify_ for responses with more than ten fields,
  operation names and actions, error messages with a description of what to do.
- Linter: [`@n8n/eslint-plugin-community-nodes`](https://www.npmjs.com/package/@n8n/eslint-plugin-community-nodes)
  via `n8n-node lint` (passes with no warnings).

The static checks of `@n8n/scan-community-package` pass on the packed tarball and the source; its provenance
check can only run after the first release.

## Resources

- [Hesperan documentation](https://hesperan.com/docs): [decision profiles](https://hesperan.com/docs/profiles),
  [errors and limits](https://hesperan.com/docs/errors), [API reference](https://hesperan.com/docs/api)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes)

## License

[MIT](LICENSE.md)
