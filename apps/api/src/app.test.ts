import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import type { MiddlewareHandler } from 'hono'

import { createApp, normalizeTelegramBotUpdate } from './app.js'
import { createAiModel, type AiTester } from './ai.js'
import { ConnectionService } from './connections.js'
import { GithubApiError } from './github-pr.js'
import { RuleBuilderService, RuleBuilderError } from './rule-builder.js'
import type { PodEvent, PodEventSource } from './pod-events.js'
import type {
  AutomationKey,
  AgentMemory,
  ApprovalRequest,
  Connection,
  NewConnection,
  NewRequest,
  OAuthState,
  OAuthProvider,
  PairingStatus,
  Pod,
  RuntimeStore,
  Store,
  StoredAiSettings,
} from './types/store.js'
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
  lastCodexInteraction: { summary: string; encryptedPayload: string } | null = null
  codexTarget: { workspace_id: string; thread_id: string | null; revision: number; updated_at: string } | null = null
  lastBridgeError: string | null = null
  current: ApprovalRequest = request
  pingPresentation: { encryptedDraft: string; actionHash: string } | null = null
  pod: Pod = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Test Pod',
    paired_at: new Date().toISOString(),
    last_seen_at: null,
    revoked_at: null,
    screen_layout: { left: ['app:github'], right: ['app:gmail'], down: ['app:codex'] },
    screen_layout_revision: 0,
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
      ? { id: podId, ownerId: 'user-1', screenLayout: this.pod.screen_layout }
      : null
  }
  async touchPod(podId: string) { return !this.revoked && podId === this.pod.id }
  async listPods() { return [this.pod] }
  async updatePodScreenLayout(_ownerId: string, podId: string, expectedRevision: number, layout: Pod['screen_layout']) {
    if (podId !== this.pod.id) throw new StoreError('pod_not_found')
    if (expectedRevision !== this.pod.screen_layout_revision) throw new StoreError('pod_layout_conflict')
    this.pod.screen_layout = layout
    this.pod.screen_layout_revision += 1
    return this.pod
  }
  async revokePod(_ownerId: string, podId: string) {
    this.revoked = podId === this.pod.id
    return this.revoked
  }
  async createRequest(_ownerId: string, input: NewRequest, payloadHash: string) {
    return { ...request, ...input, payload_hash: payloadHash }
  }
  async listRequests() { return [request] }
  async currentRequest() { return { request: this.current, queueSize: 1 } }
  async pingEventPresentation() { return this.pingPresentation }
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
  async listAgentMemories() { return [] as AgentMemory[] }
  async listMemoryIdentities() { return [] }
  async upsertAgentMemory(input: { ownerId: string; scope: AgentMemory['scope']; scopeId?: string; provider?: AgentMemory['provider']; memoryKey: string; content: string; source?: Record<string, unknown> }) {
    return { id: randomTestId(90), owner_id: input.ownerId, scope: input.scope, scope_id: input.scopeId ?? null, provider: input.provider ?? null, memory_key: input.memoryKey, content: input.content, source: input.source ?? {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  }
  async deleteAgentMemory() { return true }
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
    result: {
      status: 'connected' | 'failed'
      accountLabel: string | null
      error: string | null
      encryptedPayload?: string
    },
  ) {
    const connection = this.connections.find(({ id }) => id === connectionId)
    if (!connection) return null
    if (result.encryptedPayload) this.connectionSecrets.set(connectionId, result.encryptedPayload)
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
  async consumeOAuthState(stateHash: string, provider: OAuthProvider) {
    const state = this.oauthStates.get(stateHash)
    if (!state || state.provider !== provider) return null
    this.oauthStates.delete(stateHash)
    return state
  }
  async getAiSettings() { return this.aiSettings }
  async setPersonalization(_ownerId: string, enabled: boolean) {
    if (!this.aiSettings) return false
    this.aiSettings.personalization_enabled = enabled
    return true
  }
  async saveAiSettings(
    _ownerId: string,
    settings: Pick<StoredAiSettings, 'provider' | 'base_url' | 'model' | 'encrypted_api_key'>,
  ) {
    this.aiSettings = { ...settings, personalization_enabled: this.aiSettings?.personalization_enabled ?? true, updated_at: new Date().toISOString() }
    return this.aiSettings
  }
  async createCodexPairing(input: { bridgeId: string; tokenHash: string }) {
    this.pod.id = input.bridgeId
    this.pairingTokenHash = input.tokenHash
    return { id: randomTestId(80), expiresAt: new Date(Date.now() + 60_000).toISOString() }
  }
  async getCodexPairingStatus(_sessionId: string, bridgeId: string, tokenHash: string) {
    return bridgeId === this.pod.id && tokenHash === this.pairingTokenHash ? this.pairingStatus : null
  }
  async claimCodexBridge(_codeHash: string, _ownerId: string, name: string) {
    return { id: this.pod.id, name, version: null, last_error: null, paired_at: new Date().toISOString(), last_seen_at: null }
  }
  async authenticateCodexBridge(bridgeId: string, tokenHash: string) {
    return bridgeId === this.pod.id && tokenHash === this.pairingTokenHash ? { id: bridgeId, ownerId: 'user-1' } : null
  }
  async listCodex() { return { bridges: [], workspaces: [], threads: [], target: null } }
  async revokeCodexBridge() { return true }
  async syncCodexBridge(input: { error: string | null }) { this.lastBridgeError = input.error; return { workspaces: [], threads: [] } }
  async setCodexTarget() { return null }
  async queueCodexCommand(input: { workspaceId: string; threadId: string | null; kind: 'prompt' | 'new_thread'; payload: Record<string, unknown>; idempotencyKey: string; targetRevision?: number | null }) {
    if (input.targetRevision && input.targetRevision !== this.codexTarget?.revision) throw new StoreError('codex_target_changed')
    return { id: randomTestId(81), workspace_id: input.workspaceId, thread_id: input.threadId, interaction_id: null, kind: input.kind, payload: input.payload, idempotency_key: input.idempotencyKey }
  }
  async reviseCodexPlan(input: { requestId: string; prompt: string; promptIdempotencyKey: string }) {
    return { id: randomTestId(82), workspace_id: randomTestId(83), thread_id: null, interaction_id: input.requestId, kind: 'prompt' as const, payload: { prompt: input.prompt }, idempotency_key: input.promptIdempotencyKey }
  }
  async createCodexInteraction(input: { title: string; summary: string; risk: 'low' | 'medium' | 'high'; payloadHash: string; expiresAt: string; encryptedPayload: string }) {
    this.lastCodexInteraction = { summary: input.summary, encryptedPayload: input.encryptedPayload }
    return { ...request, title: input.title, summary: input.summary, risk: input.risk, payload_hash: input.payloadHash, expires_at: input.expiresAt }
  }
  async claimCodexCommand() { return null }
  async acknowledgeCodexCommand() { return true }
  async codexStatus() { return { target: this.codexTarget, thread: null } }
  async codexInteractionPayload() { return null }
  async getRule() { return null }
  async listRules() { return [] }
  async createRuleSession(): Promise<never> { throw new Error('Not implemented in this fake') }
  async getRuleSession() { return null }
  async updateRuleSession() { return null }
  async commitRuleSession(): Promise<never> { throw new Error('Not implemented in this fake') }
  async deleteRule() { return false }
  async listActiveRulesForConnection() { return [] }
}

class FakePodEvents implements PodEventSource {
  ready = true
  private listeners = new Map<string, Set<(event: PodEvent) => void>>()
  private status = new Set<(ready: boolean) => void>()

  subscribe(ownerId: string, listener: (event: PodEvent) => void) {
    const listeners = this.listeners.get(ownerId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(ownerId, listeners)
    return () => listeners.delete(listener)
  }

  subscribeStatus(listener: (ready: boolean) => void) {
    this.status.add(listener)
    return () => this.status.delete(listener)
  }

  publish(event: PodEvent) {
    for (const listener of this.listeners.get(event.ownerId) ?? []) listener(event)
  }

  degrade() {
    this.ready = false
    for (const listener of this.status) listener(false)
  }
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
  podEvents?: PodEventSource,
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
    app: createApp('https://example.supabase.co', store, authenticated, connections, aiTester, ruleBuilder, fetcher, store as unknown as RuntimeStore, podEvents),
  }
}

test('health route is public', async () => {
  const response = await app().app.request('/')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { name: 'cloudy-api', status: 'ok' })
})

