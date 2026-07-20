import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { Api, TelegramClient } from 'telegram'
import { returnBigInt } from 'telegram/Helpers.js'
import { StringSession } from 'telegram/sessions/StringSession.js'
import { Agent } from 'undici'

import { GithubClient, type GithubMergeAction } from './github-pr.js'
import type { Capability, CapabilityRole, Connection, ConnectionProvider, NewConnection, OAuthProvider, Store } from './types/store.js'
import type { ConnectionConfig } from './types/connections.js'

export type { ConnectionConfig } from './types/connections.js'

const ENDPOINTS = {
  github: 'https://api.githubcopilot.com/mcp/readonly',
  gmail: 'https://gmail.googleapis.com',
  google_calendar: 'https://www.googleapis.com/calendar/v3',
  vercel: 'https://api.vercel.com',
  telegram: 'https://api.telegram.org',
  linear: 'https://mcp.linear.app/mcp',
  stripe: 'https://mcp.stripe.com',
} as const

type Credentials = Record<string, string | number | undefined>

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

  telegramUserAuthAvailable() {
    return Boolean(this.config.telegramApiId && this.config.telegramApiHash)
  }

  telegramWebhookAuthorized(connectionId: string, secret: string | undefined) {
    if (!secret) return false
    const expected = Buffer.from(this.telegramWebhookSecret(connectionId))
    const actual = Buffer.from(secret)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  async createManual(ownerId: string, input: {
    provider: 'vercel' | 'telegram' | 'linear' | 'stripe' | 'custom_mcp'
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

  encryptCodexPayload(payload: Record<string, unknown>) {
    return this.encryptPrivatePayload(payload)
  }

  decryptCodexPayload(encryptedPayload: string) {
    return this.decryptPrivatePayload<Record<string, unknown>>(encryptedPayload)
  }

  encryptPrivatePayload(payload: unknown) {
    return this.encrypt({ payload: JSON.stringify(payload) })
  }

  decryptPrivatePayload<T = unknown>(encryptedPayload: string): T {
    return JSON.parse(requiredCredential(this.decrypt(encryptedPayload), 'payload')) as T
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
    if (input.authType !== undefined && existing.provider !== 'custom_mcp') {
      throw new ConnectionError('auth_type_not_editable')
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
      const result = await this.smokeTest(ownerId, stored, credentials)
      return await this.store.setConnectionTest(ownerId, connectionId, {
        status: 'connected',
        accountLabel: result.accountLabel,
        error: null,
        encryptedPayload: result.credentials ? this.encrypt(result.credentials) : undefined,
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

  async delete(ownerId: string, connectionId: string) {
    const existing = await this.store.getConnection(ownerId, connectionId)
    if (!existing) return false
    const credentials = this.decrypt(existing.encrypted_payload)
    const deleted = await this.store.deleteConnection(ownerId, connectionId)
    if (deleted && existing.provider === 'telegram' && credentials.mode !== 'user' && credentials.token) {
      await this.json(`https://api.telegram.org/bot${encodeURIComponent(String(credentials.token))}/deleteWebhook`, { method: 'POST' }).catch(() => undefined)
    }
    return deleted
  }

  async startOAuth(
    ownerId: string,
    provider: OAuthProvider,
    name: string,
    connectionId: string | null,
  ) {
    const existing = connectionId ? await this.store.getConnection(ownerId, connectionId) : null
    if (connectionId && (!existing || existing.provider !== provider)) {
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
    } else if (provider === 'gmail') {
      url.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send')
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'consent')
    } else {
      url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly')
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'consent')
    }
    return url.toString()
  }

  async finishOAuth(provider: OAuthProvider, state: string, code: string) {
    const oauth = await this.store.consumeOAuthState(hash(state), provider)
    if (!oauth) throw new ConnectionError('invalid_oauth_state')

    const credentials = provider === 'github'
      ? await this.exchangeGithubCode(code, oauth.codeVerifier)
      : await this.exchangeGoogleCode(provider, code, oauth.codeVerifier)
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
    const credentials = this.decrypt(connection.encrypted_payload)
    if (connection.protocol === 'rest') return restCapabilities(connection, credentials)

    const token = connection.provider === 'github'
      ? requiredCredential(credentials, 'accessToken')
      : connection.auth_type === 'bearer'
        ? requiredCredential(credentials, 'token')
        : undefined
    const tools = await this.listMcpTools(connection.endpoint_url, token, connection.provider === 'custom_mcp')
      .catch((error) => {
        if (connection.provider === 'github') return []
        throw error
      })
    const discovered = tools.flatMap((tool) => {
      if (tool.annotations?.destructiveHint === true) return []
      const readOnly = tool.annotations?.readOnlyHint
      const safety = readOnly === true
        ? 'verified_read' as const
        : readOnly === false && tool.annotations?.destructiveHint === false
          ? 'verified_write' as const
          : 'unannotated' as const
      const inputSchema = sanitizeSchema(tool.inputSchema)
      const outputSchema = sanitizeSchema(tool.outputSchema)
      const runtimeSafe = safety !== 'unannotated'
      const roles: CapabilityRole[] = safety === 'verified_read'
        ? ['source', 'context', 'setup']
        : safety === 'verified_write'
          ? ['action']
          : ['source', 'context', 'action']
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
        output_schema: outputSchema,
        schema_hash: hash(JSON.stringify({ inputSchema, outputSchema, readOnly, destructive: tool.annotations?.destructiveHint })),
        safety,
        roles,
        delivery: 'poll' as const,
        effect: safety === 'verified_read' ? 'read' as const : safety === 'verified_write' ? 'write' as const : 'unannotated' as const,
        runtime_safe: runtimeSafe,
        callable_during_setup: safety === 'verified_read',
      }]
    })
    return connection.provider === 'github'
      ? [...githubCapabilities(connection), ...discovered]
      : discovered
  }

  async callSetupCapability(ownerId: string, capability: Capability, input: Record<string, unknown>) {
    if (!capability.callable_during_setup) throw new ConnectionError('capability_not_safe')
    const connection = await this.store.getConnection(ownerId, capability.connection_id)
    if (!connection || connection.status !== 'connected') throw new ConnectionError('connection_not_found')

    if (connection.provider === 'github' && capability.name.startsWith('github.')) {
      const client = this.githubClient(connection)
      if (capability.name === 'github.list_repositories') return await client.listRepositories()
      if (capability.name === 'github.ready_pull_requests') {
        return await client.readyPullRequests(stringList(input.repositories, 10))
      }
      throw new ConnectionError('capability_not_found')
    }

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
    if (capability.name === 'gmail.search_messages' || capability.name === 'gmail.list_messages') {
      const current = await this.refreshGoogleCredentials(credentials)
      if (JSON.stringify(current) !== JSON.stringify(credentials)) {
        await this.store.updateConnectionSecret(connection.id, this.encrypt(current))
      }
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
      const query = input.query === 'all_incoming' ? 'in:inbox' : input.query
      if (typeof query === 'string' && query) url.searchParams.set('q', query)
      url.searchParams.set('maxResults', String(Math.min(Number(input.limit) || 10, 20)))
      return await this.json(url.toString(), { headers: providerHeaders(requiredCredential(current, 'accessToken')) })
    }
    if (capability.name === 'gmail.get_thread') {
      const current = await this.refreshGoogleCredentials(credentials)
      const threadId = requiredString(input, 'thread_id')
      const thread = await this.json(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`, {
        headers: providerHeaders(requiredCredential(current, 'accessToken')),
      })
      return normalizeGmailThread(thread)
    }
    if (capability.name === 'google_calendar.list_calendars') {
      const current = await this.currentGoogleCredentials(connection, credentials)
      const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList')
      url.searchParams.set('maxResults', String(Math.min(Number(input.limit) || 20, 50)))
      return await this.json(url.toString(), { headers: providerHeaders(requiredCredential(current, 'accessToken')) })
    }
    if (capability.name === 'google_calendar.list_events') {
      const current = await this.currentGoogleCredentials(connection, credentials)
      const { timeMin, timeMax } = calendarTimeRange(input)
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(requiredString(input, 'calendar_id'))}/events`)
      url.searchParams.set('timeMin', timeMin)
      url.searchParams.set('timeMax', timeMax)
      url.searchParams.set('singleEvents', 'true')
      url.searchParams.set('orderBy', 'startTime')
      url.searchParams.set('maxResults', String(Math.min(Number(input.limit) || 20, 50)))
      if (typeof input.query === 'string' && input.query) url.searchParams.set('q', input.query)
      return await this.json(url.toString(), { headers: providerHeaders(requiredCredential(current, 'accessToken')) })
    }
    if (capability.name === 'vercel.list_projects') {
      const url = new URL('https://api.vercel.com/v9/projects')
      url.searchParams.set('limit', String(Math.min(Number(input.limit) || 20, 20)))
      if (typeof input.search === 'string' && input.search) url.searchParams.set('search', input.search)
      return await this.json(url.toString(), { headers: providerHeaders(requiredCredential(credentials, 'token')) })
    }
    if (capability.name === 'telegram.discover_dialogs') {
      return await this.withTelegram(credentials, async (client) => {
        const dialogs = await client.getDialogs({ limit: Math.min(Number(input.limit) || 30, 50) })
        return dialogs.map((dialog) => ({
          id: dialog.id?.toString() ?? '',
          title: clip(dialog.title ?? 'Telegram chat', 160),
          kind: dialog.isUser ? 'dm' : dialog.isGroup ? 'group' : dialog.isChannel ? 'channel' : 'chat',
        }))
      })
    }
    throw new ConnectionError('capability_not_found')
  }

  async callRuntimeCapability(
    ownerId: string,
    capability: Capability,
    input: Record<string, unknown>,
    role: 'source' | 'context' | 'action',
    runtime?: { telegramRandomId?: string },
  ) {
    if (!capability.runtime_safe || !capability.roles.includes(role)) throw new ConnectionError('capability_not_safe')
    const connection = await this.store.getConnection(ownerId, capability.connection_id)
    if (!connection || connection.status !== 'connected') throw new ConnectionError('capability_not_found')
    const latest = (connection.provider === 'github' && capability.name.startsWith('github.')
      ? githubCapabilities(connection)
      : await this.discoverConnectionCapabilities(ownerId, capability.connection_id))
      .find(({ id }) => id === capability.id)
    if (!latest || latest.schema_hash !== capability.schema_hash || !latest.runtime_safe || !latest.roles.includes(role)) {
      throw new ConnectionError('capability_changed')
    }
    if (!validInput(latest.input_schema, input)) throw new ConnectionError('invalid_capability_input')
    if (connection.provider === 'github' && latest.name.startsWith('github.')) {
      const client = this.githubClient(connection)
      if (role === 'source' && latest.name === 'github.ready_pull_requests') {
        return await client.readyPullRequests(stringList(input.repositories, 10))
      }
      if (role === 'action' && latest.name === 'github.merge_pull_request') {
        return await client.merge(input as unknown as GithubMergeAction)
      }
      throw new ConnectionError('capability_not_found')
    }
    if (connection.provider === 'gmail' && connection.protocol === 'rest' && role === 'action' && latest.name === 'gmail.send_reply') {
      const credentials = this.decrypt(connection.encrypted_payload)
      const current = await this.refreshGoogleCredentials(credentials)
      if (JSON.stringify(current) !== JSON.stringify(credentials)) await this.store.updateConnectionSecret(connection.id, this.encrypt(current))
      const token = requiredCredential(current, 'accessToken')
      const threadId = requiredString(input, 'thread_id')
      const message = requiredString(input, 'message')
      const thread = await this.json(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata`, { headers: providerHeaders(token) })
      const raw = gmailReplyRaw(threadId, message, thread)
      return await this.json('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { ...providerHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, raw: Buffer.from(raw).toString('base64url') }),
      })
    }
    if (connection.provider === 'google_calendar' && connection.protocol === 'rest' && role === 'action') {
      const credentials = await this.currentGoogleCredentials(connection, this.decrypt(connection.encrypted_payload))
      const headers = { ...providerHeaders(requiredCredential(credentials, 'accessToken')), 'Content-Type': 'application/json' }
      const calendarId = encodeURIComponent(requiredString(input, 'calendar_id'))
      const payload = calendarEventPayload(input)
      if (latest.name === 'google_calendar.create_event') {
        return await this.json(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`, {
          method: 'POST', headers, body: JSON.stringify(payload),
        })
      }
      if (latest.name === 'google_calendar.update_event') {
        return await this.json(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(requiredString(input, 'event_id'))}?sendUpdates=all`, {
          method: 'PATCH', headers: { ...headers, 'If-Match': requiredString(input, 'etag') }, body: JSON.stringify(payload),
        })
      }
      throw new ConnectionError('capability_not_found')
    }
    if (connection.provider === 'telegram' && connection.protocol === 'rest') {
      const credentials = this.decrypt(connection.encrypted_payload)
      if (credentials.mode !== 'user') {
        if (role !== 'action' || latest.name !== 'telegram.bot_send_text') throw new ConnectionError('capability_not_found')
        const result = await this.json(`https://api.telegram.org/bot${encodeURIComponent(requiredCredential(credentials, 'token'))}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: requiredString(input, 'peer_id'), text: requiredString(input, 'message') }),
        })
        if (result.ok !== true) throw new ConnectionError('endpoint_failed', 'Telegram rejected the message.')
        return { sent: true, message_id: (result.result as Record<string, unknown> | undefined)?.message_id }
      }
      return await this.withTelegram(credentials, async (client) => {
        if (role === 'context' && latest.name === 'telegram.recent_thread') {
          const messages = await client.getMessages(requiredString(input, 'peer_id'), {
            limit: Math.min(Number(input.limit) || 10, 20),
          })
          return messages.map((message) => ({
            id: message.id,
            date: message.date,
            text: clip(message.message ?? '', 4_000),
            sender_id: message.senderId?.toString() ?? null,
          }))
        }
        if (role === 'action' && latest.name === 'telegram.send_text') {
          const response = await client.invoke(new Api.messages.SendMessage({
            peer: await client.getInputEntity(requiredString(input, 'peer_id')),
            message: requiredString(input, 'message'),
            randomId: returnBigInt(runtime?.telegramRandomId ?? randomBytes(8).readBigInt64BE().toString()),
          }))
          return { sent: true, response_type: response.className }
        }
        throw new ConnectionError('capability_not_found')
      })
    }
    if (role !== 'action') return await this.callSetupCapability(ownerId, { ...latest, callable_during_setup: true }, input)
    if (connection.protocol !== 'mcp') throw new ConnectionError('capability_not_found')
    const credentials = this.decrypt(connection.encrypted_payload)
    const token = connection.provider === 'github'
      ? requiredCredential(credentials, 'accessToken')
      : connection.auth_type === 'bearer' ? requiredCredential(credentials, 'token') : undefined
    return await this.withMcpClient(connection.endpoint_url, token, connection.provider === 'custom_mcp', async (client) => {
      return await client.callTool({ name: latest.name, arguments: input })
    })
  }

  encryptTelegramSession(session: string) {
    return this.encrypt({ mode: 'user', session })
  }

  async connectTelegram(ownerId: string, connectionId: string) {
    const connection = await this.store.getConnection(ownerId, connectionId)
    if (!connection || connection.provider !== 'telegram' || connection.status !== 'connected') {
      throw new ConnectionError('connection_not_found')
    }
    const credentials = this.decrypt(connection.encrypted_payload)
    if (credentials.mode !== 'user') throw new ConnectionError('capability_not_found')
    if (!this.config.telegramApiId || !this.config.telegramApiHash) throw new ConnectionError('provider_not_configured')
    const client = new TelegramClient(
      new StringSession(requiredCredential(credentials, 'session')),
      this.config.telegramApiId,
      this.config.telegramApiHash,
      { connectionRetries: 5, autoReconnect: true },
    )
    await client.connect()
    if (!await client.checkAuthorization()) {
      await client.disconnect().catch(() => undefined)
      throw new ConnectionError('authentication_failed')
    }
    return client
  }

  private async manualDefinition(input: {
    provider: 'vercel' | 'telegram' | 'linear' | 'stripe' | 'custom_mcp'
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
    const mcp = input.provider === 'linear' || input.provider === 'stripe'
    return {
      connection: {
        name: input.name,
        provider: input.provider,
        protocol: mcp ? 'mcp' as const : 'rest' as const,
        endpoint_url: ENDPOINTS[input.provider],
        auth_type: 'bearer' as const,
      },
      credentials: input.provider === 'telegram' ? { mode: 'bot', token: input.token } : { token: input.token },
    }
  }

  private async smokeTest(ownerId: string, connection: Connection, credentials: Credentials) {
    if (connection.provider === 'github') {
      const token = requiredCredential(credentials, 'accessToken')
      const profile = await this.json('https://api.github.com/user', { headers: providerHeaders(token) })
      return { accountLabel: String(profile.login ?? 'GitHub') }
    }
    if (connection.provider === 'gmail') {
      const current = await this.refreshGoogleCredentials(credentials)
      const profile = await this.json('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: providerHeaders(requiredCredential(current, 'accessToken')),
      })
      return { accountLabel: String(profile.emailAddress ?? 'Gmail'), credentials: current }
    }
    if (connection.provider === 'google_calendar') {
      const current = await this.refreshGoogleCredentials(credentials)
      const scopes = new Set(String(current.scope ?? '').split(' '))
      if (!scopes.has('https://www.googleapis.com/auth/calendar.events') || !scopes.has('https://www.googleapis.com/auth/calendar.calendarlist.readonly')) {
        throw new ConnectionError('authentication_failed')
      }
      const calendar = await this.json('https://www.googleapis.com/calendar/v3/users/me/calendarList/primary', {
        headers: providerHeaders(requiredCredential(current, 'accessToken')),
      })
      return { accountLabel: String(calendar.summaryOverride ?? calendar.summary ?? 'Google Calendar'), credentials: current }
    }
    if (connection.provider === 'vercel') {
      const profile = await this.json('https://api.vercel.com/v2/user', {
        headers: providerHeaders(requiredCredential(credentials, 'token')),
      })
      const user = typeof profile.user === 'object' && profile.user ? profile.user as Record<string, unknown> : profile
      return { accountLabel: String(user.username ?? user.email ?? user.name ?? 'Vercel') }
    }
    if (connection.provider === 'telegram') {
      if (credentials.mode === 'user') {
        return await this.withTelegram(credentials, async (client) => {
          const me = await client.getMe()
          const username = 'username' in me ? me.username : undefined
          const firstName = 'firstName' in me ? me.firstName : undefined
          return { accountLabel: username ? `@${username}` : String(firstName ?? 'Telegram') }
        })
      }
      const token = requiredCredential(credentials, 'token')
      const profile = await this.json(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`)
      if (profile.ok !== true || typeof profile.result !== 'object' || !profile.result) throw new ConnectionError('authentication_failed')
      const webhook = await this.json(`https://api.telegram.org/bot${encodeURIComponent(token)}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${this.config.publicApiUrl.replace(/\/$/, '')}/v1/webhooks/telegram/${ownerId}/${connection.id}`,
          secret_token: this.telegramWebhookSecret(connection.id),
          allowed_updates: ['message', 'channel_post'],
        }),
      })
      if (webhook.ok !== true) throw new ConnectionError('endpoint_failed', 'Telegram rejected the webhook.')
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

  private githubClient(connection: Connection & { encrypted_payload?: string }) {
    if (!connection.encrypted_payload) throw new ConnectionError('credentials_unreadable')
    return new GithubClient(requiredCredential(this.decrypt(connection.encrypted_payload), 'accessToken'), this.fetcher)
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
      const response = await publicEndpointFetch(this.fetcher, input, {
        ...init,
        redirect: 'manual',
        signal: combinedSignal(init?.signal),
      })
      if (response.status === 401 || response.status === 403) throw new ConnectionError('authentication_failed')
      return response
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

  private async currentGoogleCredentials(connection: Connection, credentials: Credentials) {
    const current = await this.refreshGoogleCredentials(credentials)
    if (JSON.stringify(current) !== JSON.stringify(credentials)) {
      await this.store.updateConnectionSecret(connection.id, this.encrypt(current))
    }
    return current
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

  private async exchangeGoogleCode(provider: 'gmail' | 'google_calendar', code: string, verifier: string) {
    if (!this.config.googleClientId || !this.config.googleClientSecret) throw new ConnectionError('provider_not_configured')
    const redirectUri = `${this.config.publicApiUrl.replace(/\/$/, '')}/v1/connections/oauth/${provider}/callback`
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
      scope: String(response.scope ?? ''),
    }
  }

  private async json(url: string, init?: RequestInit) {
    const response = await this.fetcher(url, { ...init, redirect: 'manual', signal: combinedSignal(init?.signal) })
    if (response.status >= 300 && response.status < 400) throw new ConnectionError('unexpected_redirect')
    if (response.status === 401 || response.status === 403) throw new ConnectionError('authentication_failed')
    if (!response.ok) throw new ConnectionError('endpoint_failed', `Endpoint returned HTTP ${response.status}`)
    return await response.json() as Record<string, unknown>
  }

  private async withTelegram<T>(credentials: Credentials, run: (client: TelegramClient) => Promise<T>) {
    if (!this.config.telegramApiId || !this.config.telegramApiHash) throw new ConnectionError('provider_not_configured')
    const client = new TelegramClient(
      new StringSession(requiredCredential(credentials, 'session')),
      this.config.telegramApiId,
      this.config.telegramApiHash,
      { connectionRetries: 2 },
    )
    try {
      await client.connect()
      if (!await client.checkAuthorization()) throw new ConnectionError('authentication_failed')
      return await run(client)
    } finally {
      await client.disconnect().catch(() => undefined)
    }
  }

  private telegramWebhookSecret(connectionId: string) {
    return createHmac('sha256', this.key).update(`telegram-webhook:${connectionId}`).digest('hex')
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

function githubCapabilities(connection: Connection): Capability[] {
  const definitions = [{
    name: 'github.list_repositories',
    title: 'List GitHub repositories',
    description: 'List repositories available to this GitHub connection during setup.',
    roles: ['setup'] as CapabilityRole[],
    effect: 'read' as const,
    callable: true,
    input: { type: 'object', properties: {}, additionalProperties: false },
    output: { type: 'object', properties: { items: { type: 'array' } } },
  }, {
    name: 'github.ready_pull_requests',
    title: 'Watch merge-ready GitHub pull requests',
    description: 'Poll up to ten repositories for open pull requests GitHub reports ready to merge.',
    roles: ['source', 'setup'] as CapabilityRole[],
    effect: 'read' as const,
    callable: true,
    input: {
      type: 'object',
      properties: { repositories: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 } },
      required: ['repositories'],
      additionalProperties: false,
    },
    output: { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] },
  }, {
    name: 'github.merge_pull_request',
    title: 'Merge a GitHub pull request',
    description: 'Merge the exact reviewed pull request head after Pod approval.',
    roles: ['action'] as CapabilityRole[],
    effect: 'write' as const,
    callable: false,
    input: {
      type: 'object',
      properties: {
        repository: { type: 'string' },
        number: { type: 'number' },
        head_sha: { type: 'string' },
        merge_method: { type: 'string', enum: ['squash', 'rebase', 'merge'] },
      },
      required: ['repository', 'number', 'head_sha', 'merge_method'],
      additionalProperties: false,
    },
    output: { type: 'object', properties: { merged: { type: 'boolean' }, sha: { type: 'string' } } },
  }]
  return definitions.map((definition) => ({
    id: `${connection.id}:builtin:${definition.name}`,
    connection_id: connection.id,
    connection_name: connection.name,
    provider: 'github' as const,
    protocol: 'rest' as const,
    account_label: connection.account_label,
    name: definition.name,
    title: definition.title,
    description: definition.description,
    input_schema: definition.input,
    output_schema: definition.output,
    schema_hash: hash(JSON.stringify({ input: definition.input, output: definition.output, effect: definition.effect })),
    safety: definition.effect === 'write' ? 'verified_write' as const : 'verified_read' as const,
    roles: definition.roles,
    delivery: 'poll' as const,
    effect: definition.effect,
    runtime_safe: true,
    callable_during_setup: definition.callable,
  }))
}

