import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import type { Capability, Connection, ConnectionProvider, NewConnection, Store } from './store.js'

const ENDPOINTS = {
  github: 'https://api.githubcopilot.com/mcp/readonly',
  gmail: 'https://gmail.googleapis.com',
  vercel: 'https://api.vercel.com',
  telegram: 'https://api.telegram.org',
} as const

type Credentials = Record<string, string | number | undefined>

export type ConnectionConfig = {
  encryptionKey: string
  publicApiUrl: string
  webUrl: string
  githubClientId?: string
  githubClientSecret?: string
  googleClientId?: string
  googleClientSecret?: string
}

export class ConnectionError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
  }
}

export class ConnectionService {
  private readonly key: Buffer

  constructor(
    private readonly store: Store,
    private readonly config: ConnectionConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.key = Buffer.from(config.encryptionKey, 'base64')
    if (this.key.length !== 32) throw new Error('CONNECTION_ENCRYPTION_KEY must be 32 bytes encoded as base64')
  }

  async createManual(ownerId: string, input: {
    provider: 'vercel' | 'telegram' | 'custom_mcp'
    name: string
    endpointUrl?: string
    authType?: 'none' | 'bearer'
    token?: string
  }) {
    const definition = await this.manualDefinition(input)
    const connection = await this.store.createConnection(ownerId, definition.connection, this.encrypt(definition.credentials))
    return this.test(ownerId, connection.id)
  }

  encryptApiKey(apiKey: string) {
    return this.encrypt({ apiKey })
  }

  decryptApiKey(encryptedApiKey: string) {
    return requiredCredential(this.decrypt(encryptedApiKey), 'apiKey')
  }

  encryptCallbackUrl(callbackUrl: string) {
    return this.encrypt({ callbackUrl })
  }

  decryptCallbackUrl(encryptedCallbackUrl: string) {
    return requiredCredential(this.decrypt(encryptedCallbackUrl), 'callbackUrl')
  }

  async update(ownerId: string, connectionId: string, input: {
    name?: string
    endpointUrl?: string
    authType?: 'none' | 'bearer'
    token?: string
  }) {
    const existing = await this.store.getConnection(ownerId, connectionId)
    if (!existing) throw new ConnectionError('connection_not_found')
    if (input.endpointUrl !== undefined && existing.provider !== 'custom_mcp') {
      throw new ConnectionError('endpoint_not_editable')
    }

    const changes: Partial<Pick<Connection, 'name' | 'endpoint_url' | 'auth_type'>> = {}
    if (input.name !== undefined) changes.name = input.name
    if (input.endpointUrl !== undefined) {
      await validatePublicEndpoint(input.endpointUrl)
      changes.endpoint_url = input.endpointUrl
    }
    if (input.authType !== undefined) changes.auth_type = input.authType

    let encryptedPayload: string | undefined
    if (input.token !== undefined || input.authType !== undefined) {
      const credentials = this.decrypt(existing.encrypted_payload)
      if (input.token !== undefined) credentials.token = input.token
      if (input.authType === 'none') delete credentials.token
      encryptedPayload = this.encrypt(credentials)
    }

    const connection = await this.store.updateConnection(ownerId, connectionId, changes, encryptedPayload)
    if (!connection) throw new ConnectionError('connection_not_found')
    return this.test(ownerId, connectionId)
  }

  async test(ownerId: string, connectionId: string) {
    const stored = await this.store.getConnection(ownerId, connectionId)
    if (!stored) throw new ConnectionError('connection_not_found')

    try {
      const credentials = this.decrypt(stored.encrypted_payload)
      const result = await this.smokeTest(stored, credentials)
      if (result.credentials) {
        await this.store.updateConnectionSecret(connectionId, this.encrypt(result.credentials))
      }
      return await this.store.setConnectionTest(ownerId, connectionId, {
        status: 'connected',
        accountLabel: result.accountLabel,
        error: null,
      })
    } catch (error) {
      const message = safeTestError(error)
      return await this.store.setConnectionTest(ownerId, connectionId, {
        status: 'failed',
        accountLabel: null,
        error: message,
      })
    }
  }

