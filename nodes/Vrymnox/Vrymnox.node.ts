import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
  type IDataObject,
  type IHttpRequestMethods,
  type JsonObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow'

import { maskValue } from './safeMode'

type NodeResponse = {
  ok: boolean
  decision: 'allow' | 'hold' | 'block' | 'error'
  output?: unknown
  hold_id?: string | null
  error?: { code: string; message: string; retryable: boolean; upgrade_url?: string } | null
  redactions?: Record<string, number>
  audit?: { hash?: string; trace_id?: string } | null
}

/** Why the node fell back to Safe Mode for an item. */
type Outage = {
  reason: 'unreachable' | 'timeout' | 'unavailable' | 'quota_exhausted' | 'agent_limit'
  upgradeUrl?: string
}

const DEFAULT_TIMEOUT_MS = 3_000
const FORWARD_TIMEOUT_MS = 120_000
const UPGRADE_URL = 'https://vrymdor.com/plans/'
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'VRYMDOR_BUDGET', 'UND_ERR_HEADERS_TIMEOUT'])

/**
 * Vrymnox AI Node. Every operation is one NodeRequest to the gateway's POST /v1/node/run, so each step is
 * checked against the agent's identity and policy, PII and secrets are removed, and an audit record is
 * written. The node itself never runs code: it asks the gateway to run one allowed action.
 */