test('Telegram personal setup fails before creating a session when app credentials are missing', async () => {
  const response = await app().app.request('/v1/connections/telegram/user-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Telegram' }),
  })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'provider not configured' })
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

test('rule builder returns safe GitHub permission errors', async () => {
  const ruleBuilder = { turn: async () => { throw new GithubApiError('permission') } } as unknown as RuleBuilderService
  const response = await app(new FakeStore(), fetch, {}, async () => undefined, ruleBuilder).app.request(
    `/v1/rule-builder/sessions/${randomTestId(72)}/turns`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1, message: 'owner/repository' }) },
  )
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'github permission' })
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
  assert.equal(store.automationRequests.get(firstBody.request.id)?.source, 'Automation')

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
  assert.equal(savedBody.settings.personalization_enabled, true)
  assert.ok(store.aiSettings?.encrypted_api_key.startsWith('v1.'))
  assert.ok(!store.aiSettings?.encrypted_api_key.includes(apiKey))
  assert.ok(!JSON.stringify(savedBody).includes(apiKey))

  const readBody = await (await api.request('/v1/settings/ai')).json()
  assert.ok(!JSON.stringify(readBody).includes(apiKey))
  assert.equal(readBody.settings.model, 'gpt-oss-120b')

  const personalization = await api.request('/v1/settings/personalization', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  })
  assert.equal(personalization.status, 200)
  assert.equal((await personalization.json()).personalization_enabled, false)
  assert.equal(store.aiSettings?.personalization_enabled, false)

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

