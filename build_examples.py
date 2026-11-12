"""Builds the three n8n workflow files to import in examples/ (python3 build_examples.py [extra output folder ...]).

- vrymdor-node-workflow.json: the Vrymnox community node (self-hosted n8n, Settings, Community Nodes,
  n8n-nodes-vrymnox). Start, sample text, the node removes personal data and secrets, then (off until an upstream
  named `anthropic` is on the gateway) a model call through the node.
- vrymdor-n8n-cloud-workflow.json: the same for n8n Cloud until n8n verifies the community node: a token step whose
  agent secret is kept in n8n's Custom Auth credential, then one Code step (examples/src/vrymdor_ai_node.js).
- vrymdor-support-email-workflow.json: the n8n Cloud steps on a customer support email, ending in what an AI
  step would get (the masked prompt) and where the reply goes (the real address).

The files hold no credential ids and no secrets: n8n asks for the credential on the first run. Node ids are
stable (uuid5), so a rebuild changes nothing unless the workflow changed. Text a person reads follows the repo's
prose rules (no em or en dash, no double hyphen), checked in app/tests/test_n8n_examples.py.
"""
from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "examples"
NS = uuid.UUID("6f1c9a52-3d0e-4b7a-9a61-2a8c5e0d4f17")
SAMPLE = "Please email jane@example.com about the order on card 4242 4242 4242 4242."
MODEL_BODY = ('={{ { "model": "claude-sonnet-5-5", "max_tokens": 512, '
              '"messages": [{ "role": "user", "content": $json.output }] } }}')


def nid(workflow: str, name: str) -> str:
    return str(uuid.uuid5(NS, f"{workflow}:{name}"))


def node(workflow: str, name: str, type_: str, version: float, pos: tuple[int, int], params: dict, **extra) -> dict:
    return {"parameters": params, "id": nid(workflow, name), "name": name, "type": type_,
            "typeVersion": version, "position": list(pos), **extra}


def note(workflow: str, name: str, pos: tuple[int, int], content: str, width: int = 420, height: int = 300) -> dict:
    return node(workflow, name, "n8n-nodes-base.stickyNote", 1, pos,
                {"content": content, "height": height, "width": width})


def setter(workflow: str, name: str, pos: tuple[int, int], fields: dict[str, str]) -> dict:
    return node(workflow, name, "n8n-nodes-base.set", 3.4, pos, {
        "mode": "manual",
        "assignments": {"assignments": [
            {"id": nid(workflow, f"{name}:{k}"), "name": k, "value": v, "type": "string"} for k, v in fields.items()
        ]},
        "options": {},
    })


def chain(*names: str) -> dict:
    return {a: {"main": [[{"node": b, "type": "main", "index": 0}]]} for a, b in zip(names, names[1:])}


def workflow(name: str, nodes: list[dict], connections: dict) -> dict:
    return {"name": name, "nodes": nodes, "connections": connections, "settings": {"executionOrder": "v1"},
            "pinData": {}, "meta": {"templateCredsSetupCompleted": False}}


