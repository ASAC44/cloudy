import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'node:crypto'

import {
  type AutomationKey,
  type ApprovalRequest,
  type Connection,
  type StoredAiSettings,
  type NewRequest,
  type NewConnection,
  type OAuthState,
  type PairingSession,
  type PairingStatus,
  type PingRule,
  type PingRuleSummary,
  type Pod,
  type RuleBuilderSession,
  type RuleDraft,
  type Capability,
  type Store,
  StoreError,
} from './store.js'

function fail(error: { code?: string; message: string } | null): never {
  if (error?.code === '23503' && error.message.includes('ping_rules')) {
    throw new StoreError('connection_in_use', error.message)
  }
  if (error?.code === '23505' && error.message.includes('connections_owner_name')) {
    throw new StoreError('connection_name_exists', error.message)
  }
  if (error?.code === '23505' && error.message.includes('automation_keys_active_owner_name')) {
    throw new StoreError('automation_key_name_exists', error.message)
  }
  if (error?.code === '23505') throw new StoreError('active_pod_exists', error.message)
  const code = error?.message.match(/(pairing_rate_limited|invalid_pairing_code|active_pod_exists|pod_not_authorized|request_not_found|request_already_resolved|request_expired|payload_changed|idempotency_conflict|rule_session_not_found|rule_session_expired|rule_session_conflict|rule_pod_unavailable|rule_connection_unavailable|rule_not_found|rule_edit_conflict)/)?.[1]
  throw new StoreError(code ?? 'database_error', error?.message)
}

