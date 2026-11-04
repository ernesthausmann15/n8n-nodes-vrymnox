import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
  sleep,
  type IDataObject,
  type IHttpRequestMethods,
  type JsonObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow'

type NodeResponse = {
  ok: boolean
  decision: 'allow' | 'hold' | 'block' | 'error'
  output?: unknown
  hold_id?: string | null
  error?: { code: string; message: string; retryable: boolean } | null
  redactions?: Record<string, number>
  audit?: { hash?: string; trace_id?: string } | null
}

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
        description: 'The data to clean, the tool arguments, the model request body, or the webhook payload',
      },
      {
        displayName: 'Wait for Approval',
        name: 'waitForApproval',
        type: 'boolean',
        default: true,
        description: 'Whether to wait when a person must approve the action first (high-risk tools). Off returns the hold ID at once.',
        displayOptions: { show: { operation: ['tool', 'llm', 'webhook'] } },
      },
      {
        displayName: 'Wait Up To (Minutes)',
        name: 'waitMinutes',
        type: 'number',
        default: 15,
        typeOptions: { minValue: 1, maxValue: 60 },
        displayOptions: { show: { waitForApproval: [true] } },
      },
    ],
  }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const creds = await this.getCredentials('vrymnoxApi')
    const base = String(creds.gatewayUrl).replace(/\/+$/, '')
    // Every call goes through the credential (preAuthentication trades the agent secret for a gateway
    // token). Refusals are answered as a NodeResponse body, so HTTP errors are read rather than thrown.
    const call = async (method: IHttpRequestMethods, path: string, body?: IDataObject): Promise<NodeResponse> => {
      const send = async () =>
        (await this.helpers.httpRequestWithAuthentication.call(this, 'vrymnoxApi', {
          method,
          url: `${base}${path}`,
          body,
          json: true,
          ignoreHttpStatusErrors: true,
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
        // A stable key per execution, node and item: n8n retries never run the action twice.
        const key = `${this.getExecutionId()}:${this.getNode().id}:${i}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128)
        const request = {
          node_version: '1',
          action,
          input,
          context: { platform: 'n8n', workflow: String(this.getWorkflow().id ?? '').slice(0, 200) },
          params: { dry_run: op === 'check' },
          idempotency_key: key.length >= 8 ? key : undefined,
        }
        let out = await call('POST', '/v1/node/run', request as unknown as IDataObject)

        if (out.decision === 'hold' && out.hold_id && op !== 'check' && this.getNodeParameter('waitForApproval', i, true)) {
          const until = Date.now() + (this.getNodeParameter('waitMinutes', i, 15) as number) * 60_000
          while (out.decision === 'hold' && Date.now() < until) {
            await sleep(5_000)
            out = await call('GET', `/v1/node/holds/${out.hold_id}`)
          }
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
