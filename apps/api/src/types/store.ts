import type { GithubPrPresentation } from './github.js'

export type PairingSession = { id: string; expiresAt: string }
export type PairingStatus = 'pending' | 'paired' | 'revoked'

export type Pod = {
  id: string
  name: string
  paired_at: string
  last_seen_at: string | null
  revoked_at: string | null
  screen_layout: ScreenLayout
  screen_layout_revision: number
  online?: boolean
}

export type ScreenDirection = 'left' | 'right' | 'down'
export type ScreenLayout = Record<ScreenDirection, string[]>
export type ScreenItem = {
  id: string
  name: string
  provider: ConnectionProvider | 'codex'
  status: 'ready' | 'disconnected' | 'attention'
  detail: string
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
  action_payload?: { kind: string; [key: string]: unknown }
  presentation?: GithubPrPresentation
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

export type ConnectionProvider = 'github' | 'gmail' | 'google_calendar' | 'vercel' | 'telegram' | 'linear' | 'stripe' | 'notion' | 'custom_mcp'
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

export type OAuthProvider = 'github' | 'gmail' | 'google_calendar' | 'notion'

export type OAuthState = {
  ownerId: string
  provider: OAuthProvider
  connectionName: string
  connectionId: string | null
  codeVerifier: string
}

export type AiProvider = 'openai' | 'cerebras' | 'openrouter' | 'anthropic' | 'custom'

export type AiSettings = {
  provider: AiProvider
  base_url: string
  model: string
  personalization_enabled: boolean
  updated_at: string
}

export type StoredAiSettings = AiSettings & { encrypted_api_key: string }

export type CodexBridge = {
  id: string
  name: string
  version: string | null
  last_error: string | null
  paired_at: string
  last_seen_at: string | null
  online?: boolean
}

export type CodexWorkspace = {
  id: string
  bridge_id: string
  local_id: string
  label: string
  available: boolean
  updated_at: string
}

export type CodexThread = {
  id: string
  workspace_id: string
  codex_thread_id: string
  title: string
  status: 'idle' | 'planning' | 'waiting' | 'implementing' | 'testing' | 'completed' | 'error'
  milestone: string
  final_summary: string
  last_error: string | null
  updated_at: string
}

export type CodexTarget = {
  workspace_id: string
  thread_id: string | null
  revision: number
  updated_at: string
}

export type CodexCommand = {
  id: string
  workspace_id: string
  thread_id: string | null
  interaction_id: string | null
  kind: 'prompt' | 'decision' | 'new_thread'
  payload: Record<string, unknown>
  idempotency_key: string
}

export type AgentMemory = {
  id: string
  owner_id: string
  scope: 'user' | 'workspace' | 'provider'
  scope_id: string | null
  provider: ConnectionProvider | null
  memory_key: string
  content: string
  source: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type CapabilitySafety = 'verified_read' | 'verified_write' | 'unannotated'
export type CapabilityRole = 'source' | 'context' | 'action' | 'setup'
export type CapabilityDelivery = 'poll' | 'event'
export type CapabilityEffect = 'read' | 'write' | 'destructive' | 'unannotated'

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
  output_schema: Record<string, unknown>
  schema_hash: string
  safety: CapabilitySafety
  roles: CapabilityRole[]
  delivery: CapabilityDelivery
  effect: CapabilityEffect
  runtime_safe: boolean
  callable_during_setup: boolean
}

export type JsonPointerBinding = {
  from: 'event' | 'decision'
  pointer: string
}

export type BoundArguments = Record<string, unknown | JsonPointerBinding>

export type RuleContextBindingDraft = {
  connection_id: string
  capability_id: string
  capability_name: string
  capability_schema_hash: string
  arguments: BoundArguments
}

export type RuleActionDraft = RuleContextBindingDraft

export type RuleDefinitionV2 = {
  schema_version: 2
  source: {
    connection_id: string
    capability_id: string
    capability_name: string
    capability_schema_hash: string
    delivery: CapabilityDelivery
    arguments: Record<string, unknown>
    result: {
      collection_pointer: string
      identity_pointers: string[]
      occurred_at_pointer: string | null
      conversation_pointer: string | null
      sample_validated: boolean
    }
  }
  scope: string
  match: { instructions: string }
  context: RuleContextBindingDraft[]
  action: RuleActionDraft | null
  cadence: { seconds: number }
  approval: {
    required: true
    expires_in_minutes: 5 | 15 | 30 | 60
    destination: { type: 'pod'; pod_id: string }
  }
  assumptions: string[]
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
  context_bindings?: RuleContextBindingDraft[]
  action?: RuleActionDraft | null
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
  schema_version: 1 | 2
  status?: 'active' | 'paused' | 'needs_attention'
  action_connection_id?: string | null
  action_capability_id?: string | null
  action_capability_name?: string | null
  action_capability_schema_hash?: string | null
  action_capability_safety?: 'verified_write' | null
  activated_at?: string | null
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
  runtime?: {
    baseline_completed: boolean
    next_run_at: string
    consecutive_failures: number
    schema_drift: boolean
    last_error: string | null
    last_run_at: string | null
    last_event_at: string | null
  } | null
}

export type RuleActivity = {
  events: Array<{
    id: string
    status: string
    occurred_at: string
    resolved_at: string | null
    last_error: string | null
  }>
  runs: Array<{
    id: string
    stage: string
    outcome: string
    error_code: string | null
    error_message: string | null
    duration_ms: number | null
    created_at: string
  }>
  next_cursor: string | null
}

export type TelegramAuthSession = {
  id: string
  status: 'pending_qr' | 'waiting_2fa' | 'connected' | 'failed' | 'cancelled' | 'expired'
  connection_name: string
  encrypted_qr_payload: string | null
  qr_expires_at: string | null
  password_hint: string | null
  encrypted_password: string | null
  connection_id: string | null
  last_error: string | null
  expires_at: string
  lease_token?: string | null
}

export type RuntimeRule = PingRule & {
  owner_id: string
  definition: RuleDefinitionV2
  source: StoredConnection
  contexts: RuleContextBindingDraft[]
  runtime: {
    cursor: Record<string, unknown>
    baseline_completed: boolean
    next_run_at: string
    consecutive_failures: number
    schema_drift: boolean
  }
}

export type RuntimeEvent = {
  id: string
  owner_id: string
  rule_id: string
  event_identity: string
  conversation_key: string | null
  provider_event_id: string | null
  occurred_at: string
  status: string
  encrypted_source_payload: string | null
  encrypted_draft_payload: string | null
  encrypted_action_payload: string | null
  action_payload_hash: string | null
  approval_request_id: string | null
  delivery_idempotency_key: string
  telegram_random_id: string | null
  attempts: number
}

export type EditableReply = {
  event: RuntimeEvent
  payloadHash: string
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
  authenticatePod(podId: string, tokenHash: string): Promise<{ id: string; ownerId: string; screenLayout: ScreenLayout } | null>
  touchPod(podId: string): Promise<boolean>
  listPods(ownerId: string): Promise<Pod[]>
  updatePodScreenLayout(ownerId: string, podId: string, expectedRevision: number, layout: ScreenLayout): Promise<Pod>
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
    result: {
      status: 'connected' | 'failed'
      accountLabel: string | null
      error: string | null
      encryptedPayload?: string
    },
  ): Promise<Connection | null>
  deleteConnection(ownerId: string, connectionId: string): Promise<boolean>
  createOAuthState(stateHash: string, state: OAuthState, expiresAt: string): Promise<void>
  consumeOAuthState(stateHash: string, provider: OAuthProvider): Promise<OAuthState | null>
  getAiSettings(ownerId: string): Promise<StoredAiSettings | null>
  setPersonalization(ownerId: string, enabled: boolean): Promise<boolean>
  saveAiSettings(
    ownerId: string,
    settings: Pick<StoredAiSettings, 'provider' | 'base_url' | 'model' | 'encrypted_api_key'>,
  ): Promise<StoredAiSettings>
  createCodexPairing(input: { bridgeId: string; codeHash: string; tokenHash: string }): Promise<PairingSession>
  getCodexPairingStatus(sessionId: string, bridgeId: string, tokenHash: string): Promise<PairingStatus | null>
  claimCodexBridge(codeHash: string, ownerId: string, name: string): Promise<CodexBridge>
  authenticateCodexBridge(bridgeId: string, tokenHash: string): Promise<{ id: string; ownerId: string } | null>
  listCodex(ownerId: string): Promise<{ bridges: CodexBridge[]; workspaces: CodexWorkspace[]; threads: CodexThread[]; target: CodexTarget | null }>
  revokeCodexBridge(ownerId: string, bridgeId: string): Promise<boolean>
  syncCodexBridge(input: { bridgeId: string; ownerId: string; version: string; processInstanceId: string; error: string | null; workspaces: Array<{ localId: string; label: string }>; threads: Array<{ workspaceLocalId: string; codexThreadId: string; title: string; status: CodexThread['status']; milestone: string; finalSummary: string; error: string | null }> }): Promise<{ workspaces: CodexWorkspace[]; threads: CodexThread[] }>
  setCodexTarget(ownerId: string, workspaceId: string, threadId: string | null, expectedRevision: number | null): Promise<CodexTarget | null>
  queueCodexCommand(input: { ownerId: string; workspaceId: string; threadId: string | null; kind: 'prompt' | 'new_thread'; payload: Record<string, unknown>; idempotencyKey: string; targetRevision?: number | null }): Promise<CodexCommand>
  reviseCodexPlan(input: { ownerId: string; podId: string; requestId: string; payloadHash: string; decisionIdempotencyKey: string; promptIdempotencyKey: string; targetRevision: number; prompt: string }): Promise<CodexCommand>
  createCodexInteraction(input: { ownerId: string; bridgeId: string; workspaceId: string; threadId: string | null; processInstanceId: string; protocolRequestId: string; kind: 'command_approval' | 'file_change_approval' | 'permission_approval' | 'plan_review'; encryptedPayload: string; payloadHash: string; title: string; summary: string; risk: 'low' | 'medium' | 'high'; expiresAt: string }): Promise<ApprovalRequest>
  claimCodexCommand(bridgeId: string, processInstanceId: string): Promise<CodexCommand | null>
  acknowledgeCodexCommand(bridgeId: string, processInstanceId: string, commandId: string, result: { ok: boolean; error?: string }): Promise<boolean>
  codexStatus(ownerId: string): Promise<{ target: CodexTarget | null; thread: CodexThread | null }>
  codexInteractionPayload(ownerId: string, requestId: string): Promise<string | null>
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
  listAgentMemories(ownerId: string, scopes?: Array<{ scope: AgentMemory['scope']; scopeId?: string; provider?: ConnectionProvider }>, query?: string, limit?: number): Promise<AgentMemory[]>
  upsertAgentMemory(input: { ownerId: string; scope: AgentMemory['scope']; scopeId?: string; provider?: ConnectionProvider; memoryKey: string; content: string; source?: Record<string, unknown> }): Promise<AgentMemory>
  deleteAgentMemory(ownerId: string, memoryId: string): Promise<boolean>
}

