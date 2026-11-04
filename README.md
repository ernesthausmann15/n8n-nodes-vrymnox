# n8n-nodes-vrymnox

The Vrymnox AI Node for [n8n](https://n8n.io). It sends each step of a workflow through your own Vrymnox
gateway, so every tool run, model call and webhook is checked against the agent's identity and policy,
has personal data and secrets removed, and leaves an audit record.

The node never runs code itself. Each operation is one request to your gateway (`POST /v1/node/run`),
and the gateway runs exactly one allowed action against an upstream you configured.

## Privacy

* Personal data (email addresses, card numbers, US Social Security numbers, plus any terms and patterns
  your policy adds) and secrets (private keys, API keys and access tokens) are redacted by the gateway
  before anything is forwarded or returned.
* Nothing leaves your network except through your gateway. The node talks only to the gateway URL you
  enter in the credential, and the gateway talks only to the upstreams you configured on it.
* The node sends no telemetry to Vrymnox or anyone else.

## Install

On a self-hosted n8n instance:

1. Open **Settings**, then **Community Nodes**.
2. Select **Install a community node**.
3. Enter `n8n-nodes-vrymnox`, accept the notice about community nodes, and select **Install**.

The **Vrymnox** node then appears in the node panel. To install by hand instead, run
`npm install n8n-nodes-vrymnox` in your n8n custom nodes folder (usually `~/.n8n/nodes`) and restart n8n.

## Credential

Create a **Vrymnox Agent API** credential with:

| Field | What to enter |
| ----- | ------------- |
| Gateway URL | Your Vrymnox gateway as this n8n instance can reach it, for example `http://vrymnox-gateway:8080` |
| Agent ID | The agent's ID from the Vrymnox console (AI agents, Register an agent), for example `agt_3f9c2a7d1b8e4f60` |
| Agent Secret | The secret shown once when the agent was registered. It starts with `vrym_agent_` |

n8n stores the secret encrypted. On each run the node trades it for a short-lived token at the
gateway's `/v1/token` endpoint; the secret itself is never sent anywhere else. The credential test
performs the same exchange.

## Example workflows (copy and paste)

Two ready workflows are in [`examples/`](examples). Open the file, copy all of it, click an empty n8n canvas and
press Ctrl+V (Cmd+V on a Mac).

| File | For | What it does |
| ---- | --- | ------------ |
| [`vrymdor-node-workflow.json`](examples/vrymdor-node-workflow.json) | self-hosted n8n with this node installed | Sample text, then **Remove PII and Secrets**, then an optional model call through the node |
| [`vrymdor-n8n-cloud-workflow.json`](examples/vrymdor-n8n-cloud-workflow.json) | n8n Cloud (until n8n verifies this node) | The same clean step with two HTTP Request nodes: a token, then the run |

Each has a note on the canvas with its three steps. Run it and the output shows `[REDACTED:EMAIL]` and
`[REDACTED:CREDIT_CARD]` where the sample had an email address and a card number.

## Operations

| Operation | What it does |
| --------- | ------------ |
| Remove PII and Secrets | Returns the input with personal data and secrets replaced by labels such as `[REDACTED:EMAIL]`. Needs no upstream. |
| Run a Tool | Runs one MCP tool on a configured upstream, if the agent's policy allows it. |
| Call a Model | Sends a request body to a model API on a configured upstream, for example `v1/messages`. |
| Send a Webhook | Sends a payload to a webhook configured on the gateway. |
| Check Only (Dry Run) | Runs every check for a tool, model or webhook action without forwarding anything. |

Common fields:

* **Upstream**: the name of an upstream configured on your gateway, for example `github`.
* **Input**: the data to clean, the tool arguments, the model request body or the webhook payload.
  By default it is the incoming item (`{{ $json }}`).
* **Wait for Approval**: high-risk actions can need a person's approval first. When on, the node waits
  (up to the minutes you set) and then returns the result. When off, it returns the hold ID at once.

## Output

Each item returns the gateway's response: `ok`, `decision` (`allow`, `hold`, `block` or `error`),
`output`, the `redactions` count by type, the `rules` that applied, `hold_id` when held, and an
`audit` reference. A refusal raises an n8n error such as `Vrymnox tool_not_allowed: ...`; with
**Continue On Fail** the item carries an `error` field instead. Retries of the same execution reuse
an idempotency key, so the action never runs twice.

## Compatibility

Built against n8n-workflow 2.x and n8n nodes API version 1. Requires Node.js 20.15 or later.

## License

[MIT](LICENSE), Vrymnox Systems LLC.

## License and terms

Copyright (c) 2026 Vrymnox Systems LLC. This client is open source under the MIT License (LICENSE). Using the
Vrymdor AI Node service it connects to is governed by the Vrymdor Master Subscription Agreement
(https://vrymdor.com/msa) and the Acceptable Use Policy in the agreement set you accept when you sign up.