test('Pod realtime stream authenticates, isolates owners, invalidates, and revokes', async () => {
  const events = new FakePodEvents()
  const setup = app(new FakeStore(), fetch, {}, async () => undefined, undefined, events)
  const paired = await (await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })).json()
  const response = await setup.app.request('/v1/pod/events', {
    headers: { Authorization: `Bearer ${paired.pod_token}` },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const read = async () => decoder.decode((await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE read timed out')), 1_000)),
  ])).value)

  assert.match(await read(), /event: sync\ndata: {}/)
  events.publish({ ownerId: 'user-2', podId: null, scope: 'request' })
  events.publish({ ownerId: 'user-1', podId: null, scope: 'layout' })
  assert.match(await read(), /event: invalidate\ndata: {"scope":"layout"}/)
  events.publish({ ownerId: 'user-1', podId: setup.store.pod.id, scope: 'revoked' })
  assert.match(await read(), /event: revoked\ndata: {}/)
})

test('Pod realtime stream returns 503 while its relay is degraded and closes if it degrades', async () => {
  const unavailable = new FakePodEvents()
  unavailable.ready = false
  const unavailableSetup = app(new FakeStore(), fetch, {}, async () => undefined, undefined, unavailable)
  const unavailablePairing = await (await unavailableSetup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })).json()
  const rejected = await unavailableSetup.app.request('/v1/pod/events', { headers: { Authorization: `Bearer ${unavailablePairing.pod_token}` } })
  assert.equal(rejected.status, 503)

  const events = new FakePodEvents()
  const setup = app(new FakeStore(), fetch, {}, async () => undefined, undefined, events)
  const paired = await (await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })).json()
  const response = await setup.app.request('/v1/pod/events', { headers: { Authorization: `Bearer ${paired.pod_token}` } })
  const reader = response.body!.getReader()
  await reader.read()
  events.degrade()
  assert.equal((await reader.read()).done, true)
})

test('Pod realtime stream rejects malformed credentials', async () => {
  const response = await app(new FakeStore(), fetch, {}, async () => undefined, undefined, new FakePodEvents()).app.request('/v1/pod/events', {
    headers: { Authorization: 'Bearer invalid' },
  })
  assert.equal(response.status, 401)
})

test('Codex bridge authentication requires a process instance for command claims', async () => {
  const { app: api } = app()
  const paired = await (await api.request('/v1/codex/bridge/pairing-sessions', { method: 'POST' })).json()
  const withoutInstance = await api.request('/v1/codex/bridge/commands', { headers: { Authorization: `Bearer ${paired.bridge_token}` } })
  assert.equal(withoutInstance.status, 400)
  const claimed = await api.request('/v1/codex/bridge/commands', { headers: { Authorization: `Bearer ${paired.bridge_token}`, 'X-Cloudy-Bridge-Instance': randomTestId(86) } })
  assert.equal(claimed.status, 200)
  assert.deepEqual(await claimed.json(), { command: null })
})

