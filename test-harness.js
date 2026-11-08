// Drives the built node the way n8n would, against a real gateway (VRYMNOX_NODE_URL). Used by
// gateway/tests/test_n8n_node.py; not part of the published package ("files" is dist only).
// httpRequestWithAuthentication follows n8n's credential helper: preAuthentication fills the expirable
// sessionToken when it is empty, the generic authenticate block adds the header, and a thrown HTTP 401
// runs preAuthentication again and retries once. A request timeout throws like axios does (ECONNABORTED).
//
// `node test-harness.js --safe-mode-tests` runs the offline Safe Mode suite instead: stub gateways that refuse
// connections, hang, answer 402 or a proxy error page, plus the local detectors. No gateway needed.
const { Vrymnox } = require('./dist/nodes/Vrymnox/Vrymnox.node.js')
const { VrymnoxApi } = require('./dist/credentials/VrymnoxApi.credentials.js')

function makeContext({ url, agentId, agentSecret, params }) {
  const creds = { gatewayUrl: url, agentId, agentSecret, sessionToken: params.staleSessionToken || '' }
  const credType = new VrymnoxApi()
  const state = { preAuthRuns: 0, warnings: [] }

  async function httpRequest(o) {
    let res
    try {
      res = await fetch(o.url, { method: o.method, headers: { 'content-type': 'application/json', ...(o.headers || {}) },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: o.timeout ? AbortSignal.timeout(o.timeout) : undefined })
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw Object.assign(new Error(`timeout of ${o.timeout}ms exceeded`), { code: 'ECONNABORTED' })
      }
      throw e
    }
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    if (!res.ok && !o.ignoreHttpStatusErrors) {
      const err = new Error(`HTTP ${res.status}`)
      err.response = { status: res.status }
      throw err
    }
    return body
  }
  const helpers = { httpRequest }

  async function preAuth() {
    state.preAuthRuns += 1
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
    logger: { warn: (msg) => state.warnings.push(msg), info: () => {}, debug: () => {}, error: () => {} },
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
  return { ctx, state }
}

async function runOnce({ url, agentId, agentSecret, params }) {
  const { ctx, state } = makeContext({ url, agentId, agentSecret, params })
  try {
    const out = await new Vrymnox().execute.call(ctx)
    return { ...out[0][0].json, _preAuthRuns: state.preAuthRuns, _warnings: state.warnings }
  } catch (e) {
    return { thrown: e.message, _preAuthRuns: state.preAuthRuns, _warnings: state.warnings }
  }
}

