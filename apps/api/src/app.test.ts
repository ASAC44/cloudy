import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import type { MiddlewareHandler } from 'hono'

import { createApp } from './app.js'
import { createAiModel, type AiTester } from './ai.js'
import { ConnectionService } from './connections.js'
import { RuleBuilderService, RuleBuilderError } from './rule-builder.js'
import type {
  AutomationKey,
  ApprovalRequest,
  Connection,
  NewConnection,
  NewRequest,
  OAuthState,
  PairingStatus,
  Pod,
  Store,
  StoredAiSettings,
} from './store.js'
import { StoreError } from './store.js'

const request: ApprovalRequest = {
  id: '00000000-0000-4000-8000-000000000002',
  title: 'Deploy the test build',
  source: 'Dashboard · Test Ping',
  summary: 'This is a persisted test request.',
  details: '',
  affected_context: '',
  risk: 'medium',
  warnings: [],
  priority: 1,
  payload_hash: 'a'.repeat(64),
  status: 'pending',
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  decided_at: null,
}

class FakeStore implements Store {
  pairingStatus: PairingStatus = 'pending'
  pairingTokenHash = ''
  pairingLimited = false
  claimError: string | null = null
  revoked = false
  decision: { outcome: string; decided_at: string } | null = null
  idempotent = new Map<string, { outcome: string; decided_at: string }>()
  aiSettings: StoredAiSettings | null = null
  connections: Connection[] = []
  connectionSecrets = new Map<string, string>()
  oauthStates = new Map<string, OAuthState>()
  automationKeys: Array<AutomationKey & { owner_id: string; token_hash: string }> = []
  automationRequests = new Map<string, ApprovalRequest>()
  automationIdempotency = new Map<string, ApprovalRequest>()
  pod: Pod = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Test Pod',
    paired_at: new Date().toISOString(),
    last_seen_at: null,
    revoked_at: null,
  }

  async createPairingSession(input: { podId: string; tokenHash: string }) {
    if (this.pairingLimited) throw new StoreError('pairing_rate_limited')
    this.pod.id = input.podId
    this.pairingTokenHash = input.tokenHash
    return { id: '00000000-0000-4000-8000-000000000009', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  }
  async getPairingStatus(_sessionId: string, podId: string, tokenHash: string) {
    return podId === this.pod.id && tokenHash === this.pairingTokenHash ? this.pairingStatus : null
  }
  async claimPairing(_codeHash: string, _ownerId: string, name: string) {
    if (this.claimError) throw new StoreError(this.claimError)
    if (name === 'Duplicate') throw new StoreError('active_pod_exists')
    return { ...this.pod, name }
  }
  async authenticatePod(podId: string, tokenHash: string) {
    return !this.revoked && podId === this.pod.id && tokenHash === this.pairingTokenHash
      ? { id: podId, ownerId: 'user-1' }
      : null
  }
  async listPods() { return [this.pod] }
  async revokePod(_ownerId: string, podId: string) {
    this.revoked = podId === this.pod.id
    return this.revoked
  }
  async createRequest(_ownerId: string, input: NewRequest, payloadHash: string) {
    return { ...request, ...input, payload_hash: payloadHash }
  }
  async listRequests() { return [request] }
  async currentRequest() { return { request, queueSize: 1 } }
  async decideRequest(input: { outcome: 'approved' | 'rejected'; payloadHash: string; idempotencyKey: string }) {
    const prior = this.idempotent.get(input.idempotencyKey)
    if (prior) return prior
    if (input.payloadHash !== request.payload_hash) throw new StoreError('payload_changed')
    if (this.decision) throw new StoreError('request_already_resolved')
    this.decision = { outcome: input.outcome, decided_at: new Date().toISOString() }
    this.idempotent.set(input.idempotencyKey, this.decision)
    return this.decision
  }
  async listAutomationKeys(ownerId: string) {
    return this.automationKeys
      .filter((key) => key.owner_id === ownerId && !key.revoked_at)
      .map(({ owner_id: _ownerId, token_hash: _tokenHash, ...key }) => key)
  }
  async createAutomationKey(ownerId: string, name: string, prefix: string, tokenHash: string) {
    if (this.automationKeys.some((key) => key.owner_id === ownerId && key.name === name && !key.revoked_at)) {
      throw new StoreError('automation_key_name_exists')
    }
    const key = {
      id: randomTestId(this.automationKeys.length + 20),
      owner_id: ownerId,
      name,
      prefix,
      token_hash: tokenHash,
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
    }
    this.automationKeys.push(key)
    const { owner_id: _ownerId, token_hash: _tokenHash, ...safe } = key
    return safe
  }
  async revokeAutomationKey(ownerId: string, keyId: string) {
    const key = this.automationKeys.find((item) => item.id === keyId && item.owner_id === ownerId && !item.revoked_at)
    if (!key) return false
    key.revoked_at = new Date().toISOString()
    return true
  }
  async authenticateAutomationKey(prefix: string, tokenHash: string) {
    const key = this.automationKeys.find((item) => item.prefix === prefix && item.token_hash === tokenHash && !item.revoked_at)
    if (!key) return null
    key.last_used_at = new Date().toISOString()
    return { id: key.id, ownerId: key.owner_id }
  }
  async createAutomationRequest(input: {
    ownerId: string
    externalId: string
    request: NewRequest
    payloadHash: string
  }) {
    const existing = this.automationIdempotency.get(input.externalId)
    if (existing) {
      if (existing.payload_hash !== input.payloadHash) throw new StoreError('idempotency_conflict')
      return existing
    }
    const created = {
      ...request,
      ...input.request,
      id: randomTestId(this.automationRequests.size + 40),
      payload_hash: input.payloadHash,
    }
    this.automationRequests.set(created.id, created)
    this.automationIdempotency.set(input.externalId, created)
    return created
  }
  async getAutomationRequest(ownerId: string, requestId: string) {
    return ownerId === 'user-1' ? this.automationRequests.get(requestId) ?? null : null
  }
  async cancelAutomationRequest(ownerId: string, requestId: string) {
    const approval = await this.getAutomationRequest(ownerId, requestId)
    if (!approval || approval.status !== 'pending') return false
    approval.status = 'cancelled'
    approval.decided_at = new Date().toISOString()
    return true
  }
  async expireRequests() {}
  async claimCallback() { return null }
  async completeCallback() {}
  async listConnections() { return this.connections }
  async getConnection(_ownerId: string, connectionId: string) {
    const connection = this.connections.find(({ id }) => id === connectionId)
    const encrypted_payload = this.connectionSecrets.get(connectionId)
    return connection && encrypted_payload ? { ...connection, encrypted_payload } : null
  }
  async createConnection(_ownerId: string, input: NewConnection, encryptedPayload: string) {
    const now = new Date().toISOString()
    const connection: Connection = {
      id: '00000000-0000-4000-8000-000000000010',
      ...input,
      status: 'untested',
      account_label: null,
      last_error: null,
      last_tested_at: null,
      created_at: now,
      updated_at: now,
    }
    this.connections.push(connection)
    this.connectionSecrets.set(connection.id, encryptedPayload)
    return connection
  }
  async updateConnection(
    _ownerId: string,
    connectionId: string,
    changes: Partial<Pick<Connection, 'name' | 'endpoint_url' | 'auth_type'>>,
    encryptedPayload?: string,
  ) {
    const index = this.connections.findIndex(({ id }) => id === connectionId)
    if (index < 0) return null
    this.connections[index] = { ...this.connections[index], ...changes, status: 'untested', updated_at: new Date().toISOString() }
    if (encryptedPayload) this.connectionSecrets.set(connectionId, encryptedPayload)
    return this.connections[index]
  }
  async updateConnectionSecret(connectionId: string, encryptedPayload: string) {
    this.connectionSecrets.set(connectionId, encryptedPayload)
  }
  async setConnectionTest(
    _ownerId: string,
    connectionId: string,
    result: { status: 'connected' | 'failed'; accountLabel: string | null; error: string | null },
  ) {
    const connection = this.connections.find(({ id }) => id === connectionId)
    if (!connection) return null
    Object.assign(connection, {
      status: result.status,
      account_label: result.accountLabel,
      last_error: result.error,
      last_tested_at: new Date().toISOString(),
    })
    return connection
  }
  async deleteConnection(_ownerId: string, connectionId: string) {
    const count = this.connections.length
    this.connections = this.connections.filter(({ id }) => id !== connectionId)
    this.connectionSecrets.delete(connectionId)
    return this.connections.length !== count
  }
  async createOAuthState(stateHash: string, state: OAuthState) { this.oauthStates.set(stateHash, state) }
  async consumeOAuthState(stateHash: string, provider: 'github' | 'gmail') {
    const state = this.oauthStates.get(stateHash)
    if (!state || state.provider !== provider) return null
    this.oauthStates.delete(stateHash)
    return state
  }
  async getAiSettings() { return this.aiSettings }
  async saveAiSettings(
    _ownerId: string,
    settings: Pick<StoredAiSettings, 'provider' | 'base_url' | 'model' | 'encrypted_api_key'>,
  ) {
    this.aiSettings = { ...settings, updated_at: new Date().toISOString() }
    return this.aiSettings
  }
  async getRule() { return null }
  async listRules() { return [] }
  async createRuleSession(): Promise<never> { throw new Error('Not implemented in this fake') }
  async getRuleSession() { return null }
  async updateRuleSession() { return null }
  async commitRuleSession(): Promise<never> { throw new Error('Not implemented in this fake') }
  async deleteRule() { return false }
}