function stringList(value: unknown, max: number) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || value.some((item) => typeof item !== 'string')) {
    throw new ConnectionError('invalid_capability_input')
  }
  return value as string[]
}

function restCapabilities(connection: Connection, credentials: Credentials): Capability[] {
  const definitions = connection.provider === 'gmail' ? [{
    name: 'gmail.list_messages',
    title: 'Watch Gmail messages',
    description: 'Poll messages using Gmail search syntax and stable message identifiers.',
    roles: ['source', 'setup'] as CapabilityRole[],
    delivery: 'poll' as const,
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 20 } },
      required: ['query'], additionalProperties: false,
    },
    output_schema: { type: 'object', properties: { messages: { type: 'array' } } },
  }, {
    name: 'gmail.get_thread',
    title: 'Read a Gmail thread',
    description: 'Read metadata and snippets for one Gmail thread.',
    roles: ['context'] as CapabilityRole[],
    delivery: 'poll' as const,
    input_schema: { type: 'object', properties: { thread_id: { type: 'string' } }, required: ['thread_id'], additionalProperties: false },
    output_schema: { type: 'object' },
  }, ...(String(credentials.scope ?? '').includes('https://www.googleapis.com/auth/gmail.send') ? [{
    name: 'gmail.send_reply',
    title: 'Reply in Gmail',
    description: 'Send the exact approved response in the source Gmail thread.',
    roles: ['action'] as CapabilityRole[],
    delivery: 'poll' as const,
    input_schema: { type: 'object', properties: { thread_id: { type: 'string' }, message: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['thread_id', 'message'], additionalProperties: false },
    output_schema: { type: 'object' },
  }] : [])] : connection.provider === 'google_calendar' ? calendarCapabilities : connection.provider === 'vercel' ? [{
    name: 'vercel.list_projects',
    title: 'List Vercel projects',
    description: 'List projects visible to the connected Vercel account.',
    roles: ['source', 'context', 'setup'] as CapabilityRole[],
    delivery: 'poll' as const,
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 20 } },
      additionalProperties: false,
    },
    output_schema: { type: 'object', properties: { projects: { type: 'array' } } },
  }] : connection.provider === 'telegram' ? [{
    name: 'telegram.new_message',
    title: 'New Telegram message',
    description: credentials.mode === 'user' ? 'Receive new cloud messages without marking them read.' : 'Receive new bot messages through an authenticated Telegram webhook.',
    roles: ['source'] as CapabilityRole[], delivery: 'event' as const,
    input_schema: {
      type: 'object',
      properties: {
        chat_ids: { type: 'array', maxItems: 100, items: { type: 'string' } },
        chat_types: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['dm', 'group', 'channel'] } },
      },
      required: ['chat_types'], additionalProperties: false,
    },
    output_schema: { type: 'object' },
  }, ...(credentials.mode === 'user' ? [{
    name: 'telegram.discover_dialogs',
    title: 'List Telegram chats',
    description: 'List cloud chats available to the connected account.',
    roles: ['setup'] as CapabilityRole[], delivery: 'poll' as const,
    input_schema: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 50 } }, additionalProperties: false },
    output_schema: { type: 'array' },
  }, {
    name: 'telegram.recent_thread',
    title: 'Read recent Telegram context',
    description: 'Read recent text and captions from the current cloud chat.',
    roles: ['context'] as CapabilityRole[], delivery: 'poll' as const,
    input_schema: { type: 'object', properties: { peer_id: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 20 } }, required: ['peer_id'], additionalProperties: false },
    output_schema: { type: 'array' },
  }] : []), {
    name: credentials.mode === 'user' ? 'telegram.send_text' : 'telegram.bot_send_text',
    title: 'Send Telegram reply',
    description: credentials.mode === 'user' ? 'Send the exact approved text reply to a cloud chat.' : 'Send the exact approved text reply as the connected bot.',
    roles: ['action'] as CapabilityRole[], delivery: 'event' as const,
    input_schema: { type: 'object', properties: { peer_id: { type: 'string' }, message: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['peer_id', 'message'], additionalProperties: false },
    output_schema: { type: 'object' },
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
    output_schema: definition.output_schema,
    schema_hash: hash(JSON.stringify({ inputSchema: definition.input_schema, outputSchema: definition.output_schema, roles: definition.roles, delivery: definition.delivery })),
    safety: definition.roles.includes('action') ? 'verified_write' : 'verified_read',
    roles: definition.roles,
    delivery: definition.delivery,
    effect: definition.roles.includes('action') ? 'write' : 'read',
    runtime_safe: true,
    callable_during_setup: definition.roles.includes('setup'),
  }))
}

