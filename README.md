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
| Node Host URL | Your Vrymdor AI Node as this n8n instance can reach it, for example `http://vrymnox-gateway:8080` (shown as "Gateway URL" before 1.0.3; saved credentials keep working) |
| Agent ID | The agent's ID from the Vrymnox console (AI agents, Register an agent), for example `agt_3f9c2a7d1b8e4f60` |
| Agent Secret | The secret shown once when the agent was registered. It starts with `vrym_agent_` |

n8n stores the secret encrypted. On each run the node trades it for a short-lived token at the
gateway's `/v1/token` endpoint; the secret itself is never sent anywhere else. The credential test
performs the same exchange.

## Example workflows

Two ready workflows are in [`examples/`](examples). Download the file, then in n8n create a workflow, open the
menu at the top right, choose **Import from File** and pick the file.

| File | For | What it does |
| ---- | --- | ------------ |
| [`vrymdor-node-workflow.json`](examples/vrymdor-node-workflow.json) | self-hosted n8n with this node installed | Sample text, then **Remove PII and Secrets**, then an optional model call through the node |
| [`vrymdor-n8n-cloud-workflow.json`](examples/vrymdor-n8n-cloud-workflow.json) | n8n Cloud (until n8n verifies this node) | A **Vrymdor token** step (your node address in its URL, your agent in its Custom Auth credential), then the **Vrymdor AI Node** step. The note on the canvas has the steps |
| [`vrymdor-support-email-workflow.json`](examples/vrymdor-support-email-workflow.json) | n8n Cloud | A customer support email through the same two Vrymdor steps. **For your AI** shows what an AI step gets (the masked email) and **reply_to** keeps the real address for the reply |

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
* **Held actions**: if your policy holds a model, tool or webhook call, the node never waits and never asks
  anyone: the item returns `decision: hold` with `vrymdor.action_ran: false`, the action did not run, and the
  workflow continues.

## Safe Mode (never stops, never sends raw)

From 1.0.3 the node keeps your workflow running when the AI Node cannot serve a step. Safe Mode starts when:

* the AI Node cannot be reached (connection refused, DNS failure, connection reset),
* it does not answer within the **Timeout Budget** (Options, default 3,000 ms for Remove PII and Secrets and Check
  Only; model, tool and webhook calls wait up to 120 seconds, since the upstream does the work),
* it answers that it is unavailable (HTTP 502, 503 or 504, or a proxy error page), or
* it answers HTTP 402 because the free Community plan's monthly requests (10,000) or agents (2) are used up.

Then the node masks the item locally with built-in, public-grade detectors (email addresses, card numbers that pass
the Luhn check, US Social Security numbers, PEM private keys, OpenAI, Anthropic, Stripe, GitHub, AWS, Google and
Slack keys, bearer tokens, JWTs, and string values under secret field names such as `password` or `api_key`), in the
same `[REDACTED:TYPE]` format, and the workflow continues. Safe Mode has no runtime dependencies and none of the AI
Node's own engine, and it masks aggressively on purpose. It does not apply your custom policy or patterns.

The item is marked so a later step can branch on it:

```json
{ "ok": true, "decision": "safe_mode", "output": "Mail [REDACTED:EMAIL]", "redactions": { "EMAIL": 1 },
  "vrymdor": { "degraded": "safe_mode", "reason": "unreachable", "message": "Safe Mode: the Vrymdor AI Node could not be reached, so this item was masked locally and the workflow continued." } }
```

`reason` is `unreachable`, `timeout`, `unavailable`, `quota_exhausted` or `agent_limit`. On a 402 the item also
carries `vrymdor.upgrade_url` and `vrymdor.upgrade_hint`. For **Run a Tool**, **Call a Model** and **Send a
Webhook** the action cannot run without the AI Node: the item returns `ok: false`, `error.code` `safe_mode`, the
input masked locally as `output`, and `vrymdor.action_ran` (`false`, or `unknown` after a timeout, since the AI Node
may have finished the action). Policy refusals and wrong credentials are not outages: they still raise an n8n error.

Safe Mode never passes the input on unmasked. Every Safe Mode item is written to the n8n log as a warning.

## Check Only (dry run)

**Check Only** runs every check on an action and sends nothing on. Its output is always masked, and `redactions`
and `report` say what was found (categories, how sure each detector is, and a residual risk score). Choose
**Data Only (No Upstream)** to see what your AI Node would mask in your own data before you turn masking on.

## Put the real values back (Rehydrate)

With **Options, Rehydrate** on, each private value gets its own numbered token, such as `[REDACTED:EMAIL_1]`, and
the model never sees the real value. On **Call a Model** the answer comes back with the real values in one step. On
**Remove PII and Secrets** the output carries a `map_id`; after your own model step, add a Vrymnox step with **Put
Real Values Back** and that `map_id`.

* Restore is all or nothing: if the model makes up, damages or swaps a token, nothing is put back and the step
  raises an error (`rehydrate_check_failed`). A refused restore stops the workflow unless **Continue On Fail** is on;
  retry the model once, then send the item to a person.
* Secrets (API keys, tokens, private keys and your secret patterns) are never put back.
* **Options, Only For**: who the answer is for, by their real details, such as `{{ $json.customer_email }}`.
  Separate more than one with commas. Only that person's details can come back, so a reply to one customer can
  never carry another customer's details. Your rules can require it on every restore.
* The list of real values never leaves your AI Node.

## Output

Each item returns the gateway's response: `ok`, `decision` (`allow`, `hold`, `block` or `error`),
`output`, the `redactions` count by type, the `rules` that applied, `hold_id` when held, and an
`audit` reference. A refusal raises an n8n error such as `Vrymnox tool_not_allowed: ...`; with
**Continue On Fail** the item carries an `error` field instead. Retries of the same execution reuse
an idempotency key, so the action never runs twice.

## Changes

* **1.0.5**: security release. **Only For** on Put Real Values Back and on Call a Model with Rehydrate. **Check
  Only** can check data with no upstream (Data Only). Safe Mode masks phone numbers. Removed: Allow Unmasked
  Passthrough on Outage (an outage always masks) and Shadow Mode (use Check Only, whose output is always masked);
  a step saved with either option keeps working and is masked.
* **1.0.4**: Rehydrate: numbered tokens and Put Real Values Back.
* **1.0.3**: Safe Mode (above), with the Timeout Budget and Allow Unmasked Passthrough on Outage options; Shadow
  mode (report only) and the sanitization report. A held action now returns at once and the workflow
  continues; the node never waits on anyone. The
  credential's first field is now labeled **Node Host URL** (its key is unchanged). Still no runtime dependencies.
* **1.0.2**: author email for n8n ownership verification.
* **1.0.1**: published from GitHub Actions with npm provenance.

## Compatibility

Built against n8n-workflow 2.x and n8n nodes API version 1. Requires Node.js 20.15 or later.

## License

[MIT](LICENSE), Vrymnox Systems LLC.

## License and terms

Copyright (c) 2026 Vrymnox Systems LLC. This client is open source under the MIT License (LICENSE). Using the
Vrymdor AI Node service it connects to is governed by the Vrymdor Master Subscription Agreement
(https://vrymdor.com/msa) and the Acceptable Use Policy in the agreement set you accept when you sign up.

## License and terms

Copyright (c) 2026 Vrymnox Systems LLC. This client is open source under the MIT License (LICENSE). Using the
Vrymdor AI Node service it connects to is governed by the Vrymdor Master Subscription Agreement
(https://vrymdor.com/msa) and the Acceptable Use Policy in the agreement set you accept when you sign up.