function randomTestId(value: number) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
}

const authenticated: MiddlewareHandler = async (c, next) => {
  c.set('jwtPayload', { sub: 'user-1', email: 'test@example.com' })
  await next()
}

function app(
  store = new FakeStore(),
  fetcher: typeof fetch = fetch,
  providerConfig: {
    githubClientId?: string
    githubClientSecret?: string
    googleClientId?: string
    googleClientSecret?: string
  } = {},
  aiTester: AiTester = async () => undefined,
  ruleBuilder?: RuleBuilderService,
) {
  const connections = new ConnectionService(store, {
    encryptionKey: Buffer.alloc(32, 1).toString('base64'),
    publicApiUrl: 'https://api.example.com',
    webUrl: 'https://example.com',
    ...providerConfig,
  }, fetcher)
  return {
    store,
    connections,
    app: createApp('https://example.supabase.co', store, authenticated, connections, aiTester, ruleBuilder),
  }
}

test('health route is public', async () => {
  const response = await app().app.request('/')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { name: 'podex-api', status: 'ok' })
})

test('rule builder routes create, advance, commit, list, and delete definitions', async () => {
  const sessionId = randomTestId(70)
  const ruleId = randomTestId(71)
  const session = {
    id: sessionId,
    editing_rule_id: null,
    completed_rule_id: null,
    status: 'open' as const,
    revision: 1,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    messages: [],
    reply: {
      phase: 'needs_input' as const,
      message: 'What should I watch?',
      questions: [],
      connection_requirement: null,
      draft: {
        title: '', intent_summary: '', source_connection_id: '', capability_id: '', capability_name: '',
        capability_schema_hash: '', capability_safety: 'unannotated' as const, definition: {}, ready: false,
      },
    },
    capability_count: 2,
  }
  const rule = {
    id: ruleId,
    destination_pod_id: randomTestId(1),
    source_connection_id: randomTestId(10),
    title: 'OpenAI email',
    intent_summary: 'Ping for new email from OpenAI',
    capability_id: 'gmail.search',
    capability_name: 'Search email',
    capability_schema_hash: 'a'.repeat(64),
    capability_safety: 'verified_read' as const,
    definition: {},
    schema_version: 1 as const,
    revision: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  let deleted = false
  const builder = {
    createSession: async () => session,
    getSession: async () => session,
    turn: async () => ({ ...session, revision: 2 }),
    commit: async () => ({ committed: true as const, rule }),
    list: async () => [],
    delete: async () => { deleted = true; return true },
  } as unknown as RuleBuilderService
  const { app: api } = app(undefined, fetch, {}, async () => undefined, builder)

  const created = await api.request('/v1/rule-builder/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(created.status, 201)
  assert.equal((await created.json()).session.id, sessionId)
  const turn = await api.request(`/v1/rule-builder/sessions/${sessionId}/turns`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1, message: 'Emails from OpenAI' }),
  })
  assert.equal(turn.status, 200)
  assert.equal((await turn.json()).session.revision, 2)
  const committed = await api.request(`/v1/rule-builder/sessions/${sessionId}/commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1 }),
  })
  assert.equal((await committed.json()).rule.title, 'OpenAI email')
  assert.equal((await api.request('/v1/rules')).status, 200)
  assert.equal((await api.request(`/v1/rules/${ruleId}`, { method: 'DELETE' })).status, 204)
  assert.equal(deleted, true)
})

test('rule builder requires the configured user model before creating a persisted session', async () => {
  const store = new FakeStore()
  const { connections } = app(store)
  const builder = new RuleBuilderService(store, connections)
  await assert.rejects(
    builder.createSession('user-1'),
    (error: unknown) => error instanceof RuleBuilderError && error.code === 'ai_settings_required',
  )
})

test('automation keys are revealed once, listed safely, and revoked', async () => {
  const { app: api } = app()
  const created = await api.request('/v1/automation-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Production n8n' }),
  })
  const createdBody = await created.json()
  assert.equal(created.status, 201)
  assert.match(createdBody.token, /^pdx_[a-f0-9]{12}\.[A-Za-z0-9_-]{32}$/)

  const listedBody = await (await api.request('/v1/automation-keys')).json()
  assert.equal(listedBody.keys.length, 1)
  assert.equal(JSON.stringify(listedBody).includes(createdBody.token), false)
  assert.equal(Object.hasOwn(listedBody.keys[0], 'token_hash'), false)

  const revoked = await api.request(`/v1/automation-keys/${createdBody.key.id}`, { method: 'DELETE' })
  assert.equal(revoked.status, 204)
  assert.deepEqual((await (await api.request('/v1/automation-keys')).json()).keys, [])
})

test('automation approvals authenticate, remain idempotent, read, and cancel', async () => {
  const { app: api, store } = app()
  const key = await (await api.request('/v1/automation-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'n8n' }),
  })).json()
  const input = {
    title: 'Publish the release',
    summary: 'Publish version 1.4 to production.',
    risk: 'high',
    warnings: ['Public release'],
    expires_in_minutes: 15,
    callback_url: 'https://1.1.1.1/resume',
    action: { version: '1.4' },
  }
  const create = () => api.request('/v1/automation/approvals', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'execution-42',
    },
    body: JSON.stringify(input),
  })
  const first = await create()
  const firstBody = await first.json()
  const repeatedBody = await (await create()).json()
  assert.equal(first.status, 202)
  assert.equal(firstBody.request.id, repeatedBody.request.id)

  const conflict = await api.request('/v1/automation/approvals', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'execution-42',
    },
    body: JSON.stringify({ ...input, action: { version: '2.0' } }),
  })
  assert.equal(conflict.status, 409)

  const read = await api.request(`/v1/automation/approvals/${firstBody.request.id}`, {
    headers: { Authorization: `Bearer ${key.token}` },
  })
  assert.equal(read.status, 200)
  assert.equal((await read.json()).request.status, 'pending')

  const otherToken = `pdx_${'b'.repeat(12)}.${'c'.repeat(32)}`
  await store.createAutomationKey(
    'user-2',
    'Other tenant',
    `pdx_${'b'.repeat(12)}`,
    createHash('sha256').update(otherToken).digest('hex'),
  )
  const isolated = await api.request(`/v1/automation/approvals/${firstBody.request.id}`, {
    headers: { Authorization: `Bearer ${otherToken}` },
  })
  assert.equal(isolated.status, 404)

  const cancelled = await api.request(`/v1/automation/approvals/${firstBody.request.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${key.token}` },
  })
  assert.equal(cancelled.status, 204)
})

test('automation endpoints reject malformed and revoked credentials', async () => {
  const { app: api } = app()
  const malformed = await api.request('/v1/automation/approvals', {
    method: 'POST',
    headers: { Authorization: 'Bearer nope' },
  })
  assert.equal(malformed.status, 401)

  const key = await (await api.request('/v1/automation-keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Temporary' }),
  })).json()
  await api.request(`/v1/automation-keys/${key.key.id}`, { method: 'DELETE' })
  const revoked = await api.request(`/v1/automation/approvals/${request.id}`, {
    headers: { Authorization: `Bearer ${key.token}` },
  })
  assert.equal(revoked.status, 401)
})

test('AI settings encrypt the API key and never return it', async () => {
  let testedProvider = ''
  const { app: api, store } = app(undefined, fetch, {}, async (settings) => {
    testedProvider = settings.provider
  })
  const apiKey = 'test-secret-key'
  const saved = await api.request('/v1/settings/ai', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'cerebras',
      base_url: 'https://api.cerebras.ai/v1/',
      model: 'gpt-oss-120b',
      api_key: apiKey,
    }),
  })
  const savedBody = await saved.json()

  assert.equal(saved.status, 200)
  assert.equal(savedBody.settings.base_url, 'https://api.cerebras.ai/v1')
  assert.equal(savedBody.settings.provider, 'cerebras')
  assert.equal(savedBody.settings.has_api_key, true)
  assert.ok(store.aiSettings?.encrypted_api_key.startsWith('v1.'))
  assert.ok(!store.aiSettings?.encrypted_api_key.includes(apiKey))
  assert.ok(!JSON.stringify(savedBody).includes(apiKey))

  const readBody = await (await api.request('/v1/settings/ai')).json()
  assert.ok(!JSON.stringify(readBody).includes(apiKey))
  assert.equal(readBody.settings.model, 'gpt-oss-120b')

  const tested = await api.request('/v1/settings/ai/test', { method: 'POST' })
  assert.equal(tested.status, 200)
  assert.equal(testedProvider, 'cerebras')
})

test('AI model factory selects every configured provider', () => {
  const expected = {
    openai: 'openai.responses',
    cerebras: 'cerebras.chat',
    openrouter: 'openrouter',
    anthropic: 'anthropic.messages',
    custom: 'custom.chat',
  } as const

  for (const [provider, sdkProvider] of Object.entries(expected)) {
    const model = createAiModel({
      provider: provider as keyof typeof expected,
      base_url: 'https://example.com/v1',
      model: 'example-model',
    }, 'test-key')
    assert.notEqual(typeof model, 'string')
    if (typeof model === 'string') continue
    assert.equal(model.provider, sdkProvider)
    assert.equal(model.modelId, 'example-model')
  }
})

test('pairing creates a valid code and scoped Pod token', async () => {
  const { app: api } = app()
  const response = await api.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const body = await response.json()
  assert.equal(response.status, 201)
  assert.match(body.pairing_code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  assert.match(body.pod_token, /^pod_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)
})

test('pairing status rejects malformed tokens', async () => {
  const response = await app().app.request('/v1/pod/pairing-sessions/session', {
    headers: { Authorization: 'Bearer no' },
  })
  assert.equal(response.status, 401)
})

test('authenticated user can claim a pairing code', async () => {
  const response = await app().app.request('/v1/pods/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'ABCD1234', name: 'Kitchen Pod' }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).pod.name, 'Kitchen Pod')
})

test('claim rejects malformed and expired pairing codes', async () => {
  const malformed = await app().app.request('/v1/pods/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'INVALIDI', name: 'Kitchen Pod' }),
  })
  assert.equal(malformed.status, 400)

  const store = new FakeStore()
  store.claimError = 'invalid_pairing_code'
  const expired = await app(store).app.request('/v1/pods/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'ABCD1234', name: 'Kitchen Pod' }),
  })
  assert.equal(expired.status, 400)
})

test('pairing creation rate limits are exposed as 429', async () => {
  const store = new FakeStore()
  store.pairingLimited = true
  const response = await app(store).app.request('/v1/pod/pairing-sessions', { method: 'POST' })
  assert.equal(response.status, 429)
})

test('claim rejects a second active Pod', async () => {
  const response = await app().app.request('/v1/pods/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'ABCD1234', name: 'Duplicate' }),
  })
  assert.equal(response.status, 409)
})

test('test Ping validation rejects incomplete input', async () => {
  const response = await app().app.request('/v1/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Missing fields' }),
  })
  assert.equal(response.status, 400)
})

test('valid test Ping is persisted', async () => {
  const response = await app().app.request('/v1/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Deploy the test build',
      source: 'Dashboard · Test Ping',
      summary: 'This is only a test.',
      details: '',
      affected_context: '',
      risk: 'medium',
      warnings: [],
      expires_in_minutes: 15,
    }),
  })
  assert.equal(response.status, 201)
  assert.equal((await response.json()).request.status, 'pending')
})

test('Pod polls and resolves the exact current request', async () => {
  const { app: api } = app()
  const pairing = await api.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token } = await pairing.json()

  const current = await api.request('/v1/pod/requests/current', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(current.status, 200)
  assert.equal((await current.json()).queue_size, 1)

  const decision = await api.request(`/v1/pod/requests/${request.id}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      outcome: 'approved',
      payload_hash: request.payload_hash,
      idempotency_key: '00000000-0000-4000-8000-000000000003',
    }),
  })
  assert.equal(decision.status, 200)
  assert.equal((await decision.json()).decision.outcome, 'approved')
})