test('bridge heartbeat reports incompatible Codex versions to the dashboard', async () => {
  const { app: api, store } = app()
  const paired = await (await api.request('/v1/codex/bridge/pairing-sessions', { method: 'POST' })).json()
  const response = await api.request('/v1/codex/bridge/sync', {
    method: 'POST', headers: { Authorization: `Bearer ${paired.bridge_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 'codex-cli 0.143.9', process_instance_id: randomTestId(89), workspaces: [], threads: [] }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).compatible, false)
  assert.match(store.lastBridgeError || '', /0\.144\.5/)
})

test('Codex interactions encrypt raw payloads and expose only server-sanitized metadata', async () => {
  const { app: api, store } = app()
  const paired = await (await api.request('/v1/codex/bridge/pairing-sessions', { method: 'POST' })).json()
  const rawCommand = 'curl https://secret.example.test --header private-token'
  const response = await api.request('/v1/codex/bridge/interactions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${paired.bridge_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace_id: randomTestId(87), thread_id: null, process_instance_id: randomTestId(88),
      protocol_request_id: 'rpc-1', kind: 'command_approval',
      payload: { method: 'item/commandExecution/requestApproval', params: { command: rawCommand } },
      title: rawCommand, summary: rawCommand, risk: 'low',
    }),
  })
  const body = await response.json()
  assert.equal(response.status, 202)
  assert.equal(body.request.summary, 'Codex wants to run a repository command.')
  assert.equal(JSON.stringify(body).includes(rawCommand), false)
  assert.equal(store.lastCodexInteraction?.encryptedPayload.includes(rawCommand), false)
})

test('Pod voice returns setup conflict unless official OpenAI settings are configured', async () => {
  const { app: api } = app()
  const paired = await (await api.request('/v1/pod/pairing-sessions', { method: 'POST' })).json()
  const response = await api.request('/v1/pod/codex/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${paired.pod_token}` }, body: new FormData(),
  })
  assert.equal(response.status, 409)
})

test('Pod voice validates WAV and always uses the fixed transcription model', async () => {
  let upstreamModel = ''
  const fetcher: typeof fetch = async (_input, init) => {
    upstreamModel = String((init?.body as FormData).get('model'))
    return Response.json({ text: 'Implement the smaller retry loop' })
  }
  const setup = app(new FakeStore(), fetcher)
  setup.store.aiSettings = {
    provider: 'openai', base_url: 'https://api.openai.com/v1', model: 'ignored-for-voice',
    encrypted_api_key: setup.connections.encryptApiKey('voice-key'), personalization_enabled: true, updated_at: new Date().toISOString(),
  }
  const paired = await (await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })).json()
  const wav = new Uint8Array(44 + 3200)
  const view = new DataView(wav.buffer)
  wav.set(Buffer.from('RIFF'), 0); view.setUint32(4, wav.length - 8, true); wav.set(Buffer.from('WAVEfmt '), 8)
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  wav.set(Buffer.from('data'), 36); view.setUint32(40, 3200, true)
  const form = new FormData(); form.set('audio', new File([wav], 'voice.wav', { type: 'audio/wav' }))
  const response = await setup.app.request('/v1/pod/codex/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${paired.pod_token}` }, body: form,
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).transcript, 'Implement the smaller retry loop')
  assert.equal(upstreamModel, 'gpt-4o-mini-transcribe')
})

test('confirmed Pod prompts reject stale active-target revisions', async () => {
  const setup = app()
  setup.store.codexTarget = { workspace_id: randomTestId(90), thread_id: randomTestId(91), revision: 4, updated_at: new Date().toISOString() }
  const paired = await (await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })).json()
  const response = await setup.app.request('/v1/pod/codex/prompts', {
    method: 'POST', headers: { Authorization: `Bearer ${paired.pod_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Build it', target_revision: 3, idempotency_key: randomTestId(92) }),
  })
  assert.equal(response.status, 409)
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

test('screen layouts persist once and reject invalid or stale writes', async () => {
  const setup = app()
  const layout = { left: ['app:vercel', 'app:github'], right: ['app:gmail'], down: ['app:codex'] }
  const saved = await setup.app.request(`/v1/pods/${setup.store.pod.id}/screen-layout`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout, revision: 0 }),
  })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).screen_layout_revision, 1)
  assert.deepEqual(setup.store.pod.screen_layout, layout)

  const stale = await setup.app.request(`/v1/pods/${setup.store.pod.id}/screen-layout`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout, revision: 0 }),
  })
  assert.equal(stale.status, 409)

  const invalid = await setup.app.request(`/v1/pods/${setup.store.pod.id}/screen-layout`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout: { left: ['app:github', 'app:gmail', 'app:codex', 'app:vercel', 'app:telegram', 'app:linear', 'app:stripe'], right: [], down: [] }, revision: 1 }),
  })
  assert.equal(invalid.status, 400)
})

test('mascot actions validate ownership and are consumed by one Pod poll', async () => {
  const setup = app()
  const pairing = await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token } = await pairing.json()
  const route = `/v1/pods/${setup.store.pod.id}/mascot-action`

  const invalid = await setup.app.request(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dance' }),
  })
  assert.equal(invalid.status, 400)

  const queued = await setup.app.request(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'jump' }),
  })
  assert.equal(queued.status, 202)

  const first = await setup.app.request('/v1/pod/requests/current', { headers: { Authorization: `Bearer ${token}` } })
  const second = await setup.app.request('/v1/pod/requests/current', { headers: { Authorization: `Bearer ${token}` } })
  assert.equal((await first.json()).mascot_action, 'jump')
  assert.equal((await second.json()).mascot_action, null)

  const missing = await setup.app.request(`/v1/pods/${randomTestId(99)}/mascot-action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'blink' }),
  })
  assert.equal(missing.status, 404)
})

