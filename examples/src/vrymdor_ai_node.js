// ============ Vrymdor AI Node: fill these in once, then save ============
const SETTINGS = {
  // Your node address: the Vrymdor app, Home base, Hosted node (no / at the end).
  node_url: 'https://node.vrymdor.com/t/PASTE_YOUR_NODE_ID',
  // The Vrymdor app, AI agents, Register an agent.
  agent_id: 'agt_PASTE',
  agent_secret: 'vrym_agent_PASTE',
  // The field of each item to clean. The cleaned text replaces it, so the next step gets it as before.
  field: 'text',
};
// ========================================================================
// Every item's field goes through your AI Node: personal data and secrets are removed and your policy applies
// before anything reaches the next step (for example a model). The rest of the item is passed on untouched, so a
// later step (an email step's To field, say) can still use it. Each result carries `vrymdor`: the decision and the
// count of what was removed. A refusal stops the workflow with the node's reason.
if (SETTINGS.node_url.includes('PASTE') || SETTINGS.agent_id.includes('PASTE') || SETTINGS.agent_secret.includes('PASTE')) {
  throw new Error('Vrymdor AI Node: fill in node_url, agent_id and agent_secret at the top of this step.');
}
const base = SETTINGS.node_url.replace(/\/+$/, '');
let tok;
try {
  tok = await this.helpers.httpRequest({ method: 'POST', url: `${base}/v1/token`, json: true, timeout: 15000,
    body: { agent_id: SETTINGS.agent_id, agent_secret: SETTINGS.agent_secret } });
} catch (err) {
  throw new Error(`Vrymdor AI Node: no token from ${base} (check node_url, agent_id and agent_secret): ${err.message}`);
}
const out = [];
for (const item of $input.all()) {
  const value = item.json[SETTINGS.field];
  if (value === undefined) throw new Error(`Vrymdor AI Node: the item has no "${SETTINGS.field}" field (change field in the settings).`);
  const res = await this.helpers.httpRequest({ method: 'POST', url: `${base}/v1/node/run`, json: true, timeout: 15000,
    headers: { Authorization: `Bearer ${tok.access_token}` }, ignoreHttpStatusErrors: true,
    body: { node_version: '1', action: { type: 'sanitize' }, input: value, context: { platform: 'n8n' } } });
  if (!res || !res.ok) {
    const e = (res && res.error) || {};
    throw new Error(`Vrymdor ${e.code || 'error'}: ${e.message || 'the node refused the request.'}`);
  }
  out.push({ json: { ...item.json, [SETTINGS.field]: res.output,
    vrymdor: { decision: res.decision, redactions: res.redactions || {}, audit: res.audit || null } } });
}
return out;
