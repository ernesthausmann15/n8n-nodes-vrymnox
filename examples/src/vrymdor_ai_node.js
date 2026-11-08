// ============ Vrymdor AI Node ============
// Your agent id and secret live only in the Custom Auth credential of the Vrymdor token step, never here, so
// they are not shown in this step and do not leave with the workflow when it is shared or exported.
const SETTINGS = {
  // The field of each item to clean. The cleaned text replaces it, so the next step gets it as before.
  field: 'text',
  // The step whose items this step cleans: the step just before Vrymdor token.
  items_from: 'Sample text',
};
// =========================================
// Every item's field goes through your AI Node: personal data and secrets are removed and your policy applies
// before anything reaches the next step (for example a model). The rest of the item is passed on untouched, so a
// later step (an email step's To field, say) can still use it. Each result carries `vrymdor`: the decision and the
// count of what was removed. A refusal stops the workflow with the node's reason.
const tokenStep = $('Vrymdor token');
// The node address is the one in the Vrymdor token step's URL, so it is pasted once.
const base = String((tokenStep.params && tokenStep.params.url) || '').trim()
  .replace(/^=/, '').replace(/\/+$/, '').replace(/\/v1\/token$/, '');
if (!/^https?:\/\/[^/{}]+/.test(base) || base.includes('PASTE') || base.includes('{{')) {
  throw new Error('Vrymdor AI Node: put your node address in the URL of the Vrymdor token step, ' +
    'for example https://node.vrymdor.com/t/your-node-id/v1/token (Vrymdor app, Home base, Hosted node).');
}
const token = tokenStep.first().json.access_token;
if (!token) {
  throw new Error('Vrymdor AI Node: the Vrymdor token step returned no access_token. Open it, check its Custom Auth ' +
    'credential and run it again.');
}
const out = [];
for (const item of $(SETTINGS.items_from).all()) {
  const value = item.json[SETTINGS.field];
  if (value === undefined) throw new Error(`Vrymdor AI Node: the item has no "${SETTINGS.field}" field (change field in the settings).`);
  const res = await this.helpers.httpRequest({ method: 'POST', url: `${base}/v1/node/run`, json: true, timeout: 15000,
    headers: { Authorization: `Bearer ${token}` }, ignoreHttpStatusErrors: true,
    body: { node_version: '1', action: { type: 'sanitize' }, input: value, context: { platform: 'n8n' } } });
  if (!res || !res.ok) {
    const e = (res && res.error) || {};
    throw new Error(`Vrymdor ${e.code || 'error'}: ${e.message || 'the node refused the request.'}`);
  }
  out.push({ json: { ...item.json, [SETTINGS.field]: res.output,
    vrymdor: { decision: res.decision, redactions: res.redactions || {}, audit: res.audit || null } } });
}
return out;