const calendarCapabilities = [{
  name: 'google_calendar.list_calendars', title: 'List Google calendars',
  description: 'List calendars available to the connected Google account.',
  roles: ['setup'] as CapabilityRole[], delivery: 'poll' as const,
  input_schema: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 50 } }, additionalProperties: false },
  output_schema: { type: 'object', properties: { items: { type: 'array' } } },
}, {
  name: 'google_calendar.list_events', title: 'Watch Google Calendar events',
  description: 'Read events from one calendar inside an explicit time window.',
  roles: ['source', 'context', 'setup'] as CapabilityRole[], delivery: 'poll' as const,
  input_schema: {
    type: 'object', properties: {
      calendar_id: { type: 'string' }, time_min: { type: 'string' }, time_max: { type: 'string' },
      query: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 50 },
    }, required: ['calendar_id', 'time_min', 'time_max'], additionalProperties: false,
  },
  output_schema: { type: 'object', properties: { items: { type: 'array' } } },
}, {
  name: 'google_calendar.create_event', title: 'Create Google Calendar event',
  description: 'Create the exact approved event and notify its attendees.',
  roles: ['action'] as CapabilityRole[], delivery: 'poll' as const,
  input_schema: calendarEventSchema(false), output_schema: { type: 'object' },
}, {
  name: 'google_calendar.update_event', title: 'Update Google Calendar event',
  description: 'Update an event only if its approved version still matches Google Calendar.',
  roles: ['action'] as CapabilityRole[], delivery: 'poll' as const,
  input_schema: calendarEventSchema(true), output_schema: { type: 'object' },
}]

