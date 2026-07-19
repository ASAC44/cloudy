export type PairingSession = { id: string; expiresAt: string }
export type PairingStatus = 'pending' | 'paired' | 'revoked'

export type Pod = {
  id: string
  name: string
  paired_at: string
  last_seen_at: string | null
  revoked_at: string | null
  online?: boolean
}

export type ApprovalRequest = {
  id: string
  title: string
  source: string
  summary: string
  details: string
  affected_context: string
  risk: 'low' | 'medium' | 'high'
  warnings: string[]
  priority: number
  payload_hash: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'
  created_at: string
  expires_at: string
  decided_at: string | null
  approval_decisions?: Array<{ outcome: string; decided_at: string }>
}

export type NewRequest = Omit<
  ApprovalRequest,
  'id' | 'payload_hash' | 'status' | 'created_at' | 'decided_at'
> & { action_payload: { kind: string; [key: string]: unknown } }

export type AutomationKey = {
  id: string
  name: string
  prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export type AutomationIdentity = { id: string; ownerId: string }

export type CallbackDelivery = {
  id: string
  requestId: string
  encryptedUrl: string
  attempt: number
  status: ApprovalRequest['status']
  decidedAt: string | null
}

export type ConnectionProvider = 'github' | 'gmail' | 'vercel' | 'telegram' | 'custom_mcp'
export type ConnectionStatus = 'untested' | 'connected' | 'failed'

export type Connection = {
  id: string
  name: string
  provider: ConnectionProvider
  protocol: 'mcp' | 'rest'
  endpoint_url: string
  auth_type: 'oauth' | 'bearer' | 'none'
  status: ConnectionStatus
  account_label: string | null
  last_error: string | null
  last_tested_at: string | null
  created_at: string
  updated_at: string
}

export type NewConnection = Pick<
  Connection,
  'name' | 'provider' | 'protocol' | 'endpoint_url' | 'auth_type'
>

export type StoredConnection = Connection & { encrypted_payload: string }

export type OAuthState = {
  ownerId: string
  provider: 'github' | 'gmail'
  connectionName: string
  connectionId: string | null
  codeVerifier: string
}

export type AiProvider = 'openai' | 'cerebras' | 'openrouter' | 'anthropic' | 'custom'

export type AiSettings = {
  provider: AiProvider
  base_url: string
  model: string
  updated_at: string
}

export type StoredAiSettings = AiSettings & { encrypted_api_key: string }

export type CapabilitySafety = 'verified_read' | 'unannotated'

export type Capability = {
  id: string
  connection_id: string
  connection_name: string
  provider: ConnectionProvider
  protocol: 'mcp' | 'rest'
  account_label: string | null
  name: string
  title: string
  description: string
  input_schema: Record<string, unknown>
  schema_hash: string
  safety: CapabilitySafety
  callable_during_setup: boolean
}

export type RuleQuestion = {
  id: string
  prompt: string
  kind: 'single_select' | 'multi_select' | 'text'
  options: Array<{ value: string; label: string; description: string }>
}

export type RuleDraft = {
  title: string
  intent_summary: string
  source_connection_id: string
  capability_id: string
  capability_name: string
  capability_schema_hash: string
  capability_safety: CapabilitySafety
  definition: Record<string, unknown>
  ready: boolean
}

export type RuleBuilderReply = {
  phase: 'needs_input' | 'needs_connection' | 'review' | 'error'
  message: string
  questions: RuleQuestion[]
  connection_requirement: null | {
    provider: ConnectionProvider | 'other'
    label: string
    reason: string
  }
  draft: RuleDraft
}

export type RuleBuilderMessage = { role: 'user' | 'assistant'; content: string }

export type RuleBuilderSession = {
  id: string
  destination_pod_id: string
  editing_rule_id: string | null
  completed_rule_id: string | null
  base_rule_revision: number | null
  status: 'open' | 'completed'
  messages: RuleBuilderMessage[]
  draft: RuleDraft | Record<string, never>
  capability_snapshot: Capability[]
  last_reply: RuleBuilderReply | Record<string, never>
  revision: number
  created_at: string
  updated_at: string
  expires_at: string
}

export type PingRule = {
  id: string
  destination_pod_id: string
  source_connection_id: string
  title: string
  intent_summary: string
  capability_id: string
  capability_name: string
  capability_schema_hash: string
  capability_safety: CapabilitySafety
  definition: Record<string, unknown>
  schema_version: 1
  revision: number
  created_at: string
  updated_at: string
}

export type PingRuleSummary = Omit<PingRule, 'definition'> & {
  source: {
    name: string
    provider: ConnectionProvider
    account_label: string | null
    status: ConnectionStatus
  }
  destination: { name: string; available: boolean }
}

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
  }
}