test('screen navigation validates ownership and delivers rapid commands in order', async () => {
  const setup = app()
  const pairing = await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token } = await pairing.json()
  const route = `/v1/pods/${setup.store.pod.id}/screen-navigation`

  const invalid = await setup.app.request(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'diagonal' }),
  })
  assert.equal(invalid.status, 400)

  const queued = await setup.app.request(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
  })
  assert.equal(queued.status, 202)
  await setup.app.request(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'right' }),
  })
  await setup.app.request(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'scroll_down' }),
  })
  await setup.app.request(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'scroll_up' }),
  })

  const first = await setup.app.request('/v1/pod/requests/current', { headers: { Authorization: `Bearer ${token}` } })
  const second = await setup.app.request('/v1/pod/requests/current', { headers: { Authorization: `Bearer ${token}` } })
  assert.deepEqual((await first.json()).screen_navigation, ['up', 'right', 'scroll_down', 'scroll_up'])
  assert.deepEqual((await second.json()).screen_navigation, [])
})

test('test Ping validation rejects incomplete input', async () => {
  const response = await app().app.request('/v1/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Missing fields' }),
  })
  assert.equal(response.status, 400)
})

test('test Ping validation rejects malformed warning entries', async () => {
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
      warnings: [null],
      expires_in_minutes: 15,
    }),
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
      mock_type: 'github',
      screen: 'left',
    }),
  })
  assert.equal(response.status, 201)
  const created = (await response.json()).request
  assert.equal(created.status, 'pending')
  assert.equal(created.action_payload.mock_type, 'github')
  assert.equal(created.action_payload.screen, 'left')
})

test('mock Ping screen overrides its app layout', async () => {
  const setup = app()
  setup.store.current = { ...request, action_payload: { kind: 'test_ping', mock_type: 'gmail', screen: 'left' } }
  const pairing = await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token } = await pairing.json()

  const response = await setup.app.request('/v1/pod/requests/current', {
    headers: { Authorization: `Bearer ${token}` },
  })

  assert.equal(response.status, 200)
  assert.equal((await response.json()).request_screen, 'left')
})

test('mock Pings receive realistic provider presentations in the Pod snapshot', async () => {
  const setup = app()
  const pairing = await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token } = await pairing.json()

  for (const [mockType, kind] of [['general', 'notification_v1'], ['github', 'github_pr_v1'], ['deployment', 'notification_v1'], ['gmail', 'email_reply_v1'], ['codex', 'codex_plan_v1']]) {
    setup.store.current = { ...request, action_payload: { kind: 'test_ping', mock_type: mockType, screen: 'down' } }
    const response = await setup.app.request('/v1/pod/requests/current', { headers: { Authorization: `Bearer ${token}` } })
    const body = await response.json()
    assert.equal(body.request.presentation.kind, kind)
    if (mockType === 'deployment') assert.match(body.request.presentation.recommended_action, /Rollback traffic/)
    if (mockType === 'gmail') assert.doesNotMatch(body.request.presentation.response, /—/)
    if (mockType === 'codex') assert.match(body.request.codex_payload.plan, /workspace_members/)
  }
})

