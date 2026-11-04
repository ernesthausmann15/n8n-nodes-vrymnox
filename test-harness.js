// Drives the built node the way n8n would, against a real gateway (VRYMNOX_NODE_URL). Used by
// gateway/tests/test_n8n_node.py; not part of the published package ("files" is dist only).
// httpRequestWithAuthentication follows n8n's credential helper: preAuthentication fills the expirable
// sessionToken when it is empty, the generic authenticate block adds the header, and a thrown HTTP 401
// runs preAuthentication again and retries once.
const { Vrymnox } = require('./dist/nodes/Vrymnox/Vrymnox.node.js')
const { VrymnoxApi } = require('./dist/credentials/VrymnoxApi.credentials.js')

const params = JSON.parse(process.env.NODE_PARAMS)
const creds = { gatewayUrl: process.env.VRYMNOX_NODE_URL, agentId: process.env.AGENT_ID, agentSecret: process.env.AGENT_SECRET,
  sessionToken: params.staleSessionToken || '' }
const credType = new VrymnoxApi()
let preAuthRuns = 0

async function httpRequest(o) {
  const res = await fetch(o.url, { method: o.method, headers: { 'content-type': 'application/json', ...(o.headers || {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body) })
  const body = await res.json()
  if (!res.ok && !o.ignoreHttpStatusErrors) {
    const err = new Error(`HTTP ${res.status}`)
    err.response = { status: res.status }
    throw err
  }
  return body
}
const helpers = { httpRequest }

async function preAuth() {
  preAuthRuns += 1
  Object.assign(creds, await credType.preAuthentication.call({ helpers }, creds))
}
function authenticate(o) {
  // n8n resolves the expression: a leading = marks it, {{$credentials.x}} is the stored value.
  const value = credType.authenticate.properties.headers.Authorization.replace(/^=/, '')
    .replace(/\{\{\$credentials\.(\w+)\}\}/g, (_m, k) => String(creds[k] ?? ''))
  return { ...o, headers: { ...(o.headers || {}), Authorization: value } }
}

const ctx = {
  getCredentials: async () => creds,
  getInputData: () => [{ json: {} }],
  getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
  getExecutionId: () => 'exec-123',
  getNode: () => ({ id: 'node-abc', name: 'Vrymnox', type: 'vrymnox', typeVersion: 1, parameters: {} }),
  getWorkflow: () => ({ id: 'wf-1' }),
  continueOnFail: () => params.continueOnFail === true,
  helpers: {
    httpRequest,
    httpRequestWithAuthentication: async function (_type, o) {
      if (!creds.sessionToken) await preAuth()
      try {
        return await httpRequest(authenticate(o))
      } catch (e) {
        if (e.response && e.response.status === 401) {
          await preAuth()
          return await httpRequest(authenticate(o))
        }
        throw e
      }
    },
  },
}
new Vrymnox().execute.call(ctx).then(
  (out) => console.log(JSON.stringify({ ...out[0][0].json, _preAuthRuns: preAuthRuns })),
  (e) => { console.log(JSON.stringify({ thrown: e.message, _preAuthRuns: preAuthRuns })) })