// ------------------------------------------------------------------ the offline Safe Mode suite
async function safeModeTests() {
  const assert = require('node:assert/strict')
  const http = require('node:http')
  const { maskText, maskValue, luhn } = require('./dist/nodes/Vrymnox/safeMode.js')

  // A stub gateway: /v1/token always issues a token; /v1/node/run does what `mode` says.
  async function stub(mode) {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const send = (status, body, type = 'application/json') => {
          res.writeHead(status, { 'content-type': type })
          res.end(typeof body === 'string' ? body : JSON.stringify(body))
        }
        if (req.url === '/v1/token') return send(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 600 })
        if (mode === 'hang') return // never answers
        if (mode === 'quota') {
          return send(402, { node_version: '1', ok: false, decision: 'error', output: null, redactions: {},
            error: { code: 'quota_exhausted', message: 'The monthly allowance is used up.', retryable: false,
              upgrade_url: 'https://app.example.test/billing' } })
        }
        if (mode === 'agents') {
          return send(402, { node_version: '1', ok: false, decision: 'error', output: null, redactions: {},
            error: { code: 'agent_limit', message: 'Past the agent limit.', retryable: false } })
        }
        if (mode === 'proxy502') return send(502, '<html><body>Bad gateway</body></html>', 'text/html')
        if (mode === 'unavailable') {
          return send(503, { node_version: '1', ok: false, decision: 'error', output: null, redactions: {},
            error: { code: 'unavailable', message: 'Fail closed.', retryable: true } })
        }
        if (mode === 'refuse') {
          return send(403, { node_version: '1', ok: false, decision: 'block', output: null, redactions: {},
            error: { code: 'tool_not_allowed', message: 'Not on the allowlist.', retryable: false } })
        }
        const doc = JSON.parse(raw || '{}')
        if (mode === 'echo') return send(200, { node_version: '1', ok: true, decision: 'allow', output: doc.params, redactions: {}, rules: [] })
        return send(200, { node_version: '1', ok: true, decision: 'allow', output: `gateway:${JSON.stringify(doc.input)}`,
          redactions: {}, rules: [], audit: { trace_id: 't' } })
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
  }
  // A port nothing listens on.
  async function deadUrl() {
    const s = http.createServer()
    await new Promise((r) => s.listen(0, '127.0.0.1', r))
    const port = s.address().port
    await new Promise((r) => s.close(r))
    return `http://127.0.0.1:${port}`
  }
  const sample = { note: 'Mail jane@example.com, card 4242 4242 4242 4242, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' }
  const run = (url, params) => runOnce({ url, agentId: 'agt-test', agentSecret: 'vrym_agent_test', params })

  const tests = []
  const test = (name, fn) => tests.push([name, fn])

  test('detectors: every public-grade type is masked in the gateway format', () => {
    const r = {}
    const text = [
      'jane@example.com', '4242 4242 4242 4242', '4242-4242-4242-4241 (not Luhn)', '123-45-6789',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----',
      'sk-proj-' + 'a'.repeat(30), 'sk-ant-api03-' + 'b'.repeat(30), 'sk_live_' + 'c'.repeat(24), 'rk_test_' + 'd'.repeat(24),
      'ghp_' + 'e'.repeat(36), 'github_pat_' + 'f'.repeat(30), 'AKIA' + 'ABCDEFGHIJKLMNOP',
      'aws_secret_access_key = ' + 'g'.repeat(40), 'AIza' + 'h'.repeat(35), 'xoxb-' + '1234567890-abcdef',
      'Authorization: Bearer ' + 'i'.repeat(32), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl',
      'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX',
    ].join('\n')
    const out = maskText(text, r)
    for (const t of ['EMAIL', 'CREDIT_CARD', 'SSN', 'PRIVATE_KEY', 'OPENAI_KEY', 'ANTHROPIC_KEY', 'STRIPE_KEY', 'GITHUB_TOKEN',
      'AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'GOOGLE_API_KEY', 'SLACK_TOKEN', 'BEARER_TOKEN', 'JWT', 'SLACK_WEBHOOK']) {
      assert.ok(r[t] >= 1, `${t} not masked: ${out}`)
      assert.ok(out.includes(`[REDACTED:${t}]`), t)
    }
    assert.equal(r.STRIPE_KEY, 2)
    assert.equal(r.GITHUB_TOKEN, 2)
    assert.equal(r.CREDIT_CARD, 1, 'a number that fails the Luhn check is not a card')
    assert.ok(out.includes('4242-4242-4242-4241'))
    for (const leak of ['jane@example.com', 'sk-ant-', 'ghp_', 'AKIA', 'MIIBOg', 'eyJ', 'gggggggggg']) assert.ok(!out.includes(leak), leak)
  })

  test('detectors: harmless text is left alone and SSN rules hold', () => {
    const r = {}
    const text = 'Order 1042 ships on 2026-03-14. Commit 9f8e7d6c5b4a. Call ext 4410. Invalid SSNs: 000-12-3456, 666-12-3456, 123-00-4567.'
    assert.equal(maskText(text, r), text)
    assert.deepEqual(r, {})
    assert.ok(luhn('4242424242424242') && !luhn('4242424242424241'))
  })

  test('detectors: JSON walk masks nested strings, secret fields and card numbers stored as numbers', () => {
    const { output, redactions } = maskValue({ a: [{ to: 'bob@example.org' }], creds: { password: 'hunter2hunter2', apiKey: 'not-a-known-format-1234' },
      card: 4242424242424242, count: 3, ok: true, none: null })
    assert.deepEqual(output, { a: [{ to: '[REDACTED:EMAIL]' }], creds: { password: '[REDACTED:SECRET]', apiKey: '[REDACTED:SECRET]' },
      card: '[REDACTED:CREDIT_CARD]', count: 3, ok: true, none: null })
    assert.deepEqual(redactions, { EMAIL: 1, SECRET: 2, CREDIT_CARD: 1 })
  })

  test('normal: a healthy gateway answers and Safe Mode stays out of the way', async () => {
    const g = await stub('ok')
    try {
      const out = await run(g.url, { operation: 'sanitize', input: { x: 1 } })
      assert.equal(out.ok, true)
      assert.equal(out.decision, 'allow')
      assert.equal(out.vrymdor, undefined)
    } finally { g.close() }
  })

  test('unreachable: masks locally, continues, marks degraded safe_mode', async () => {
    const out = await run(await deadUrl(), { operation: 'sanitize', input: sample })
    assert.equal(out.thrown, undefined, out.thrown)
    assert.equal(out.ok, true)
    assert.equal(out.decision, 'safe_mode')
    assert.equal(out.vrymdor.degraded, 'safe_mode')
    assert.equal(out.vrymdor.reason, 'unreachable')
    assert.equal(out.output.note, 'Mail [REDACTED:EMAIL], card [REDACTED:CREDIT_CARD], key [REDACTED:ANTHROPIC_KEY]')
    assert.deepEqual(out.redactions, { EMAIL: 1, CREDIT_CARD: 1, ANTHROPIC_KEY: 1 })
    assert.ok(out._warnings.length === 1 && out._warnings[0].includes('Safe Mode'))
  })

  test('timeout: a hanging gateway falls back within the budget', async () => {
    const g = await stub('hang')
    try {
      const started = Date.now()
      const out = await run(g.url, { operation: 'sanitize', input: sample, options: { timeoutMs: 300 } })
      assert.ok(Date.now() - started < 2500, 'took too long')
      assert.equal(out.vrymdor.degraded, 'safe_mode')
      assert.equal(out.vrymdor.reason, 'timeout')
      assert.ok(!JSON.stringify(out.output).includes('jane@example.com'))
    } finally { g.close() }
  })

  test('402 quota: Safe Mode plus an upgrade hint with the gateway upgrade link', async () => {
    const g = await stub('quota')
    try {
      const out = await run(g.url, { operation: 'sanitize', input: sample })
      assert.equal(out.ok, true)
      assert.equal(out.vrymdor.degraded, 'safe_mode')
      assert.equal(out.vrymdor.reason, 'quota_exhausted')
      assert.equal(out.vrymdor.upgrade_url, 'https://app.example.test/billing')
      assert.ok(out.vrymdor.upgrade_hint.includes('10,000 requests'))
      assert.ok(!JSON.stringify(out.output).includes('jane@example.com'))
    } finally { g.close() }
  })

  test('402 agent limit: Safe Mode with the agent hint and the default upgrade link', async () => {
    const g = await stub('agents')
    try {
      const out = await run(g.url, { operation: 'sanitize', input: sample })
      assert.equal(out.vrymdor.reason, 'agent_limit')
      assert.equal(out.vrymdor.upgrade_url, 'https://vrymdor.com/plans/')
      assert.ok(out.vrymdor.upgrade_hint.includes('2 agents'))
    } finally { g.close() }
  })

  test('402 with passthrough on still masks (passthrough is for outages only)', async () => {
    const g = await stub('quota')
    try {
      const out = await run(g.url, { operation: 'sanitize', input: sample, options: { allowPassthrough: true } })
      assert.equal(out.vrymdor.degraded, 'safe_mode')
      assert.ok(!JSON.stringify(out.output).includes('jane@example.com'))
    } finally { g.close() }
  })

  test('proxy error page (502) and fail closed 503 both fall back', async () => {
    for (const mode of ['proxy502', 'unavailable']) {
      const g = await stub(mode)
      try {
        const out = await run(g.url, { operation: 'sanitize', input: sample })
        assert.equal(out.vrymdor.degraded, 'safe_mode', mode)
        assert.equal(out.vrymdor.reason, 'unavailable', mode)
      } finally { g.close() }
    }
  })

  test('passthrough only when the option is explicitly on, and it says so', async () => {
    const out = await run(await deadUrl(), { operation: 'sanitize', input: sample, options: { allowPassthrough: true } })
    assert.equal(out.vrymdor.degraded, 'passthrough')
    assert.deepEqual(out.output, sample)
    assert.deepEqual(out.redactions, {})
    assert.ok(out.vrymdor.message.startsWith('Unmasked passthrough'))
  })

  test('forward actions on outage: not run, input masked, ok false, workflow continues', async () => {
    const out = await run(await deadUrl(), { operation: 'tool', upstream: 'github', tool: 'create_issue', input: sample })
    assert.equal(out.thrown, undefined)
    assert.equal(out.ok, false)
    assert.equal(out.error.code, 'safe_mode')
    assert.equal(out.vrymdor.action_ran, false)
    assert.ok(!JSON.stringify(out.output).includes('jane@example.com'))
  })

  test('policy refusals are not outages: they still raise the n8n error', async () => {
    const g = await stub('refuse')
    try {
      const out = await run(g.url, { operation: 'tool', upstream: 'github', tool: 'drop_db', input: {} })
      assert.ok(out.thrown && out.thrown.includes('tool_not_allowed'), JSON.stringify(out))
    } finally { g.close() }
  })

  test('a wrong agent secret is not an outage: the error is raised', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad_credentials' }))
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    try {
      const out = await run(`http://127.0.0.1:${server.address().port}`, { operation: 'sanitize', input: sample })
      assert.ok(out.thrown, JSON.stringify(out))
    } finally { server.close() }
  })

  test('shadow mode: sends shadow on Remove PII only, and an outage passes the input on unchanged', async () => {
    const g = await stub('echo')
    try {
      const out = await run(g.url, { operation: 'sanitize', input: { x: 1 }, options: { shadow: true } })
      assert.deepEqual(out.output, { dry_run: false, shadow: true })
      const llm = await run(g.url, { operation: 'llm', upstream: 'anthropic', path: 'v1/messages', input: { x: 1 }, options: { shadow: true } })
      assert.equal(llm.output && llm.output.shadow, undefined)
    } finally { g.close() }
    const down = await run(await deadUrl(), { operation: 'sanitize', input: sample, options: { shadow: true } })
    assert.equal(down.vrymdor.degraded, 'shadow')
    assert.deepEqual(down.output, sample)
  })

  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log(`ok   ${name}`)
    } catch (e) {
      failed += 1
      console.log(`FAIL ${name}\n     ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e}`)
    }
  }
  console.log(`${tests.length - failed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}

if (process.argv.includes('--safe-mode-tests')) {
  safeModeTests()
} else {
  const params = JSON.parse(process.env.NODE_PARAMS)
  runOnce({ url: process.env.VRYMNOX_NODE_URL, agentId: process.env.AGENT_ID, agentSecret: process.env.AGENT_SECRET, params })
    .then((out) => console.log(JSON.stringify(out)))
}