function calendarEventSchema(update: boolean) {
  return {
    type: 'object', properties: {
      calendar_id: { type: 'string' }, ...(update ? { event_id: { type: 'string' }, etag: { type: 'string' } } : {}),
      title: { type: 'string', minLength: 1, maxLength: 1024 }, start: { type: 'string' }, end: { type: 'string' },
      time_zone: { type: 'string' }, description: { type: 'string', maxLength: 8192 }, location: { type: 'string', maxLength: 1024 },
      attendees: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
    }, required: ['calendar_id', ...(update ? ['event_id', 'etag'] : []), 'title', 'start', 'end'], additionalProperties: false,
  }
}

function calendarTimeRange(input: Record<string, unknown>) {
  const timeMin = requiredString(input, 'time_min')
  const timeMax = requiredString(input, 'time_max')
  const start = Date.parse(timeMin)
  const end = Date.parse(timeMax)
  if (!CALENDAR_RFC3339.test(timeMin) || !CALENDAR_RFC3339.test(timeMax) || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new ConnectionError('invalid_capability_input')
  }
  return { timeMin, timeMax }
}

function calendarEventPayload(input: Record<string, unknown>) {
  const { timeMin: start, timeMax: end } = calendarTimeRange({ time_min: input.start, time_max: input.end })
  const timeZone = typeof input.time_zone === 'string' && input.time_zone ? input.time_zone : undefined
  const title = requiredString(input, 'title')
  if (title.length > 1024 || (input.time_zone !== undefined && !timeZone)) throw new ConnectionError('invalid_capability_input')
  if (timeZone) {
    try { new Intl.DateTimeFormat('en', { timeZone }) } catch { throw new ConnectionError('invalid_capability_input') }
  }
  const description = optionalString(input, 'description', 8192)
  const location = optionalString(input, 'location', 1024)
  const attendees = input.attendees === undefined ? undefined : stringList(input.attendees, 100)
  if (attendees?.some((email) => email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email))) throw new ConnectionError('invalid_capability_input')
  return {
    summary: title,
    start: { dateTime: start, ...(timeZone ? { timeZone } : {}) },
    end: { dateTime: end, ...(timeZone ? { timeZone } : {}) },
    ...(description !== undefined ? { description } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(attendees ? { attendees: attendees.map((email) => ({ email })) } : {}),
  }
}