export class Vrymnox implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Vrymnox',
    name: 'vrymnox',
    icon: 'file:vrymnox.svg',
    group: ['transform'],
    version: 1,
    usableAsTool: true,
    subtitle: '={{$parameter["operation"]}}',
    description: 'Run tools, model calls and webhooks through Vrymnox: policy, PII redaction and audit on every step',
    defaults: { name: 'Vrymnox' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'vrymnoxApi', required: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'sanitize',
        options: [
          { name: 'Call a Model', value: 'llm', action: 'Call a model' },
          { name: 'Check Only (Dry Run)', value: 'check', action: 'Check an action without running it' },
          { name: 'Put Real Values Back (Rehydrate)', value: 'rehydrate', action: 'Put the real values back into an answer' },
          { name: 'Remove PII and Secrets', value: 'sanitize', action: 'Remove PII and secrets from data' },
          { name: 'Run a Tool', value: 'tool', action: 'Run an allowed MCP tool' },
          { name: 'Send a Webhook', value: 'webhook', action: 'Send data to a configured webhook' },
        ],
      },
      {
        displayName: 'Action Type',
        name: 'checkType',
        type: 'options',
        default: 'tool',
        options: [
          { name: 'Tool', value: 'tool' },
          { name: 'Model', value: 'llm' },
          { name: 'Webhook', value: 'webhook' },
        ],
        displayOptions: { show: { operation: ['check'] } },
      },
      {
        displayName: 'Upstream',
        name: 'upstream',
        type: 'string',
        default: '',
        placeholder: 'github',
        description: 'The name of an upstream configured on your gateway (VRYMNOX_UPSTREAMS)',
        displayOptions: { show: { operation: ['tool', 'llm', 'webhook', 'check'] } },
      },
      {
        displayName: 'Tool',
        name: 'tool',
        type: 'string',
        default: '',
        placeholder: 'create_issue',
        displayOptions: { show: { operation: ['tool'] } },
      },
      {
        displayName: 'Tool',
        name: 'checkTool',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['check'], checkType: ['tool'] } },
      },
      {
        displayName: 'API Path',
        name: 'path',
        type: 'string',
        default: 'v1/messages',
        displayOptions: { show: { operation: ['llm'] } },
      },
      {
        displayName: 'Input',
        name: 'input',
        type: 'json',
        default: '={{ $json }}',
        description: 'The data to clean, the tool arguments, the model request body, the webhook payload, or (for Put Real Values Back) the model answer with its tokens',
      },
      {
        displayName: 'Map ID',
        name: 'mapId',
        type: 'string',
        default: '',
        placeholder: "={{ $('Vrymnox').item.json.map_id }}",
        description: 'The map_id from the Remove PII and Secrets step that had Rehydrate on. The real values stay in your AI Node; this only points to them.',
        displayOptions: { show: { operation: ['rehydrate'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Allow Unmasked Passthrough on Outage',
            name: 'allowPassthrough',
            type: 'boolean',
            default: false,
            description:
              'Whether to pass the input on UNMASKED when the AI Node cannot be reached or its free allowance is used up. Warning: personal data and secrets can then reach the next step. Off (the default) masks the input locally with Safe Mode instead. Every passthrough is marked vrymdor.degraded = "passthrough" and logged.',
          },
          {
            displayName: 'Rehydrate (Give the Answer Its Real Values Back)',
            name: 'rehydrate',
            type: 'boolean',
            default: false,
            description:
              'Whether each private value gets its own numbered token, such as [REDACTED:EMAIL_1], so the real values can be put back. On Call a Model the answer comes back with the real values in one step. On Remove PII and Secrets the output carries a map_id; after your model step, add a Vrymnox step with Put Real Values Back and that map_id. The values never reach the model. Restore is strict: if the model makes up or damages a token, nothing is put back.',
          },
          {
            displayName: 'Forget the Map After Restoring',
            name: 'dropMap',
            type: 'boolean',
            default: true,
            description: 'Whether Put Real Values Back deletes the map from your AI Node once the values are back. Turn off to restore more than one answer from the same map.',
          },
          {
            displayName: 'Shadow Mode (Report Only)',
            name: 'shadow',
            type: 'boolean',
            default: false,
            description:
              'Whether Remove PII and Secrets only reports what it would mask (vrymdor report and redactions) and passes the input on unchanged. Use it to see your own leak report before you turn masking on. Off (the default) masks. Model, tool and webhook calls always mask.',
          },
          {
            displayName: 'Timeout Budget (Ms)',
            name: 'timeoutMs',
            type: 'number',
            default: DEFAULT_TIMEOUT_MS,
            typeOptions: { minValue: 100, maxValue: 60_000 },
            description:
              'How long Remove PII and Secrets and Check Only wait for the AI Node before Safe Mode masks the item locally. Model, tool and webhook calls wait up to 120 seconds (or this value if larger), since the upstream does the work.',
          },
        ],
      },
    ],
  }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const creds = await this.getCredentials('vrymnoxApi')
    const base = String(creds.gatewayUrl).replace(/\/+$/, '')
    // Every call goes through the credential (preAuthentication trades the agent secret for a gateway
    // token). Refusals are answered as a NodeResponse body, so HTTP errors are read rather than thrown.
    const call = async (method: IHttpRequestMethods, path: string, body?: IDataObject, timeout?: number): Promise<NodeResponse> => {
      const send = async () =>
        (await this.helpers.httpRequestWithAuthentication.call(this, 'vrymnoxApi', {
          method,
          url: `${base}${path}`,
          body,
          json: true,
          ignoreHttpStatusErrors: true,
          ...(timeout ? { timeout } : {}),
        })) as NodeResponse
      let out = await send()
      if (out?.error?.code === 'unauthenticated') {
        // The stored gateway token expired. A request that fails with HTTP 401 makes n8n trade the secret
        // again; the probe asks for a hold that does not exist, so nothing runs. Then send once more.
        try {
          await this.helpers.httpRequestWithAuthentication.call(this, 'vrymnoxApi', {
            method: 'GET',
            url: `${base}/v1/node/holds/token-refresh`,
            json: true,
          })
        } catch {
          // A 404 after the refresh is the expected answer.
        }
        out = await send()
      }
      return out
    }
    const items = this.getInputData()
    const results: INodeExecutionData[] = []

    for (let i = 0; i < items.length; i++) {
      try {
        const op = this.getNodeParameter('operation', i) as string
        const rawInput = this.getNodeParameter('input', i) as unknown
        const input = typeof rawInput === 'string' ? safeParse(rawInput) : rawInput
        const type = op === 'check' ? (this.getNodeParameter('checkType', i) as string) : op
        const action: IDataObject = { type }
        if (type !== 'sanitize') action.upstream = this.getNodeParameter('upstream', i) as string
        if (op === 'tool') action.tool = this.getNodeParameter('tool', i) as string
        if (op === 'check' && type === 'tool') action.tool = this.getNodeParameter('checkTool', i) as string
        if (op === 'llm') action.path = this.getNodeParameter('path', i) as string
        if (op === 'rehydrate') delete action.upstream
        // A stable key per execution, node and item: n8n retries never run the action twice.
        const key = `${this.getExecutionId()}:${this.getNode().id}:${i}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128)
        const options = this.getNodeParameter('options', i, {}) as IDataObject
        const shadow = op === 'sanitize' && options.shadow === true
        const params: IDataObject = shadow ? { dry_run: false, shadow: true } : { dry_run: op === 'check' }
        if (options.rehydrate === true && op === 'sanitize' && !shadow) params.keep_map = true
        if (options.rehydrate === true && op === 'llm') params.rehydrate = true
        if (op === 'rehydrate') {
          params.map_id = String(this.getNodeParameter('mapId', i) ?? '').trim()
          params.drop_map = options.dropMap !== false
        }
        const request = {
          node_version: '1',
          action,
          input,
          context: { platform: 'n8n', workflow: String(this.getWorkflow().id ?? '').slice(0, 200) },
          params,
          idempotency_key: key.length >= 8 ? key : undefined,
        }
        const budget = Math.max(100, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
        const wait = op === 'sanitize' || op === 'check' ? budget : Math.max(budget, FORWARD_TIMEOUT_MS)
        let out: NodeResponse
        let outage: Outage | null
        try {
          out = await withBudget(call('POST', '/v1/node/run', request as unknown as IDataObject, wait), wait)
          outage = outageFromResponse(out)
        } catch (error) {
          outage = outageFromError(error)
          if (outage === null) throw error
          out = { ok: false, decision: 'error' }
        }
        if (outage !== null && op === 'rehydrate') {
          // The real values live only in the AI Node, so nothing can come back without it: the answer goes on with
          // its tokens, never a guess.
          results.push({ json: { ok: false, decision: 'error', output: input as IDataObject,
            vrymdor: { degraded: 'no_rehydrate', reason: outage.reason,
              message: 'The AI Node could not be reached, so no value was put back. The answer goes on with its tokens.' } },
          pairedItem: { item: i } })
          continue
        }
        if (outage !== null && shadow) {
          // Shadow mode changes nothing by choice, so an outage changes nothing either: no report this time.
          results.push({ json: { ok: true, decision: 'allow', output: input as IDataObject, redactions: {},
            vrymdor: { degraded: 'shadow', reason: outage.reason,
              message: 'Shadow mode: the AI Node could not be reached, so no report was made and the input went on unchanged, as shadow mode does.' } },
          pairedItem: { item: i } })
          continue
        }
        if (outage !== null) {
          // Never stop, never send raw: the item is masked locally and the workflow goes on.
          const item = safeModeItem(op, input, outage, options.allowPassthrough === true)
          this.logger?.warn(`Vrymdor Safe Mode (${outage.reason}): ${(item.vrymdor as IDataObject).degraded}`, {
            node: this.getNode().name, item: i })
          results.push({ json: item, pairedItem: { item: i } })
          continue
        }

        if (out.decision === 'hold' && op !== 'check') {
          // Customers never approve anything (owner rule): the node does not wait or ask anyone. A held action did
          // not run; the item says so and the workflow continues.
          const held = { ...(out as unknown as IDataObject) }
          held.vrymdor = { held: true, action_ran: false,
            message: 'Your policy held this action, so it did not run. The workflow continued.' }
          results.push({ json: held, pairedItem: { item: i } })
          continue
        }
        if (!out.ok && out.decision !== 'hold') {
          const err = out.error ?? { code: 'error', message: 'The action was refused.', retryable: false }
          throw new NodeOperationError(this.getNode(), `Vrymnox ${err.code}: ${err.message}`, { itemIndex: i })
        }
        results.push({ json: { ...(out as unknown as IDataObject) }, pairedItem: { item: i } })
      } catch (error) {
        if (this.continueOnFail()) {
          results.push({ json: { error: (error as Error).message }, pairedItem: { item: i } })
          continue
        }
        if (error instanceof NodeOperationError) {
          throw new NodeOperationError(this.getNode(), error, { itemIndex: i })
        }
        throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i })
      }
    }
    return [results]
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Rejects with a VRYMDOR_BUDGET error when the promise takes longer than `ms` (the token exchange included). */
function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Vrymdor AI Node did not answer within ${ms} ms`),
      { code: 'VRYMDOR_BUDGET' })), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/** An answer that means the AI Node could not serve the item: a plan limit, or no real gateway answer at all. */