test('revocation immediately invalidates a Pod token', async () => {
  const { app: api } = app()
  const pairing = await api.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token, pod_token } = await pairing.json()
  const podId = pod_token.match(/^pod_([^.]+)/)[1]
  assert.equal((await api.request(`/v1/pods/${podId}`, { method: 'DELETE' })).status, 204)
  const current = await api.request('/v1/pod/requests/current', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(current.status, 401)
})

test('payload changes and concurrent decisions are rejected while retries are idempotent', async () => {
  const { app: api } = app()
  const pairing = await api.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token } = await pairing.json()
  const decide = (outcome: string, payloadHash: string, idempotencyKey: string) => api.request(
    `/v1/pod/requests/${request.id}/decision`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome, payload_hash: payloadHash, idempotency_key: idempotencyKey }),
    },
  )

  assert.equal((await decide('approved', 'b'.repeat(64), '00000000-0000-4000-8000-000000000004')).status, 409)
  const candidates = [
    { outcome: 'approved', key: '00000000-0000-4000-8000-000000000005' },
    { outcome: 'rejected', key: '00000000-0000-4000-8000-000000000006' },
  ]
  const outcomes = await Promise.all(candidates.map((candidate) =>
    decide(candidate.outcome, request.payload_hash, candidate.key),
  ))
  assert.deepEqual(outcomes.map((response) => response.status).sort(), [200, 409])
  const winner = candidates[outcomes.findIndex((response) => response.status === 200)]
  assert.equal((await decide(winner.outcome, request.payload_hash, winner.key)).status, 200)
})