const CALENDAR_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function optionalString(input: Record<string, unknown>, key: string, max: number) {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) throw new ConnectionError('invalid_capability_input')
  return value
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

function requiredString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== 'string' || !value) throw new ConnectionError('invalid_capability_input')
  return value
}

function normalizeGmailThread(thread: Record<string, unknown>) {
  const messages = Array.isArray(thread.messages) ? thread.messages as Array<Record<string, unknown>> : []
  return {
    id: thread.id,
    messages: messages.map((message) => {
      const payload = message.payload && typeof message.payload === 'object' ? message.payload as Record<string, unknown> : {}
      const headers = Array.isArray(payload.headers) ? payload.headers as Array<Record<string, unknown>> : []
      return {
        id: message.id,
        thread_id: message.threadId,
        snippet: clip(String(message.snippet ?? ''), 1_000),
        headers: Object.fromEntries(headers.map((header) => [String(header.name ?? '').toLowerCase(), clip(String(header.value ?? ''), 1_000)])),
        body: clip(gmailBody(payload), 12_000),
      }
    }),
  }
}

function gmailBody(payload: Record<string, unknown>): string {
  const mimeType = String(payload.mimeType ?? '')
  const body = payload.body && typeof payload.body === 'object' ? payload.body as Record<string, unknown> : {}
  if ((mimeType === 'text/plain' || !mimeType) && typeof body.data === 'string') {
    try { return Buffer.from(body.data, 'base64url').toString('utf8') } catch { return '' }
  }
  const parts = Array.isArray(payload.parts) ? payload.parts as Array<Record<string, unknown>> : []
  return parts.map(gmailBody).filter(Boolean).join('\n\n')
}

