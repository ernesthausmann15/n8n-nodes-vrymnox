import type {
  IAuthenticateGeneric,
  ICredentialDataDecryptedObject,
  ICredentialTestRequest,
  ICredentialType,
  IHttpRequestHelper,
  INodeProperties,
} from 'n8n-workflow'

/**
 * A Vrymnox agent identity: the gateway's address plus the agent id and secret from the Vrymdor app
 * (AI agents, Register an agent). n8n trades the secret for a short-lived gateway token (preAuthentication)
 * and keeps that token in the hidden, expirable Session Token field; when the gateway answers 401, n8n
 * trades the secret again. n8n stores the credential encrypted like every other credential.
 */
export class VrymnoxApi implements ICredentialType {
  name = 'vrymnoxApi'
  displayName = 'Vrymnox Agent API'
  documentationUrl = 'https://docs.vrymdor.com/ai-node.html'
  icon = 'file:../nodes/Vrymnox/vrymnox.svg' as const
  properties: INodeProperties[] = [
    {
      // Shown as "Node Host URL" (the Mission Brief's field name); the key stays gatewayUrl so saved credentials work.
      displayName: 'Node Host URL',
      name: 'gatewayUrl',
      type: 'string',
      default: 'http://vrymnox-gateway:8080',
      placeholder: 'http://vrymnox-gateway:8080',
      description: 'Your Vrymdor AI Node address, reachable from this n8n instance (the Node Host URL in the Vrymdor app)',
    },
    { displayName: 'Agent ID', name: 'agentId', type: 'string', default: '', placeholder: 'agt_3f9c2a7d1b8e4f60' },
    {
      displayName: 'Agent Secret',
      name: 'agentSecret',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'Shown once when the agent was registered (starts with vrym_agent_)',
    },
    {
      displayName: 'Session Token',
      name: 'sessionToken',
      type: 'hidden',
      typeOptions: { expirable: true, password: true },
      default: '',
    },
  ]

  async preAuthentication(this: IHttpRequestHelper, credentials: ICredentialDataDecryptedObject) {
    const base = String(credentials.gatewayUrl).replace(/\/+$/, '')
    const out = (await this.helpers.httpRequest({
      method: 'POST',
      url: `${base}/v1/token`,
      body: { agent_id: credentials.agentId, agent_secret: credentials.agentSecret },
      json: true,
    })) as { access_token: string }
    return { sessionToken: out.access_token }
  }

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.sessionToken}}' } },
  }

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.gatewayUrl}}',
      url: '/v1/token',
      method: 'POST',
      body: { agent_id: '={{$credentials.agentId}}', agent_secret: '={{$credentials.agentSecret}}' },
    },
  }
}