test('dashboard resolves the authoritative pending Ping through the active Pod', async () => {
  const setup = app()
  const pairing = await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token } = await pairing.json()
  const response = await setup.app.request(`/v1/requests/${request.id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      outcome: 'approved',
      idempotency_key: '00000000-0000-4000-8000-000000000003',
    }),
  })

  assert.equal(response.status, 200)
  assert.equal((await response.json()).decision.outcome, 'approved')
  assert.equal(setup.store.decision?.outcome, 'approved')
  const first = await setup.app.request('/v1/pod/requests/current', { headers: { Authorization: `Bearer ${token}` } })
  const second = await setup.app.request('/v1/pod/requests/current', { headers: { Authorization: `Bearer ${token}` } })
  assert.equal((await first.json()).decision_animation, 'approved')
  assert.equal((await second.json()).decision_animation, null)
})

test('Pod polls and resolves the exact current request', async () => {
  const { app: api } = app()
  const pairing = await api.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token } = await pairing.json()

  const current = await api.request('/v1/pod/requests/current', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(current.status, 200)
  const currentBody = await current.json()
  assert.equal(currentBody.queue_size, 1)
  assert.deepEqual(currentBody.screen_layout, {
    left: ['app:github'], right: ['app:gmail'], down: ['app:codex'],
  })
  assert.equal(currentBody.request_screen, 'down')
  assert.equal('screen_items' in currentBody, false)

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

test('Pod routes a notification to its configured feed screen', async () => {
  const setup = app()
  setup.store.current = { ...request, source: 'GitHub · PR merge' }
  const pairing = await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })
  const { pod_token: token } = await pairing.json()
  const current = await setup.app.request('/v1/pod/requests/current', {
    headers: { Authorization: `Bearer ${token}` },
  })

  assert.equal((await current.json()).request_screen, 'left')
})

test('Pod receives an authenticated hash-bound GitHub presentation', async () => {
  const setup = app()
  setup.store.current = {
    ...request,
    action_payload: { kind: 'ping_rule_action', event_id: randomTestId(40), rule_id: randomTestId(41) },
  }
  setup.store.pingPresentation = {
    actionHash: request.payload_hash,
    encryptedDraft: setup.connections.encryptPrivatePayload({
      kind: 'github_pr_v1', context: 'cloudy/api · feature → main', facts: [['MERGE', 'Squash']],
      summary: 'Verified GitHub facts.', glance_details: [], details: [], ai_available: false,
    }),
  }
  const paired = await (await setup.app.request('/v1/pod/pairing-sessions', { method: 'POST' })).json()
  const response = await setup.app.request('/v1/pod/requests/current', {
    headers: { Authorization: `Bearer ${paired.pod_token}` },
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).request.presentation.kind, 'github_pr_v1')

  setup.store.pingPresentation.actionHash = 'b'.repeat(64)
  const changed = await setup.app.request('/v1/pod/requests/current', {
    headers: { Authorization: `Bearer ${paired.pod_token}` },
  })
  assert.equal(changed.status, 409)
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

test('Linear and Stripe use fixed authenticated MCP endpoints without leaking keys', async () => {
  for (const provider of ['linear', 'stripe'] as const) {
    const expectedEndpoint = provider === 'linear' ? 'https://mcp.linear.app/mcp' : 'https://mcp.stripe.com/'
    const authorizations: string[] = []
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(String(input), expectedEndpoint)
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      const request = JSON.parse(String(init?.body))
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: provider, version: '1' } }
        : { tools: [{ name: 'list_items', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
      return Response.json({ jsonrpc: '2.0', id: request.id, result })
    }
    const { app: api, store } = app(new FakeStore(), fetcher)
    const created = await api.request('/v1/connections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, name: provider, token: `${provider}-secret` }),
    })
    const body = await created.json()
    assert.equal(created.status, 201)
    assert.equal(body.connection.protocol, 'mcp')
    assert.equal(body.connection.auth_type, 'bearer')
    assert.equal(body.connection.endpoint_url, expectedEndpoint.replace(/\/$/, ''))
    assert.equal(body.connection.account_label, '1 tool')
    assert.equal(JSON.stringify(body).includes(`${provider}-secret`), false)
    assert.equal(store.connectionSecrets.get(body.connection.id)?.includes(`${provider}-secret`), false)
    assert.ok(authorizations.every((value) => value === `Bearer ${provider}-secret`))

    authorizations.length = 0
    const replaced = await api.request(`/v1/connections/${body.connection.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: `${provider}-replacement` }),
    })
    assert.equal(replaced.status, 200)
    assert.ok(authorizations.every((value) => value === `Bearer ${provider}-replacement`))
    for (const changes of [{ endpoint_url: 'https://example.com/mcp' }, { auth_type: 'none' }]) {
      const response = await api.request(`/v1/connections/${body.connection.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
      })
      assert.equal(response.status, 400)
    }
  }
})

test('Linear and Stripe reject missing or unauthorized keys safely', async () => {
  for (const provider of ['linear', 'stripe'] as const) {
    const setup = app(new FakeStore(), async () => new Response('private upstream detail', { status: 401 }))
    const missing = await setup.app.request('/v1/connections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, name: provider }),
    })
    assert.equal(missing.status, 400)
    const failed = await setup.app.request('/v1/connections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, name: provider, token: 'bad-key' }),
    })
    const body = await failed.json()
    assert.equal(failed.status, 201)
    assert.equal(body.connection.status, 'failed')
    assert.match(body.connection.last_error, /Authentication failed/)
    assert.equal(JSON.stringify(body).includes('bad-key'), false)
    assert.equal(JSON.stringify(body).includes('private upstream detail'), false)
  }
})

test('Stripe capability discovery keeps only annotated non-destructive tools runtime-safe', async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body))
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stripe', version: '1' } }
      : { tools: [
          { name: 'retrieve_balance', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'create_customer', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: false } },
          { name: 'create_refund', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
          { name: 'legacy_tool', inputSchema: { type: 'object' } },
        ] }
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  }
  const { app: api, connections } = app(new FakeStore(), fetcher)
  await api.request('/v1/connections', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'stripe', name: 'Stripe', token: 'rk_test_key' }),
  })
  const capabilities = await connections.discoverCapabilities('user-1')
  assert.deepEqual(capabilities.map(({ name, safety, roles, runtime_safe }) => ({ name, safety, roles, runtime_safe })), [
    { name: 'retrieve_balance', safety: 'verified_read', roles: ['source', 'context', 'setup'], runtime_safe: true },
    { name: 'create_customer', safety: 'verified_write', roles: ['action'], runtime_safe: true },
    { name: 'legacy_tool', safety: 'unannotated', roles: ['source', 'context', 'action'], runtime_safe: false },
  ])
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

test('Telegram bot registers an authenticated webhook, exposes event/send capabilities, and accepts updates', async () => {
  let webhook: Record<string, unknown> = {}
  let sent: Record<string, unknown> = {}
  let webhookDeleted = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { username: 'podex_test_bot' } })
    if (url.endsWith('/setWebhook')) {
      webhook = JSON.parse(String(init?.body))
      return Response.json({ ok: true, result: true })
    }
    if (url.endsWith('/sendMessage')) {
      sent = JSON.parse(String(init?.body))
      return Response.json({ ok: true, result: { message_id: 99 } })
    }
    if (url.endsWith('/deleteWebhook')) {
      webhookDeleted = true
      return Response.json({ ok: true, result: true })
    }
    return new Response(null, { status: 404 })
  }
  const setup = app(new FakeStore(), fetcher)
  const created = await setup.app.request('/v1/connections', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'telegram', name: 'Alerts', token: 'bot-secret' }),
  })
  const body = await created.json()
  assert.equal(body.connection.status, 'connected')
  assert.match(String(webhook.url), /\/v1\/webhooks\/telegram\/user-1\/00000000-0000-4000-8000-000000000010$/)
  assert.equal(typeof webhook.secret_token, 'string')

  const capabilities = await setup.connections.discoverConnectionCapabilities('user-1', body.connection.id)
  assert.deepEqual(capabilities.map(({ name }) => name), ['telegram.new_message', 'telegram.bot_send_text'])
  await setup.connections.callRuntimeCapability('user-1', capabilities[1], { peer_id: '-10042', message: 'Approved reply' }, 'action')
  assert.deepEqual(sent, { chat_id: '-10042', text: 'Approved reply' })

  const path = `/v1/webhooks/telegram/00000000-0000-4000-8000-000000000099/${body.connection.id}`
  const update = { update_id: 1, message: { message_id: 7, date: 1_721_000_000, text: 'Need approval', from: { id: 42, username: 'ava' }, chat: { id: -10042, type: 'supergroup', title: 'Ops' } } }
  assert.equal((await setup.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }, body: JSON.stringify(update) })).status, 401)
  assert.equal((await setup.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': String(webhook.secret_token) }, body: JSON.stringify(update) })).status, 200)
  assert.equal((await setup.app.request(`/v1/connections/${body.connection.id}`, { method: 'DELETE' })).status, 204)
  assert.equal(webhookDeleted, true)
})

test('Telegram bot updates normalize text, sender, chat type, and stable identity', () => {
  assert.deepEqual(normalizeTelegramBotUpdate({
    channel_post: { message_id: 8, date: 1_721_000_000, caption: 'Release ready', chat: { id: -100, type: 'channel', title: 'Deployments' }, photo: [{}] },
  }), {
    id: '-100:8', provider_event_id: '8', occurred_at: '2024-07-14T23:33:20.000Z', conversation_key: '-100', peer_id: '-100', sender_id: '-100', sender_name: 'Deployments', chat_type: 'channel', text: 'Release ready', attachment: { type: 'photo', caption_present: true, downloaded: false },
  })
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

test('GitHub OAuth callback exchanges credentials and verifies the official API', async () => {
  let mcpCalls = 0
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/login/oauth/access_token')) return Response.json({ access_token: 'github-token' })
    if (url === 'https://api.github.com/user') return Response.json({ login: 'octocat' })
    if (url.startsWith('https://api.github.com/repos/octocat/repo/pulls?')) return Response.json([])
    if (url === 'https://api.github.com/repos/octocat/repo') return Response.json({ permissions: { push: true } })
    mcpCalls += 1
    const request = JSON.parse(String(init?.body))
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'github', version: '1' } }
      : { tools: [] }
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  }
  const { app: api, connections: service } = app(new FakeStore(), fetcher, {
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
  const source = (await service.discoverConnectionCapabilities('user-1', connections[0].id))
    .find(({ name }) => name === 'github.ready_pull_requests')!
  mcpCalls = 0
  await service.callRuntimeCapability('user-1', source, { repositories: ['octocat/repo'] }, 'source')
  assert.equal(mcpCalls, 0)
})

test('Gmail OAuth refreshes an expired token before reading the profile', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://oauth2.googleapis.com/token' && calls.length === 1) {
      return Response.json({ access_token: 'expired-token', refresh_token: 'refresh-token', expires_in: 0, scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' })
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
  const authorizationUrl = (await start.json()).authorization_url
  assert.match(authorizationUrl, /gmail.send/)
  const state = new URL(authorizationUrl).searchParams.get('state')!
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

test('Google Calendar OAuth exposes bounded reads and approval-safe event writes', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({
        access_token: 'calendar-token', refresh_token: 'refresh-token', expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      })
    }
    if (url.endsWith('/users/me/calendarList/primary')) return Response.json({ summary: 'Work calendar' })
    if (url.includes('/calendars/primary/events/event-1?')) return Response.json({ id: 'event-1', etag: 'v2' })
    if (url.includes('/calendars/primary/events?')) return Response.json(init?.method === 'POST' ? { id: 'created-event' } : { items: [{ id: 'event-1', etag: 'v1' }] })
    return new Response(null, { status: 404 })
  }
  const { app: api, connections: service } = app(new FakeStore(), fetcher, {
    googleClientId: 'google-id', googleClientSecret: 'google-secret',
  })
  const start = await api.request('/v1/connections/oauth/google_calendar/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Calendar' }),
  })
  const authorizationUrl = (await start.json()).authorization_url
  assert.match(authorizationUrl, /calendar.events/)
  const state = new URL(authorizationUrl).searchParams.get('state')!
  const callback = await api.request(`/v1/connections/oauth/google_calendar/callback?state=${encodeURIComponent(state)}&code=code`)
  assert.equal(callback.headers.get('location'), 'https://example.com/connections?connected=google_calendar')

  const [connection] = (await (await api.request('/v1/connections')).json()).connections
  assert.equal(connection.account_label, 'Work calendar')
  assert.equal((await api.request('/v1/connections/oauth/gmail/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Wrong provider', connection_id: connection.id }),
  })).status, 404)
  const capabilities = await service.discoverConnectionCapabilities('user-1', connection.id)
  const list = capabilities.find(({ name }) => name === 'google_calendar.list_events')!
  const create = capabilities.find(({ name }) => name === 'google_calendar.create_event')!
  const update = capabilities.find(({ name }) => name === 'google_calendar.update_event')!
  await service.callRuntimeCapability('user-1', list, {
    calendar_id: 'primary', time_min: '2026-07-20T00:00:00Z', time_max: '2026-07-21T00:00:00Z',
  }, 'source')
  await assert.rejects(() => service.callRuntimeCapability('user-1', list, {
    calendar_id: 'primary', time_min: '2026-07-21T00:00:00Z', time_max: '2026-07-20T00:00:00Z',
  }, 'source'), /invalid_capability_input/)
  await service.callRuntimeCapability('user-1', create, {
    calendar_id: 'primary', title: 'Design review', start: '2026-07-21T09:00:00Z', end: '2026-07-21T09:30:00Z',
    attendees: ['owner@example.com'],
  }, 'action')
  await service.callRuntimeCapability('user-1', update, {
    calendar_id: 'primary', event_id: 'event-1', etag: '"v1"', title: 'Design review',
    start: '2026-07-21T09:30:00Z', end: '2026-07-21T10:00:00Z', time_zone: 'Asia/Kolkata',
  }, 'action')
  const write = requests.find(({ url, init }) => url.includes('/calendars/primary/events?') && init?.method === 'POST')!
  assert.deepEqual(JSON.parse(String(write.init?.body)), {
    summary: 'Design review', start: { dateTime: '2026-07-21T09:00:00Z' }, end: { dateTime: '2026-07-21T09:30:00Z' },
    attendees: [{ email: 'owner@example.com' }],
  })
  const updateRequest = requests.find(({ url, init }) => url.includes('/events/event-1?') && init?.method === 'PATCH')!
  assert.equal((updateRequest.init?.headers as Record<string, string>)['If-Match'], '"v1"')
})