test('invalid decision cannot reach the store', async () => {
  const { app: api } = app()
  const pairing = await api.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token } = await pairing.json()
  const response = await api.request(`/v1/pod/requests/${request.id}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome: 'approved', payload_hash: 'changed', idempotency_key: 'bad' }),
  })
  assert.equal(response.status, 400)
})

test('Vercel connection is encrypted, tested, and returned without its token', async () => {
  const fetcher: typeof fetch = async () => Response.json({ user: { username: 'octocat' } })
  const { app: api, store } = app(new FakeStore(), fetcher)
  const response = await api.request('/v1/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'vercel', name: 'Production', token: 'secret-token' }),
  })
  const body = await response.json()
  assert.equal(response.status, 201)
  assert.equal(body.connection.status, 'connected')
  assert.equal(body.connection.account_label, 'octocat')
  assert.equal(JSON.stringify(body).includes('secret-token'), false)
  assert.equal(store.connectionSecrets.get(body.connection.id)?.includes('secret-token'), false)
})

test('failed smoke test keeps the connection and never leaks credentials', async () => {
  const fetcher: typeof fetch = async () => new Response('bot-secret', { status: 401 })
  const { app: api } = app(new FakeStore(), fetcher)
  const response = await api.request('/v1/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'telegram', name: 'Alerts', token: 'bot-secret' }),
  })
  const body = await response.json()
  assert.equal(response.status, 201)
  assert.equal(body.connection.status, 'failed')
  assert.equal(JSON.stringify(body).includes('bot-secret'), false)
  assert.match(body.connection.last_error, /Authentication failed/)
})

test('custom MCP rejects private and non-HTTPS endpoints before saving', async () => {
  const store = new FakeStore()
  const { app: api } = app(store)
  for (const endpoint_url of ['http://example.com/mcp', 'https://127.0.0.1/mcp']) {
    const response = await api.request('/v1/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'custom_mcp', name: endpoint_url, endpoint_url, auth_type: 'none' }),
    })
    assert.equal(response.status, 400)
  }
  assert.equal(store.connections.length, 0)
})

test('custom MCP smoke test performs initialization and lists tools', async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body))
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
      : request.params?.cursor
        ? { tools: [{ name: 'delete_all', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } }] }
        : {
            tools: [
              { name: 'search_docs', description: 'Search docs', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
              { name: 'legacy_read', description: 'Missing annotations', inputSchema: { type: 'object' } },
            ],
            nextCursor: 'more',
          }
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  }
  const { app: api, connections } = app(new FakeStore(), fetcher)
  const response = await api.request('/v1/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'custom_mcp',
      name: 'Docs MCP',
      endpoint_url: 'https://example.com/mcp',
      auth_type: 'none',
    }),
  })
  const body = await response.json()
  assert.equal(response.status, 201)
  assert.equal(body.connection.status, 'connected')
  assert.equal(body.connection.account_label, '3 tools')
  const capabilities = await connections.discoverCapabilities('user-1')
  assert.deepEqual(capabilities.map(({ name, safety, callable_during_setup }) => ({ name, safety, callable_during_setup })), [
    { name: 'search_docs', safety: 'verified_read', callable_during_setup: true },
    { name: 'legacy_read', safety: 'unannotated', callable_during_setup: false },
  ])
})

test('connections can be renamed, retested, and removed', async () => {
  const fetcher: typeof fetch = async () => Response.json({ user: { email: 'owner@example.com' } })
  const { app: api } = app(new FakeStore(), fetcher)
  const created = await (await api.request('/v1/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'vercel', name: 'Old name', token: 'token' }),
  })).json()
  const id = created.connection.id
  const updated = await api.request(`/v1/connections/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New name' }),
  })
  assert.equal(updated.status, 200)
  assert.equal((await updated.json()).connection.name, 'New name')
  assert.equal((await api.request(`/v1/connections/${id}/test`, { method: 'POST' })).status, 200)
  assert.equal((await api.request(`/v1/connections/${id}`, { method: 'DELETE' })).status, 204)
  assert.deepEqual((await (await api.request('/v1/connections')).json()).connections, [])
})