def self_hosted() -> dict:
    w = "node"
    nodes = [
        note(w, "How to use this workflow", (-460, -200),
             "## Vrymdor AI Node in n8n\n"
             "1. **Settings**, **Community Nodes**, **Install**: `n8n-nodes-vrymnox`.\n"
             "2. Open **Vrymdor: remove PII**, **Credential**, **Create new**: paste the Node Host URL, Agent ID "
             "(`agt_...`) and Agent Secret (`vrym_agent_...`) from the **Connect your AI Node** card in your "
             "Vrymdor dashboard (**AI agents**, choose **n8n**), each with its own Copy button.\n"
             "3. **Execute workflow**. The output shows `[REDACTED:EMAIL]` and `[REDACTED:CREDIT_CARD]`, "
             "and `redactions` counts them.\n\n"
             "Put your own data in **Sample text**, or connect any trigger in its place.",
             width=440, height=360),
        node(w, "Start", "n8n-nodes-base.manualTrigger", 1, (0, 0), {}),
        setter(w, "Sample text", (220, 0), {"text": SAMPLE}),
        node(w, "Vrymdor: remove PII", "n8n-nodes-vrymnox.vrymnox", 1, (440, 0),
             {"operation": "sanitize", "input": "={{ $json.text }}"}),
        node(w, "Vrymdor: call a model", "n8n-nodes-vrymnox.vrymnox", 1, (660, 0),
             {"operation": "llm", "upstream": "anthropic", "path": "v1/messages", "input": MODEL_BODY},
             disabled=True),
        note(w, "The model step", (600, -260),
             "## Optional: a model call through the node\n"
             "Off until your node has an upstream named `anthropic`. Then select the step and press **D** "
             "to turn it on. The node checks the policy and masks emails, card numbers, keys and tokens again before the model "
             "sees the prompt.",
             width=360, height=220),
    ]
    return workflow("Vrymdor AI Node: remove PII, then call a model", nodes,
                    chain("Start", "Sample text", "Vrymdor: remove PII", "Vrymdor: call a model"))


def cloud() -> dict:
    """Two Vrymdor steps: an HTTP Request that trades the agent secret, kept in n8n's own Custom Auth credential, for
    a token, then a Code step that cleans each item with it. The secret never sits in the workflow itself."""
    w = "cloud"
    nodes = [
        note(w, "How to use this workflow", (-500, -300),
             "## Vrymdor AI Node on n8n Cloud\n"
             "1. In its **Vrymdor token** step, paste the full URL from your Vrymdor dashboard into **URL**. It "
             "already ends in /v1/token. (Dashboard: **AI agents**, **Connect your AI Node**, **n8n Cloud**, "
             "**URL for the Vrymdor token step**.)\n"
             "2. In the same step, **Custom Auth**, **Create new credential**. In its JSON field paste "
             "**Vrymdor token credential (Custom Auth JSON)** from the same card. It is filled in with your "
             "Agent ID and Agent Secret and looks like:\n"
             "`{\"body\": {\"agent_id\": \"agt_...\", \"agent_secret\": \"vrym_agent_...\"}}`\n"
             "Then **Save**. The secret stays in the credential: it is not shown in the workflow and does not "
             "leave with it when you share or export it.\n"
             "3. Check the connection: **Execute step** on **Vrymdor token** shows an `access_token`. 404 means "
             "the URL is missing /v1/token or has the wrong node address: paste the full URL from your dashboard "
             "again. 401 or “Authorization failed” means the Agent ID or Agent Secret is wrong: copy both again. "
             "502 means your node is off: turn it on in Home base and copy the URL fresh.\n"
             "4. **Execute workflow**. The output shows `[REDACTED:EMAIL]` and `[REDACTED:CREDIT_CARD]`, and "
             "`vrymdor.redactions` counts them.\n\n"
             "Replace **Sample text** with your own trigger (set `items_from` in **Vrymdor AI Node** to its "
             "name). Send everything a model will read through these steps first. Your workflow keeps the real "
             "data (an email step can still use the address); the model sees only the masked text.",
             width=520, height=560),
        node(w, "Start", "n8n-nodes-base.manualTrigger", 1, (0, 0), {}),
        setter(w, "Sample text", (220, 0), {"text": SAMPLE}),
        node(w, "Vrymdor token", "n8n-nodes-base.httpRequest", 4.2, (440, 0), {
            "method": "POST",
            "url": "https://node.vrymdor.com/t/PASTE_YOUR_NODE_ID/v1/token",
            "authentication": "genericCredentialType",
            "genericAuthType": "httpCustomAuth",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "{}",
            "options": {},
        }, executeOnce=True),
        node(w, "Vrymdor AI Node", "n8n-nodes-base.code", 2, (660, 0),
             {"jsCode": (OUT / "src" / "vrymdor_ai_node.js").read_text()}),
    ]
    return workflow("Vrymdor AI Node on n8n Cloud: remove PII", nodes,
                    chain("Start", "Sample text", "Vrymdor token", "Vrymdor AI Node"))