export interface Store {
  createPairingSession(input: {
    podId: string
    codeHash: string
    tokenHash: string
    sourceIpHash: string
  }): Promise<PairingSession>
  getPairingStatus(
    sessionId: string,
    podId: string,
    tokenHash: string,
  ): Promise<PairingStatus | null>
  claimPairing(codeHash: string, ownerId: string, name: string): Promise<Pod>
  authenticatePod(podId: string, tokenHash: string): Promise<{ id: string; ownerId: string } | null>
  listPods(ownerId: string): Promise<Pod[]>
  revokePod(ownerId: string, podId: string): Promise<boolean>
  createRequest(ownerId: string, request: NewRequest, payloadHash: string): Promise<ApprovalRequest>
  listRequests(ownerId: string, status?: string): Promise<ApprovalRequest[]>
  currentRequest(ownerId: string): Promise<{ request: ApprovalRequest | null; queueSize: number }>
  decideRequest(input: {
    ownerId: string
    podId: string
    requestId: string
    outcome: 'approved' | 'rejected'
    payloadHash: string
    idempotencyKey: string
  }): Promise<{ outcome: string; decided_at: string }>
  listAutomationKeys(ownerId: string): Promise<AutomationKey[]>
  createAutomationKey(ownerId: string, name: string, prefix: string, tokenHash: string): Promise<AutomationKey>
  revokeAutomationKey(ownerId: string, keyId: string): Promise<boolean>
  authenticateAutomationKey(prefix: string, tokenHash: string): Promise<AutomationIdentity | null>
  createAutomationRequest(input: {
    ownerId: string
    keyId: string
    externalId: string
    request: NewRequest
    payloadHash: string
    encryptedCallbackUrl: string
  }): Promise<ApprovalRequest>
  getAutomationRequest(ownerId: string, requestId: string): Promise<ApprovalRequest | null>
  cancelAutomationRequest(ownerId: string, requestId: string): Promise<boolean>
  expireRequests(): Promise<void>
  claimCallback(): Promise<CallbackDelivery | null>
  completeCallback(id: string, result: { delivered: boolean; error?: string; nextAttemptAt?: string | null }): Promise<void>
  listConnections(ownerId: string): Promise<Connection[]>
  getConnection(ownerId: string, connectionId: string): Promise<StoredConnection | null>
  createConnection(
    ownerId: string,
    connection: NewConnection,
    encryptedPayload: string,
  ): Promise<Connection>
  updateConnection(
    ownerId: string,
    connectionId: string,
    changes: Partial<Pick<Connection, 'name' | 'endpoint_url' | 'auth_type'>>,
    encryptedPayload?: string,
  ): Promise<Connection | null>
  updateConnectionSecret(connectionId: string, encryptedPayload: string): Promise<void>
  setConnectionTest(
    ownerId: string,
    connectionId: string,
    result: { status: 'connected' | 'failed'; accountLabel: string | null; error: string | null },
  ): Promise<Connection | null>
  deleteConnection(ownerId: string, connectionId: string): Promise<boolean>
  createOAuthState(stateHash: string, state: OAuthState, expiresAt: string): Promise<void>
  consumeOAuthState(stateHash: string, provider: 'github' | 'gmail'): Promise<OAuthState | null>
  getAiSettings(ownerId: string): Promise<StoredAiSettings | null>
  saveAiSettings(
    ownerId: string,
    settings: Pick<StoredAiSettings, 'provider' | 'base_url' | 'model' | 'encrypted_api_key'>,
  ): Promise<StoredAiSettings>
  getRule(ownerId: string, ruleId: string): Promise<PingRule | null>
  listRules(ownerId: string): Promise<PingRuleSummary[]>
  createRuleSession(
    ownerId: string,
    podId: string,
    capabilitySnapshot: Capability[],
    editingRule?: PingRule,
  ): Promise<RuleBuilderSession>
  getRuleSession(ownerId: string, sessionId: string): Promise<RuleBuilderSession | null>
  updateRuleSession(
    ownerId: string,
    sessionId: string,
    expectedRevision: number,
    changes: Pick<RuleBuilderSession, 'messages' | 'draft' | 'capability_snapshot' | 'last_reply'>,
  ): Promise<RuleBuilderSession | null>
  commitRuleSession(
    ownerId: string,
    sessionId: string,
    expectedRevision: number,
    draft: RuleDraft,
  ): Promise<PingRule>
  deleteRule(ownerId: string, ruleId: string): Promise<boolean>
}