test('OAuth start stores one-use state and returns a provider authorization URL', async () => {
  const store = new FakeStore()
  const { app: api } = app(store, fetch, { githubClientId: 'client-id', githubClientSecret: 'client-secret' })
  const response = await api.request('/v1/connections/oauth/github/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'GitHub work' }),
  })
  const url = new URL((await response.json()).authorization_url)
  assert.equal(response.status, 200)
  assert.equal(url.origin, 'https://github.com')
  assert.equal(url.searchParams.get('client_id'), 'client-id')
  assert.equal(store.oauthStates.size, 1)
  const [stateHash, state] = [...store.oauthStates.entries()][0]
  assert.deepEqual(await store.consumeOAuthState(stateHash, 'github'), state)
  assert.equal(await store.consumeOAuthState(stateHash, 'github'), null)
})

test('GitHub OAuth callback exchanges credentials and discovers MCP tools', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/login/oauth/access_token')) return Response.json({ access_token: 'github-token' })
    if (url === 'https://api.github.com/user') return Response.json({ login: 'octocat' })
    const request = JSON.parse(String(init?.body))
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'github', version: '1' } }
      : { tools: [] }
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  }
  const { app: api } = app(new FakeStore(), fetcher, {
    githubClientId: 'client-id', githubClientSecret: 'client-secret',
  })
  const start = await api.request('/v1/connections/oauth/github/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'GitHub work' }),
  })
  const state = new URL((await start.json()).authorization_url).searchParams.get('state')!
  const callback = await api.request(`/v1/connections/oauth/github/callback?state=${encodeURIComponent(state)}&code=code`)
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.get('location'), 'https://example.com/connections?connected=github')
  const connections = (await (await api.request('/v1/connections')).json()).connections
  assert.equal(connections[0].account_label, 'octocat')
  assert.equal(connections[0].status, 'connected')
})

test('Gmail OAuth refreshes an expired token before reading the profile', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://oauth2.googleapis.com/token' && calls.length === 1) {
      return Response.json({ access_token: 'expired-token', refresh_token: 'refresh-token', expires_in: 0 })
    }
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fresh-token', expires_in: 3600 })
    if (url.includes('/gmail/v1/users/me/profile')) return Response.json({ emailAddress: 'owner@example.com' })
    return new Response(null, { status: 404 })
  }
  const { app: api } = app(new FakeStore(), fetcher, {
    googleClientId: 'google-id', googleClientSecret: 'google-secret',
  })
  const start = await api.request('/v1/connections/oauth/gmail/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Inbox' }),
  })
  const state = new URL((await start.json()).authorization_url).searchParams.get('state')!
  const callback = await api.request(`/v1/connections/oauth/gmail/callback?state=${encodeURIComponent(state)}&code=code`)
  assert.equal(callback.status, 302)
  assert.deepEqual(calls, [
    'https://oauth2.googleapis.com/token',
    'https://oauth2.googleapis.com/token',
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  ])
  const connections = (await (await api.request('/v1/connections')).json()).connections
  assert.equal(connections[0].account_label, 'owner@example.com')
  assert.equal(connections[0].status, 'connected')
})