function equalHash(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class SupabaseStore implements Store {
  private readonly db: SupabaseClient

  constructor(url: string, secretKey: string) {
    this.db = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  async createPairingSession(input: {
    podId: string
    codeHash: string
    tokenHash: string
    sourceIpHash: string
  }): Promise<PairingSession> {
    const { data, error } = await this.db.rpc('create_pod_pairing_session', {
      p_pod_id: input.podId,
      p_code_hash: input.codeHash,
      p_token_hash: input.tokenHash,
      p_source_ip_hash: input.sourceIpHash,
    })
    if (error || !data?.[0]) fail(error)
    return { id: data[0].id, expiresAt: data[0].expires_at }
  }

  async getPairingStatus(
    sessionId: string,
    podId: string,
    tokenHash: string,
  ): Promise<PairingStatus | null> {
    const { data: session, error } = await this.db
      .from('pod_pairing_sessions')
      .select('claimed_at, expires_at, token_hash')
      .eq('id', sessionId)
      .eq('pod_id', podId)
      .maybeSingle()
    if (error) fail(error)
    if (!session || !equalHash(session.token_hash, tokenHash) || new Date(session.expires_at) <= new Date()) return null
    if (!session.claimed_at) return 'pending'

    const { data: pod, error: podError } = await this.db
      .from('pods')
      .select('revoked_at, token_hash')
      .eq('id', podId)
      .maybeSingle()
    if (podError) fail(podError)
    if (!pod || !equalHash(pod.token_hash, tokenHash)) return null
    return pod.revoked_at ? 'revoked' : 'paired'
  }

  async claimPairing(codeHash: string, ownerId: string, name: string): Promise<Pod> {
    const { data, error } = await this.db.rpc('claim_pod_pairing', {
      p_code_hash: codeHash,
      p_owner_id: ownerId,
      p_name: name,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as Pod
  }

  async authenticatePod(podId: string, tokenHash: string) {
    const { data, error } = await this.db
      .from('pods')
      .select('id, owner_id, last_seen_at, token_hash')
      .eq('id', podId)
      .is('revoked_at', null)
      .maybeSingle()
    if (error) fail(error)
    if (!data || !equalHash(data.token_hash, tokenHash)) return null

    const staleBefore = new Date(Date.now() - 30_000).toISOString()
    if (!data.last_seen_at || data.last_seen_at < staleBefore) {
      const { error: seenError } = await this.db.from('pods').update({ last_seen_at: new Date().toISOString() }).eq('id', podId)
      if (seenError) fail(seenError)
    }
    return { id: data.id, ownerId: data.owner_id }
  }

  async listPods(ownerId: string): Promise<Pod[]> {
    const { data, error } = await this.db
      .from('pods')
      .select('id, name, paired_at, last_seen_at, revoked_at')
      .eq('owner_id', ownerId)
      .is('revoked_at', null)
    if (error) fail(error)
    const onlineAfter = Date.now() - 45_000
    return data.map((pod) => ({
      ...pod,
      online: Boolean(pod.last_seen_at && new Date(pod.last_seen_at).getTime() >= onlineAfter),
    })) as Pod[]
  }

  async revokePod(ownerId: string, podId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('pods')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', podId)
      .eq('owner_id', ownerId)
      .is('revoked_at', null)
      .select('id')
    if (error) fail(error)
    return Boolean(data?.length)
  }

  async createRequest(ownerId: string, request: NewRequest, payloadHash: string): Promise<ApprovalRequest> {
    const { data, error } = await this.db
      .from('approval_requests')
      .insert({ ...request, owner_id: ownerId, payload_hash: payloadHash })
      .select()
      .single()
    if (error) fail(error)
    return data as ApprovalRequest
  }

  async listRequests(ownerId: string, status?: string): Promise<ApprovalRequest[]> {
    let query = this.db
      .from('approval_requests')
      .select('*, approval_decisions(outcome, decided_at)')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false })
      .limit(100)
    if (status) query = query.eq('status', status)
    const { data, error } = await query
    if (error) fail(error)
    return data as ApprovalRequest[]
  }

  async currentRequest(ownerId: string) {
    const now = new Date().toISOString()
    const { error: expiryError } = await this.db
      .from('approval_requests')
      .update({ status: 'expired' })
      .eq('owner_id', ownerId)
      .eq('status', 'pending')
      .lte('expires_at', now)
    if (expiryError) fail(expiryError)

    const [{ data, error }, { count, error: countError }] = await Promise.all([
      this.db
        .from('approval_requests')
        .select('*')
        .eq('owner_id', ownerId)
        .eq('status', 'pending')
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      this.db
        .from('approval_requests')
        .select('id', { count: 'exact', head: true })
        .eq('owner_id', ownerId)
        .eq('status', 'pending'),
    ])
    if (error || countError) fail(error ?? countError)
    return { request: data as ApprovalRequest | null, queueSize: count ?? 0 }
  }

  async decideRequest(input: {
    ownerId: string
    podId: string
    requestId: string
    outcome: 'approved' | 'rejected'
    payloadHash: string
    idempotencyKey: string
  }) {
    const { data, error } = await this.db.rpc('decide_approval', {
      p_owner_id: input.ownerId,
      p_pod_id: input.podId,
      p_request_id: input.requestId,
      p_outcome: input.outcome,
      p_payload_hash: input.payloadHash,
      p_idempotency_key: input.idempotencyKey,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as { outcome: string; decided_at: string }
  }

  async listAutomationKeys(ownerId: string) {
    const { data, error } = await this.db
      .from('automation_keys')
      .select('id, name, prefix, created_at, last_used_at, revoked_at')
      .eq('owner_id', ownerId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
    if (error) fail(error)
    return data as AutomationKey[]
  }

  async createAutomationKey(ownerId: string, name: string, prefix: string, tokenHash: string) {
    const { data, error } = await this.db
      .from('automation_keys')
      .insert({ owner_id: ownerId, name, prefix, token_hash: tokenHash })
      .select('id, name, prefix, created_at, last_used_at, revoked_at')
      .single()
    if (error || !data) fail(error)
    return data as AutomationKey
  }

  async revokeAutomationKey(ownerId: string, keyId: string) {
    const { data, error } = await this.db
      .from('automation_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId)
      .eq('owner_id', ownerId)
      .is('revoked_at', null)
      .select('id')
    if (error) fail(error)
    return Boolean(data?.length)
  }

  async authenticateAutomationKey(prefix: string, tokenHash: string) {
    const { data, error } = await this.db
      .from('automation_keys')
      .select('id, owner_id, token_hash')
      .eq('prefix', prefix)
      .is('revoked_at', null)
      .maybeSingle()
    if (error) fail(error)
    if (!data || !equalHash(data.token_hash, tokenHash)) return null
    const { error: usedError } = await this.db
      .from('automation_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
    if (usedError) fail(usedError)
    return { id: data.id, ownerId: data.owner_id }
  }

  async createAutomationRequest(input: {
    ownerId: string
    keyId: string
    externalId: string
    request: NewRequest
    payloadHash: string
    encryptedCallbackUrl: string
  }) {
    const { request } = input
    const { data, error } = await this.db.rpc('create_automation_approval', {
      p_owner_id: input.ownerId,
      p_automation_key_id: input.keyId,
      p_external_id: input.externalId,
      p_title: request.title,
      p_source: request.source,
      p_summary: request.summary,
      p_details: request.details,
      p_affected_context: request.affected_context,
      p_risk: request.risk,
      p_warnings: request.warnings,
      p_priority: request.priority,
      p_action_payload: request.action_payload,
      p_payload_hash: input.payloadHash,
      p_expires_at: request.expires_at,
      p_encrypted_callback_url: input.encryptedCallbackUrl,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as ApprovalRequest
  }

  async getAutomationRequest(ownerId: string, requestId: string) {
    const { data, error } = await this.db
      .from('approval_requests')
      .select('*, approval_decisions(outcome, decided_at)')
      .eq('id', requestId)
      .eq('owner_id', ownerId)
      .not('automation_key_id', 'is', null)
      .maybeSingle()
    if (error) fail(error)
    return data as ApprovalRequest | null
  }

  async cancelAutomationRequest(ownerId: string, requestId: string) {
    const { data, error } = await this.db
      .from('approval_requests')
      .update({ status: 'cancelled', decided_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('owner_id', ownerId)
      .eq('status', 'pending')
      .not('automation_key_id', 'is', null)
      .select('id')
    if (error) fail(error)
    return Boolean(data?.length)
  }

  async expireRequests() {
    const { error } = await this.db
      .from('approval_requests')
      .update({ status: 'expired', decided_at: new Date().toISOString() })
      .eq('status', 'pending')
      .lte('expires_at', new Date().toISOString())
    if (error) fail(error)
  }

  async claimCallback() {
    const { data, error } = await this.db.rpc('claim_approval_callback')
    if (error) fail(error)
    const delivery = data?.[0]
    return delivery ? {
      id: delivery.id,
      requestId: delivery.request_id,
      encryptedUrl: delivery.encrypted_url,
      attempt: delivery.attempt,
      status: delivery.request_status,
      decidedAt: delivery.decided_at,
    } : null
  }

  async completeCallback(
    id: string,
    result: { delivered: boolean; error?: string; nextAttemptAt?: string | null },
  ) {
    const now = new Date().toISOString()
    const { error } = await this.db
      .from('approval_callbacks')
      .update(result.delivered ? {
        status: 'delivered', delivered_at: now, locked_at: null, last_error: null, updated_at: now,
      } : {
        status: 'failed', next_attempt_at: result.nextAttemptAt ?? null, locked_at: null,
        last_error: result.error?.slice(0, 500) ?? 'Callback delivery failed', updated_at: now,
      })
      .eq('id', id)
      .eq('status', 'delivering')
    if (error) fail(error)
  }

  async listConnections(ownerId: string): Promise<Connection[]> {
    const { data, error } = await this.db
      .from('connections')
      .select('id, name, provider, protocol, endpoint_url, auth_type, status, account_label, last_error, last_tested_at, created_at, updated_at')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: true })
    if (error) fail(error)
    return data as Connection[]
  }

  async getConnection(ownerId: string, connectionId: string) {
    const { data: connection, error } = await this.db
      .from('connections')
      .select('id, name, provider, protocol, endpoint_url, auth_type, status, account_label, last_error, last_tested_at, created_at, updated_at')
      .eq('id', connectionId)
      .eq('owner_id', ownerId)
      .maybeSingle()
    if (error) fail(error)
    if (!connection) return null

    const { data: secret, error: secretError } = await this.db
      .from('connection_secrets')
      .select('encrypted_payload')
      .eq('connection_id', connectionId)
      .single()
    if (secretError) fail(secretError)
    return { ...connection, encrypted_payload: secret.encrypted_payload } as Connection & { encrypted_payload: string }
  }

  async createConnection(ownerId: string, connection: NewConnection, encryptedPayload: string) {
    const { data, error } = await this.db
      .from('connections')
      .insert({ ...connection, owner_id: ownerId })
      .select('id, name, provider, protocol, endpoint_url, auth_type, status, account_label, last_error, last_tested_at, created_at, updated_at')
      .single()
    if (error || !data) fail(error)

    const { error: secretError } = await this.db
      .from('connection_secrets')
      .insert({ connection_id: data.id, encrypted_payload: encryptedPayload })
    if (secretError) {
      await this.db.from('connections').delete().eq('id', data.id)
      fail(secretError)
    }
    return data as Connection
  }

  async updateConnection(
    ownerId: string,
    connectionId: string,
    changes: Partial<Pick<Connection, 'name' | 'endpoint_url' | 'auth_type'>>,
    encryptedPayload?: string,
  ) {
    const existing = await this.getConnection(ownerId, connectionId)
    if (!existing) return null
    if (encryptedPayload) {
      const { error } = await this.db
        .from('connection_secrets')
        .update({ encrypted_payload: encryptedPayload, updated_at: new Date().toISOString() })
        .eq('connection_id', connectionId)
      if (error) fail(error)
    }
    const { data, error } = await this.db
      .from('connections')
      .update({ ...changes, status: 'untested', account_label: null, last_error: null, updated_at: new Date().toISOString() })
      .eq('id', connectionId)
      .eq('owner_id', ownerId)
      .select('id, name, provider, protocol, endpoint_url, auth_type, status, account_label, last_error, last_tested_at, created_at, updated_at')
      .maybeSingle()
    if (error) fail(error)
    return data as Connection | null
  }

  async updateConnectionSecret(connectionId: string, encryptedPayload: string) {
    const { error } = await this.db
      .from('connection_secrets')
      .update({ encrypted_payload: encryptedPayload, updated_at: new Date().toISOString() })
      .eq('connection_id', connectionId)
    if (error) fail(error)
  }

  async setConnectionTest(
    ownerId: string,
    connectionId: string,
    result: { status: 'connected' | 'failed'; accountLabel: string | null; error: string | null },
  ) {
    const now = new Date().toISOString()
    const { data, error } = await this.db
      .from('connections')
      .update({
        status: result.status,
        account_label: result.accountLabel,
        last_error: result.error,
        last_tested_at: now,
        updated_at: now,
      })
      .eq('id', connectionId)
      .eq('owner_id', ownerId)
      .select('id, name, provider, protocol, endpoint_url, auth_type, status, account_label, last_error, last_tested_at, created_at, updated_at')
      .maybeSingle()
    if (error) fail(error)
    return data as Connection | null
  }

  async deleteConnection(ownerId: string, connectionId: string) {
    const { data, error } = await this.db
      .from('connections')
      .delete()
      .eq('id', connectionId)
      .eq('owner_id', ownerId)
      .select('id')
    if (error) fail(error)
    return Boolean(data?.length)
  }

  async createOAuthState(stateHash: string, state: OAuthState, expiresAt: string) {
    const { error } = await this.db.from('connection_oauth_states').insert({
      state_hash: stateHash,
      owner_id: state.ownerId,
      provider: state.provider,
      connection_name: state.connectionName,
      connection_id: state.connectionId,
      code_verifier: state.codeVerifier,
      expires_at: expiresAt,
    })
    if (error) fail(error)
  }

  async consumeOAuthState(stateHash: string, provider: 'github' | 'gmail') {
    const { data, error } = await this.db
      .from('connection_oauth_states')
      .update({ used_at: new Date().toISOString() })
      .eq('state_hash', stateHash)
      .eq('provider', provider)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .select('owner_id, provider, connection_name, connection_id, code_verifier')
      .maybeSingle()
    if (error) fail(error)
    return data ? {
      ownerId: data.owner_id,
      provider: data.provider,
      connectionName: data.connection_name,
      connectionId: data.connection_id,
      codeVerifier: data.code_verifier,
    } as OAuthState : null
  }

  async getAiSettings(ownerId: string) {
    const { data, error } = await this.db
      .from('ai_settings')
      .select('provider, base_url, model, encrypted_api_key, updated_at')
      .eq('owner_id', ownerId)
      .maybeSingle()
    if (error) fail(error)
    return data as StoredAiSettings | null
  }

  async saveAiSettings(
    ownerId: string,
    settings: Pick<StoredAiSettings, 'provider' | 'base_url' | 'model' | 'encrypted_api_key'>,
  ) {
    const { data, error } = await this.db
      .from('ai_settings')
      .upsert({ owner_id: ownerId, ...settings, updated_at: new Date().toISOString() })
      .select('provider, base_url, model, encrypted_api_key, updated_at')
      .single()
    if (error || !data) fail(error)
    return data as StoredAiSettings
  }

  async getRule(ownerId: string, ruleId: string) {
    const { data, error } = await this.db
      .from('ping_rules')
      .select('id, destination_pod_id, source_connection_id, title, intent_summary, capability_id, capability_name, capability_schema_hash, capability_safety, definition, schema_version, revision, created_at, updated_at')
      .eq('id', ruleId)
      .eq('owner_id', ownerId)
      .maybeSingle()
    if (error) fail(error)
    return data as PingRule | null
  }

  async listRules(ownerId: string) {
    const { data, error } = await this.db
      .from('ping_rules')
      .select('id, destination_pod_id, source_connection_id, title, intent_summary, capability_id, capability_name, capability_schema_hash, capability_safety, schema_version, revision, created_at, updated_at, connections(name, provider, account_label, status), pods(name, revoked_at)')
      .eq('owner_id', ownerId)
      .order('updated_at', { ascending: false })
    if (error) fail(error)
    return data.map((row) => {
      const connection = Array.isArray(row.connections) ? row.connections[0] : row.connections
      const pod = Array.isArray(row.pods) ? row.pods[0] : row.pods
      const { connections: _connections, pods: _pods, ...rule } = row
      return {
        ...rule,
        source: connection,
        destination: { name: pod?.name ?? 'Unavailable Pod', available: Boolean(pod && !pod.revoked_at) },
      }
    }) as PingRuleSummary[]
  }

  async createRuleSession(
    ownerId: string,
    podId: string,
    capabilitySnapshot: Capability[],
    editingRule?: PingRule,
  ) {
    const draft = editingRule ? {
      title: editingRule.title,
      intent_summary: editingRule.intent_summary,
      source_connection_id: editingRule.source_connection_id,
      capability_id: editingRule.capability_id,
      capability_name: editingRule.capability_name,
      capability_schema_hash: editingRule.capability_schema_hash,
      capability_safety: editingRule.capability_safety,
      definition: editingRule.definition,
      ready: true,
    } : {}
    const { data, error } = await this.db
      .from('rule_builder_sessions')
      .insert({
        owner_id: ownerId,
        destination_pod_id: podId,
        editing_rule_id: editingRule?.id ?? null,
        base_rule_revision: editingRule?.revision ?? null,
        capability_snapshot: capabilitySnapshot,
        draft,
      })
      .select('id, destination_pod_id, editing_rule_id, completed_rule_id, base_rule_revision, status, messages, draft, capability_snapshot, last_reply, revision, created_at, updated_at, expires_at')
      .single()
    if (error || !data) fail(error)
    return data as RuleBuilderSession
  }

  async getRuleSession(ownerId: string, sessionId: string) {
    const { data, error } = await this.db
      .from('rule_builder_sessions')
      .select('id, destination_pod_id, editing_rule_id, completed_rule_id, base_rule_revision, status, messages, draft, capability_snapshot, last_reply, revision, created_at, updated_at, expires_at')
      .eq('id', sessionId)
      .eq('owner_id', ownerId)
      .maybeSingle()
    if (error) fail(error)
    return data as RuleBuilderSession | null
  }

  async updateRuleSession(
    ownerId: string,
    sessionId: string,
    expectedRevision: number,
    changes: Pick<RuleBuilderSession, 'messages' | 'draft' | 'capability_snapshot' | 'last_reply'>,
  ) {
    const now = new Date()
    const { data, error } = await this.db
      .from('rule_builder_sessions')
      .update({
        ...changes,
        revision: expectedRevision + 1,
        updated_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
      })
      .eq('id', sessionId)
      .eq('owner_id', ownerId)
      .eq('status', 'open')
      .eq('revision', expectedRevision)
      .gt('expires_at', now.toISOString())
      .select('id, destination_pod_id, editing_rule_id, completed_rule_id, base_rule_revision, status, messages, draft, capability_snapshot, last_reply, revision, created_at, updated_at, expires_at')
      .maybeSingle()
    if (error) fail(error)
    return data as RuleBuilderSession | null
  }

  async commitRuleSession(
    ownerId: string,
    sessionId: string,
    expectedRevision: number,
    draft: RuleDraft,
  ) {
    const { data, error } = await this.db.rpc('commit_ping_rule_session', {
      p_owner_id: ownerId,
      p_session_id: sessionId,
      p_expected_revision: expectedRevision,
      p_source_connection_id: draft.source_connection_id,
      p_title: draft.title,
      p_intent_summary: draft.intent_summary,
      p_capability_id: draft.capability_id,
      p_capability_name: draft.capability_name,
      p_capability_schema_hash: draft.capability_schema_hash,
      p_capability_safety: draft.capability_safety,
      p_definition: draft.definition,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as PingRule
  }

  async deleteRule(ownerId: string, ruleId: string) {
    const { data, error } = await this.db
      .from('ping_rules')
      .delete()
      .eq('id', ruleId)
      .eq('owner_id', ownerId)
      .select('id')
    if (error) fail(error)
    return Boolean(data?.length)
  }
}