export interface RuntimeStore {
  updateRuleStatus(ownerId: string, ruleId: string, expectedRevision: number, status: 'active' | 'paused'): Promise<PingRule>
  listRuleActivity(ownerId: string, ruleId: string, cursor?: string): Promise<RuleActivity | null>
  pingEventPresentation(ownerId: string, eventId: string): Promise<{ encryptedDraft: string; actionHash: string } | null>
  createTelegramAuthSession(ownerId: string, name: string): Promise<TelegramAuthSession>
  getTelegramAuthSession(ownerId: string, sessionId: string): Promise<TelegramAuthSession | null>
  submitTelegramAuthPassword(ownerId: string, sessionId: string, encryptedPassword: string): Promise<boolean>
  cancelTelegramAuthSession(ownerId: string, sessionId: string): Promise<boolean>
  claimTelegramAuthSession(workerId: string): Promise<{ sessionId: string; ownerId: string; leaseToken: string } | null>
  getClaimedTelegramAuthSession(sessionId: string, leaseToken: string): Promise<TelegramAuthSession | null>
  updateTelegramAuthSession(sessionId: string, leaseToken: string, changes: Partial<Pick<TelegramAuthSession, 'status' | 'encrypted_qr_payload' | 'qr_expires_at' | 'password_hint' | 'encrypted_password' | 'last_error'>>): Promise<boolean>
  completeTelegramAuthSession(sessionId: string, leaseToken: string, encryptedSecret: string, accountLabel: string): Promise<Connection>
  listActiveTelegramConnections(): Promise<Array<{ ownerId: string; connectionId: string }>>
  claimConnectionLease(ownerId: string, connectionId: string, workerId: string): Promise<string | null>
  recordConnectionHealth(ownerId: string, connectionId: string, success: boolean, error?: string): Promise<number>
  listActiveRulesForConnection(ownerId: string, connectionId: string): Promise<RuntimeRule[]>
  claimDueRule(workerId: string): Promise<{ ruleId: string; ownerId: string; leaseToken: string } | null>
  getRuntimeRule(ownerId: string, ruleId: string): Promise<RuntimeRule | null>
  completeRuleRun(input: { ruleId: string; leaseToken: string; success: boolean; nextRunAt: string; cursor: Record<string, unknown>; baselineCompleted: boolean; schemaDrift: boolean; error?: string; lastEventAt?: string }): Promise<boolean>
  enqueueRuleEvent(input: { ownerId: string; ruleId: string; identity: string; conversationKey?: string; providerEventId?: string; occurredAt: string; encryptedSource: string; telegramRandomId?: string }): Promise<{ eventId: string; inserted: boolean }>
  claimRuleEvent(): Promise<{ eventId: string; ownerId: string; ruleId: string; leaseToken: string } | null>
  getRuntimeEvent(ownerId: string, eventId: string): Promise<RuntimeEvent | null>
  listConversationEvents(ownerId: string, ruleId: string, conversationKey: string, limit: number): Promise<RuntimeEvent[]>
  getEditableReply(ownerId: string, requestId: string): Promise<EditableReply | null>
  reviseReply(input: { ownerId: string; requestId: string; expectedHash: string; newHash: string; encryptedDraft: string; encryptedAction: string; memoryContent: string; memorySource: Record<string, unknown> }): Promise<ApprovalRequest>
  ignoreRuleEvent(eventId: string, leaseToken: string, reason: string): Promise<boolean>
  failRuleEvent(eventId: string, leaseToken: string, error: string, ambiguous?: boolean): Promise<boolean>
  prepareRuleApproval(input: { eventId: string; leaseToken: string; encryptedDraft: string; encryptedAction: string; actionHash: string; title: string; source: string; summary: string; details: string; affectedContext: string; risk: 'low' | 'medium' | 'high'; warnings: string[]; expiresAt: string }): Promise<ApprovalRequest>
  claimApprovedAction(): Promise<{ eventId: string; ownerId: string; ruleId: string; leaseToken: string } | null>
  completeAction(eventId: string, leaseToken: string, result: { delivered: boolean; retryable?: boolean; ambiguous?: boolean; superseded?: boolean; error?: string }): Promise<boolean>
  recordRuleRun(input: { ownerId: string; ruleId: string; eventId?: string; stage: string; outcome: string; errorCode?: string; errorMessage?: string; durationMs?: number }): Promise<void>
  purgeRuntimeData(): Promise<void>
}