export function outageFromResponse(out: unknown): Outage | null {
  if (out === null || typeof out !== 'object' || typeof (out as NodeResponse).ok !== 'boolean') {
    return { reason: 'unavailable' } // a proxy error page or an empty body, not the gateway's NodeResponse
  }
  const err = (out as NodeResponse).error
  const code = err?.code
  if (code === 'quota_exhausted' || code === 'agent_limit') return { reason: code, upgradeUrl: err?.upgrade_url || UPGRADE_URL }
  if (code === 'unavailable') return { reason: 'unavailable' }
  if (code === 'timeout') return { reason: 'timeout' }
  return null
}

/** A thrown error that means the AI Node is down, slow or out of allowance; null for anything else (rethrown). */
export function outageFromError(error: unknown): Outage | null {
  const seen: Record<string, unknown>[] = []
  let e: unknown = error
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth++) {
    seen.push(e as Record<string, unknown>)
    e = (e as Record<string, unknown>).cause
  }
  const codes = new Set<string>()
  const statuses = new Set<number>()
  let text = ''
  for (const o of seen) {
    for (const k of ['code', 'errno', 'name']) if (typeof o[k] === 'string') codes.add(o[k] as string)
    for (const k of ['httpCode', 'statusCode', 'status']) {
      const n = Number(o[k])
      if (Number.isInteger(n) && n > 0) statuses.add(n)
    }
    const res = o.response as Record<string, unknown> | undefined
    if (res && Number.isInteger(Number(res.status))) statuses.add(Number(res.status))
    if (typeof o.message === 'string') text += ` ${o.message}`
  }
  if (statuses.has(402)) return { reason: 'quota_exhausted', upgradeUrl: UPGRADE_URL }
  if (statuses.has(502) || statuses.has(503) || statuses.has(504)) return { reason: 'unavailable' }
  if ([...codes].some((c) => TIMEOUT_CODES.has(c)) || codes.has('TimeoutError') || /timed? ?out/i.test(text)) {
    return { reason: 'timeout' }
  }
  if ([...codes].some((c) => NETWORK_CODES.has(c)) ||
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|getaddrinfo/i.test(text)) {
    return { reason: 'unreachable' }
  }
  return null
}