SUPPORT_EMAIL = ("Hi, I was charged twice for order 1042 on card 4242 4242 4242 4242. Please refund me and reply "
                 "to jane@example.com. Thanks, Jane")


def support_email() -> dict:
    """A customer support email on n8n Cloud: the email comes in, the Vrymdor steps mask its body, and the last
    step shows exactly what an AI step would get (the masked prompt) next to where the reply goes (the real
    address, kept in the workflow). Runs with no model and no mail account, so anyone can try it in one click."""
    w = "support"
    code = (OUT / "src" / "vrymdor_ai_node.js").read_text().replace("items_from: 'Sample text'",
                                                                    "items_from: 'Support email'")
    nodes = [
        note(w, "How to set it up", (-560, -340),
             "## Customer support email, through your Vrymdor AI Node\n"
             "1. Vrymdor app: **AI agents**, **Connect your AI Node**, **n8n Cloud**.\n"
             "2. **Vrymdor token** step: paste **URL for the Vrymdor token step** into **URL**.\n"
             "3. Same step: **Custom Auth**, **Create new credential**, paste **Vrymdor token credential "
             "(Custom Auth JSON)** from the same card, **Save**. Your Agent ID and Agent Secret stay in the "
             "credential, never in the workflow.\n"
             "4. **Execute workflow**.\n\n"
             "**For your AI** shows what an AI step gets: the email with `[REDACTED:EMAIL]` and "
             "`[REDACTED:CREDIT_CARD]`. **reply_to** keeps the real address, so the reply still reaches the "
             "customer.",
             width=520, height=460),
        note(w, "Make it yours", (900, -340),
             "## Make it yours\n"
             "Swap **Start** and **Support email** for your mail trigger (Gmail or Outlook), then set "
             "`items_from` in **Vrymdor AI Node** to that step's name and `field` to its body field.\n"
             "After **For your AI**, add your AI step (it reads `prompt`) and your send step (To: `reply_to`).",
             width=400, height=300),
        node(w, "Start", "n8n-nodes-base.manualTrigger", 1, (0, 0), {}),
        setter(w, "Support email", (220, 0),
               {"from": "jane@example.com", "subject": "Charged twice", "text": SUPPORT_EMAIL}),
        node(w, "Vrymdor token", "n8n-nodes-base.httpRequest", 4.2, (440, 0), {
            "method": "POST",
            "url": "https://node.vrymdor.com/t/PASTE_YOUR_NODE_ID/v1/token",
            "authentication": "genericCredentialType",
            "genericAuthType": "httpCustomAuth",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "{}",
            "options": {},
        }, executeOnce=True),
        node(w, "Vrymdor AI Node", "n8n-nodes-base.code", 2, (660, 0), {"jsCode": code}),
        setter(w, "For your AI", (880, 0), {
            "prompt": "=Write a short, kind reply to this customer email:\n{{ $json.text }}",
            "reply_to": "={{ $json.from }}",
        }),
    ]
    return workflow("Vrymdor AI Node: customer support email", nodes,
                    chain("Start", "Support email", "Vrymdor token", "Vrymdor AI Node", "For your AI"))


FILES = {"vrymdor-node-workflow.json": self_hosted, "vrymdor-n8n-cloud-workflow.json": cloud,
         "vrymdor-support-email-workflow.json": support_email}


def build(extra: list[Path]) -> list[Path]:
    written = []
    for folder in [OUT, *extra]:
        folder.mkdir(parents=True, exist_ok=True)
        for fname, make in FILES.items():
            p = folder / fname
            p.write_text(json.dumps(make(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            written.append(p)
    return written


if __name__ == "__main__":
    for p in build([Path(a) for a in sys.argv[1:]]):
        print(p)