export function gmailReplyRaw(threadId: string, message: string, thread: Record<string, unknown>) {
  const messages = Array.isArray(thread.messages) ? thread.messages as Array<Record<string, unknown>> : []
  const latestMessage = messages.at(-1)
  const payload = latestMessage?.payload && typeof latestMessage.payload === 'object' ? latestMessage.payload as Record<string, unknown> : {}
  const headers = Array.isArray(payload.headers) ? payload.headers as Array<Record<string, unknown>> : []
  const header = (name: string) => String(headers.find((value) => String(value.name).toLowerCase() === name.toLowerCase())?.value ?? '').replace(/[\r\n]+/g, ' ').trim()
  const recipient = header('From')
  const originalSubject = header('Subject')
  const inReplyTo = header('Message-ID')
  if (!recipient || !inReplyTo) throw new ConnectionError('capability_changed', 'The Gmail thread no longer has reply headers.')
  const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject || 'Your message'}`
  const messageId = `<podex-${createHash('sha256').update(`${threadId}:${message}`).digest('hex').slice(0, 32)}@podex.local>`
  return [
    `To: ${recipient}`, `Subject: ${subject}`, `Message-ID: ${messageId}`,
    `In-Reply-To: ${inReplyTo}`, `References: ${[header('References'), inReplyTo].filter(Boolean).join(' ')}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit', '', message,
  ].join('\r\n')
}

function validInput(schema: Record<string, unknown>, input: Record<string, unknown>) {
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []
  if (required.some((key) => !(key in input))) return false
  if (schema.additionalProperties === false && schema.properties && typeof schema.properties === 'object') {
    const properties = schema.properties as Record<string, unknown>
    if (Object.keys(input).some((key) => !(key in properties))) return false
  }
  return true
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

export function publicEndpointFetch(fetcher: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit) {
  return fetcher(input, { ...init, dispatcher: publicEndpointAgent } as RequestInit)
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0)
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      return callback(Object.assign(new Error('private_endpoint'), { code: 'EACCES' }), '', 0)
    }
    if (options.all) return (callback as unknown as (error: null, addresses: Array<{ address: string, family: number }>) => void)(null, addresses)
    const selected = addresses[0]
    callback(null, selected.address, selected.family)
  })
}

const publicEndpointAgent = new Agent({ connect: { lookup: publicLookup } })

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