  async startOAuth(
    ownerId: string,
    provider: 'github' | 'gmail',
    name: string,
    connectionId: string | null,
  ) {
    if (connectionId && !(await this.store.getConnection(ownerId, connectionId))) {
      throw new ConnectionError('connection_not_found')
    }
    const clientId = provider === 'github' ? this.config.githubClientId : this.config.googleClientId
    if (!clientId) throw new ConnectionError('provider_not_configured')

    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    await this.store.createOAuthState(hash(state), {
      ownerId,
      provider,
      connectionName: name,
      connectionId,
      codeVerifier: verifier,
    }, new Date(Date.now() + 10 * 60_000).toISOString())

    const callback = `${this.config.publicApiUrl.replace(/\/$/, '')}/v1/connections/oauth/${provider}/callback`
    const url = new URL(provider === 'github'
      ? 'https://github.com/login/oauth/authorize'
      : 'https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', callback)
    url.searchParams.set('state', state)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')
    if (provider === 'github') {
      url.searchParams.set('scope', 'read:user repo')
    } else {
      url.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/gmail.readonly')
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'consent')
    }
    return url.toString()
  }

  async finishOAuth(provider: 'github' | 'gmail', state: string, code: string) {
    const oauth = await this.store.consumeOAuthState(hash(state), provider)
    if (!oauth) throw new ConnectionError('invalid_oauth_state')

    const credentials = provider === 'github'
      ? await this.exchangeGithubCode(code, oauth.codeVerifier)
      : await this.exchangeGoogleCode(code, oauth.codeVerifier)
    const connection: NewConnection = {
      name: oauth.connectionName,
      provider,
      protocol: provider === 'github' ? 'mcp' : 'rest',
      endpoint_url: ENDPOINTS[provider],
      auth_type: 'oauth',
    }

    const saved = oauth.connectionId
      ? await this.store.updateConnection(oauth.ownerId, oauth.connectionId, { name: oauth.connectionName }, this.encrypt(credentials))
      : await this.store.createConnection(oauth.ownerId, connection, this.encrypt(credentials))
    if (!saved) throw new ConnectionError('connection_not_found')
    return this.test(oauth.ownerId, saved.id)
  }

  redirectUrl(result: { provider?: string; error?: string }) {
    const url = new URL('/connections', this.config.webUrl)
    if (result.provider) url.searchParams.set('connected', result.provider)
    if (result.error) url.searchParams.set('error', result.error)
    return url.toString()
  }

  async discoverCapabilities(ownerId: string) {
    const connections = (await this.store.listConnections(ownerId)).filter(({ status }) => status === 'connected')
    const discovered = await Promise.all(connections.map(async (connection) => {
      try {
        return await this.discoverConnectionCapabilities(ownerId, connection.id)
      } catch {
        return []
      }
    }))
    return discovered.flat()
  }

  async discoverConnectionCapabilities(ownerId: string, connectionId: string): Promise<Capability[]> {
    const connection = await this.store.getConnection(ownerId, connectionId)
    if (!connection || connection.status !== 'connected') return []
    if (connection.protocol === 'rest') return restCapabilities(connection)

    const credentials = this.decrypt(connection.encrypted_payload)
    const token = connection.provider === 'github'
      ? requiredCredential(credentials, 'accessToken')
      : connection.auth_type === 'bearer'
        ? requiredCredential(credentials, 'token')
        : undefined
    const tools = await this.listMcpTools(connection.endpoint_url, token, connection.provider === 'custom_mcp')
    return tools.flatMap((tool) => {
      if (tool.annotations?.destructiveHint === true) return []
      const safety = tool.annotations?.readOnlyHint === true ? 'verified_read' as const : 'unannotated' as const
      const inputSchema = sanitizeSchema(tool.inputSchema)
      return [{
        id: `${connection.id}:mcp:${tool.name}`,
        connection_id: connection.id,
        connection_name: connection.name,
        provider: connection.provider,
        protocol: 'mcp' as const,
        account_label: connection.account_label,
        name: tool.name,
        title: clip(tool.title ?? tool.name, 160),
        description: clip(tool.description ?? '', 1000),
        input_schema: inputSchema,
        schema_hash: hash(JSON.stringify(inputSchema)),
        safety,
        callable_during_setup: safety === 'verified_read',
      }]
    })
  }

  async callSetupCapability(ownerId: string, capability: Capability, input: Record<string, unknown>) {
    if (!capability.callable_during_setup) throw new ConnectionError('capability_not_safe')
    const connection = await this.store.getConnection(ownerId, capability.connection_id)
    if (!connection || connection.status !== 'connected') throw new ConnectionError('connection_not_found')

    if (connection.protocol === 'mcp') {
      const credentials = this.decrypt(connection.encrypted_payload)
      const token = connection.provider === 'github'
        ? requiredCredential(credentials, 'accessToken')
        : connection.auth_type === 'bearer'
          ? requiredCredential(credentials, 'token')
          : undefined
      return await this.withMcpClient(connection.endpoint_url, token, connection.provider === 'custom_mcp', async (client) => {
        return await client.callTool({ name: capability.name, arguments: input })
      })
    }

    const credentials = this.decrypt(connection.encrypted_payload)
    if (capability.name === 'gmail.search_messages') {
      const current = await this.refreshGoogleCredentials(credentials)
      if (JSON.stringify(current) !== JSON.stringify(credentials)) {
        await this.store.updateConnectionSecret(connection.id, this.encrypt(current))
      }
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
      if (typeof input.query === 'string' && input.query) url.searchParams.set('q', input.query)
      url.searchParams.set('maxResults', String(Math.min(Number(input.limit) || 10, 20)))
      return await this.json(url.toString(), { headers: providerHeaders(requiredCredential(current, 'accessToken')) })
    }
    if (capability.name === 'vercel.list_projects') {
      const url = new URL('https://api.vercel.com/v9/projects')
      url.searchParams.set('limit', String(Math.min(Number(input.limit) || 20, 20)))
      if (typeof input.search === 'string' && input.search) url.searchParams.set('search', input.search)
      return await this.json(url.toString(), { headers: providerHeaders(requiredCredential(credentials, 'token')) })
    }
    throw new ConnectionError('capability_not_found')
  }

  private async manualDefinition(input: {
    provider: 'vercel' | 'telegram' | 'custom_mcp'
    name: string
    endpointUrl?: string
    authType?: 'none' | 'bearer'
    token?: string
  }) {
    if (input.provider === 'custom_mcp') {
      if (!input.endpointUrl) throw new ConnectionError('endpoint_required')
      await validatePublicEndpoint(input.endpointUrl)
      const authType = input.authType ?? 'none'
      if (authType === 'bearer' && !input.token) throw new ConnectionError('token_required')
      return {
        connection: {
          name: input.name,
          provider: input.provider,
          protocol: 'mcp' as const,
          endpoint_url: input.endpointUrl,
          auth_type: authType,
        },
        credentials: input.token ? { token: input.token } : {},
      }
    }
    if (!input.token) throw new ConnectionError('token_required')
    return {
      connection: {
        name: input.name,
        provider: input.provider,
        protocol: 'rest' as const,
        endpoint_url: ENDPOINTS[input.provider],
        auth_type: 'bearer' as const,
      },
      credentials: { token: input.token },
    }
  }

  private async smokeTest(connection: Connection, credentials: Credentials) {
    if (connection.provider === 'github') {
      const token = requiredCredential(credentials, 'accessToken')
      const [tools, profile] = await Promise.all([
        this.listMcpTools(connection.endpoint_url, token, false),
        this.json('https://api.github.com/user', { headers: providerHeaders(token) }),
      ])
      return { accountLabel: String(profile.login ?? `${tools.length} tools`) }
    }
    if (connection.provider === 'gmail') {
      const current = await this.refreshGoogleCredentials(credentials)
      const profile = await this.json('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: providerHeaders(requiredCredential(current, 'accessToken')),
      })
      return { accountLabel: String(profile.emailAddress ?? 'Gmail'), credentials: current }
    }
    if (connection.provider === 'vercel') {
      const profile = await this.json('https://api.vercel.com/v2/user', {
        headers: providerHeaders(requiredCredential(credentials, 'token')),
      })
      const user = typeof profile.user === 'object' && profile.user ? profile.user as Record<string, unknown> : profile
      return { accountLabel: String(user.username ?? user.email ?? user.name ?? 'Vercel') }
    }
    if (connection.provider === 'telegram') {
      const token = requiredCredential(credentials, 'token')
      const profile = await this.json(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`)
      if (profile.ok !== true || typeof profile.result !== 'object' || !profile.result) throw new ConnectionError('authentication_failed')
      const bot = profile.result as Record<string, unknown>
      return { accountLabel: bot.username ? `@${bot.username}` : String(bot.first_name ?? 'Telegram bot') }
    }
    const tools = await this.listMcpTools(
      connection.endpoint_url,
      connection.auth_type === 'bearer' ? requiredCredential(credentials, 'token') : undefined,
      true,
    )
    return { accountLabel: `${tools.length} tool${tools.length === 1 ? '' : 's'}` }
  }

  private async listMcpTools(endpoint: string, token: string | undefined, validate: boolean) {
    return await this.withMcpClient(endpoint, token, validate, async (client) => {
      const tools: Tool[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined)
        tools.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor)
      return tools
    })
  }

  private async withMcpClient<T>(
    endpoint: string,
    token: string | undefined,
    validate: boolean,
    run: (client: Client) => Promise<T>,
  ) {
    if (validate) await validatePublicEndpoint(endpoint)
    const origin = new URL(endpoint).origin
    const guardedFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.origin !== origin) throw new ConnectionError('unexpected_redirect')
      return this.fetcher(input, {
        ...init,
        redirect: 'manual',
        signal: combinedSignal(init?.signal),
      })
    }
    const client = new Client({ name: 'podex', version: '0.1.0' })
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: token ? { headers: providerHeaders(token) } : undefined,
      fetch: guardedFetch,
      reconnectionOptions: { maxReconnectionDelay: 1000, initialReconnectionDelay: 250, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
    })
    try {
      await client.connect(transport)
      return await run(client)
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  private async refreshGoogleCredentials(credentials: Credentials) {
    const expiresAt = Number(credentials.expiresAt ?? 0)
    if (credentials.accessToken && expiresAt > Date.now() + 30_000) return credentials
    const refreshToken = requiredCredential(credentials, 'refreshToken')
    if (!this.config.googleClientId || !this.config.googleClientSecret) throw new ConnectionError('provider_not_configured')
    const response = await this.json('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    return {
      ...credentials,
      accessToken: String(response.access_token),
      expiresAt: Date.now() + Number(response.expires_in ?? 3600) * 1000,
    }
  }

  private async exchangeGithubCode(code: string, verifier: string) {
    if (!this.config.githubClientId || !this.config.githubClientSecret) throw new ConnectionError('provider_not_configured')
    const response = await this.json('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.githubClientId,
        client_secret: this.config.githubClientSecret,
        code,
        code_verifier: verifier,
      }),
    })
    if (!response.access_token) throw new ConnectionError('oauth_exchange_failed')
    return { accessToken: String(response.access_token) }
  }

  private async exchangeGoogleCode(code: string, verifier: string) {
    if (!this.config.googleClientId || !this.config.googleClientSecret) throw new ConnectionError('provider_not_configured')
    const redirectUri = `${this.config.publicApiUrl.replace(/\/$/, '')}/v1/connections/oauth/gmail/callback`
    const response = await this.json('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    if (!response.access_token || !response.refresh_token) throw new ConnectionError('oauth_exchange_failed')
    return {
      accessToken: String(response.access_token),
      refreshToken: String(response.refresh_token),
      expiresAt: Date.now() + Number(response.expires_in ?? 3600) * 1000,
    }
  }

  private async json(url: string, init?: RequestInit) {
    const response = await this.fetcher(url, { ...init, redirect: 'manual', signal: combinedSignal(init?.signal) })
    if (response.status >= 300 && response.status < 400) throw new ConnectionError('unexpected_redirect')
    if (response.status === 401 || response.status === 403) throw new ConnectionError('authentication_failed')
    if (!response.ok) throw new ConnectionError('endpoint_failed', `Endpoint returned HTTP ${response.status}`)
    return await response.json() as Record<string, unknown>
  }

  private encrypt(credentials: Credentials) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()])
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
  }

  private decrypt(value: string): Credentials {
    const [version, iv, tag, payload] = value.split('.')
    if (version !== 'v1' || !iv || !tag || !payload) throw new ConnectionError('credentials_unreadable')
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(payload, 'base64url')),
        decipher.final(),
      ]).toString()) as Credentials
    } catch {
      throw new ConnectionError('credentials_unreadable')
    }
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const providerHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json' })

function restCapabilities(connection: Connection): Capability[] {
  const definitions = connection.provider === 'gmail' ? [{
    name: 'gmail.search_messages',
    title: 'Search email',
    description: 'Find messages using Gmail search syntax.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 20 } },
      required: ['query'],
      additionalProperties: false,
    },
  }] : connection.provider === 'vercel' ? [{
    name: 'vercel.list_projects',
    title: 'List Vercel projects',
    description: 'List projects visible to the connected Vercel account.',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 20 } },
      additionalProperties: false,
    },
  }] : []

  return definitions.map((definition) => ({
    id: `${connection.id}:rest:${definition.name}`,
    connection_id: connection.id,
    connection_name: connection.name,
    provider: connection.provider,
    protocol: 'rest',
    account_label: connection.account_label,
    name: definition.name,
    title: definition.title,
    description: definition.description,
    input_schema: definition.input_schema,
    schema_hash: hash(JSON.stringify(definition.input_schema)),
    safety: 'verified_read',
    callable_during_setup: true,
  }))
}

function sanitizeSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { type: 'object' }
  const serialized = JSON.stringify(value)
  if (serialized.length > 32_000) return { type: 'object', description: 'Schema omitted because it is too large.' }
  return JSON.parse(serialized) as Record<string, unknown>
}

const clip = (value: string, max: number) => value.slice(0, max)

function requiredCredential(credentials: Credentials, key: string) {
  const value = credentials[key]
  if (typeof value !== 'string' || !value) throw new ConnectionError('credentials_missing')
  return value
}

function combinedSignal(signal?: AbortSignal | null) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
}

function safeTestError(error: unknown) {
  if (error instanceof ConnectionError) {
    if (error.code === 'authentication_failed') return 'Authentication failed. Check the connection credentials.'
    if (error.code === 'unexpected_redirect') return 'The endpoint redirected unexpectedly.'
    if (error.code === 'credentials_missing') return 'The saved credentials are incomplete.'
    if (error.code === 'credentials_unreadable') return 'The saved credentials could not be decrypted.'
    if (error.code === 'endpoint_failed') return error.message.slice(0, 500)
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'The endpoint did not respond within 10 seconds.'
  return 'The connection test failed.'
}

export async function validatePublicEndpoint(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConnectionError('invalid_endpoint')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new ConnectionError('invalid_endpoint')
  }
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new ConnectionError('private_endpoint')
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true }).catch(() => { throw new ConnectionError('endpoint_unreachable') })
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ConnectionError('private_endpoint')
  }
}

function isPrivateAddress(address: string) {
  const value = address.toLowerCase()
  if (value.includes(':')) {
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7))
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
      value.startsWith('2001:db8')
  }
  const [a, b, c] = value.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
}