const REASON_TEXT: Record<Outage['reason'], string> = {
  unreachable: 'the Vrymdor AI Node could not be reached',
  timeout: 'the Vrymdor AI Node did not answer within the timeout budget',
  unavailable: 'the Vrymdor AI Node was unavailable',
  quota_exhausted: "the Community plan's monthly requests are used up",
  agent_limit: "this agent is past the Community plan's agent limit",
}

/** The item Safe Mode returns: the input masked locally (or raw, only with passthrough on), marked degraded. */
export function safeModeItem(op: string, input: unknown, outage: Outage, allowPassthrough: boolean): IDataObject {
  const plan = outage.reason === 'quota_exhausted' || outage.reason === 'agent_limit'
  // Passthrough is for outages only: a used up allowance is always masked locally.
  const passthrough = allowPassthrough && !plan
  const masked = passthrough ? { output: input, redactions: {} } : maskValue(input)
  const forward = op !== 'sanitize'
  const vrymdor: IDataObject = {
    degraded: passthrough ? 'passthrough' : 'safe_mode',
    reason: outage.reason,
    message: passthrough
      ? `Unmasked passthrough: ${REASON_TEXT[outage.reason]}, and this step allows passthrough on outage, so the input went on unmasked.`
      : `Safe Mode: ${REASON_TEXT[outage.reason]}, so this item was masked locally and the workflow continued.`,
    action_ran: !forward ? null : op !== 'check' && outage.reason === 'timeout' ? 'unknown' : false,
  }
  if (plan) {
    vrymdor.upgrade_url = outage.upgradeUrl || UPGRADE_URL
    vrymdor.upgrade_hint = outage.reason === 'agent_limit'
      ? `Community includes up to 2 agents. Pro includes up to 15, with a 14 day free trial: ${vrymdor.upgrade_url}`
      : `Community includes 10,000 requests a month. Pro includes 100,000, with a 14 day free trial: ${vrymdor.upgrade_url}`
  }
  return {
    node_version: '1',
    ok: !forward,
    decision: 'safe_mode',
    output: masked.output as IDataObject,
    redactions: masked.redactions,
    rules: [passthrough ? 'safe_mode_passthrough' : 'safe_mode'],
    hold_id: null,
    audit: null,
    error: forward
      ? { code: 'safe_mode', retryable: true,
        message: `The ${op} action did not run through the AI Node (${REASON_TEXT[outage.reason]}). The output is the input, masked locally.` }
      : null,
    vrymdor,
  }
}
