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
  type OAuthProvider,
  type PairingSession,
  type PairingStatus,
  type PingRule,
  type PingRuleSummary,
  type Pod,
  type ScreenLayout,
  type RuleBuilderSession,
  type RuleDraft,
  type RuleActivity,
  type RuntimeEvent,
  type RuntimeRule,
  type RuntimeStore,
  type TelegramAuthSession,
  type Capability,
  type CodexBridge,
  type CodexCommand,
  type CodexTarget,
  type CodexThread,
  type CodexWorkspace,
  type AgentMemory,
  type Store,
} from './types/store.js'
import { StoreError } from './store.js'
import { LocalGoogleCalendarStore } from './local-google-calendar.js'
import { LocalPodLayoutStore } from './local-pod-layout.js'

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
  const code = error?.message.match(/(pairing_rate_limited|invalid_pairing_code|invalid_bridge_pairing_code|active_pod_exists|pod_not_authorized|pod_not_found|pod_layout_conflict|invalid_pod_layout|request_not_found|request_already_resolved|request_expired|reply_not_editable|invalid_reply_revision|payload_changed|idempotency_conflict|codex_bridge_not_authorized|codex_target_not_found|codex_target_changed|rule_session_not_found|rule_session_expired|rule_session_conflict|rule_pod_unavailable|rule_connection_unavailable|rule_not_found|rule_edit_conflict|rule_review_required|invalid_rule_status|invalid_rule_definition|ping_event_conflict|invalid_ping_approval|telegram_auth_in_progress|telegram_auth_conflict)/)?.[1]
  throw new StoreError(code ?? 'database_error', error?.message)
}

function equalHash(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function missingPodLayoutSchema(error: { code?: string; message: string } | null) {
  return error?.code === '42703' || error?.code === '42883' || error?.code === 'PGRST202'
}

function missingMemorySchema(error: { code?: string; message: string } | null) {
  return error?.code === '42P01' || error?.code === 'PGRST205'
}

export class SupabaseStore implements Store, RuntimeStore {
  private readonly db: SupabaseClient
  private readonly localGoogleCalendar?: LocalGoogleCalendarStore
  private readonly localPodLayouts?: LocalPodLayoutStore

  constructor(url: string, secretKey: string, localPodLayoutPath?: string) {
    this.db = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    if (localPodLayoutPath) {
      this.localGoogleCalendar = new LocalGoogleCalendarStore(localPodLayoutPath)
      this.localPodLayouts = new LocalPodLayoutStore(localPodLayoutPath)
    }
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
    const pod = (Array.isArray(data) ? data[0] : data) as Pod
    if (pod.screen_layout) return pod
    const local = this.localPodLayouts?.get(pod.id)
    if (!local) throw new StoreError('database_migration_required')
    return { ...pod, screen_layout: local.layout, screen_layout_revision: local.revision }
  }

  async authenticatePod(podId: string, tokenHash: string) {
    const response = await this.db
      .from('pods')
      .select('id, owner_id, last_seen_at, token_hash, screen_layout')
      .eq('id', podId)
      .is('revoked_at', null)
      .maybeSingle()
    let data = response.data as { id: string; owner_id: string; last_seen_at: string | null; token_hash: string; screen_layout?: ScreenLayout } | null
    let error = response.error
    if (missingPodLayoutSchema(error) && this.localPodLayouts) {
      const legacy = await this.db
        .from('pods')
        .select('id, owner_id, last_seen_at, token_hash')
        .eq('id', podId)
        .is('revoked_at', null)
        .maybeSingle()
      data = legacy.data
      error = legacy.error
    }
    if (error) fail(error)
    if (!data || !equalHash(data.token_hash, tokenHash)) return null

    const staleBefore = new Date(Date.now() - 30_000).toISOString()
    if (!data.last_seen_at || data.last_seen_at < staleBefore) {
      const { error: seenError } = await this.db.from('pods').update({ last_seen_at: new Date().toISOString() }).eq('id', podId)
      if (seenError) fail(seenError)
    }
    const screenLayout = data.screen_layout ?? this.localPodLayouts!.get(data.id).layout
    return { id: data.id, ownerId: data.owner_id, screenLayout }
  }

  async touchPod(podId: string) {
    const { data, error } = await this.db.from('pods')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', podId).is('revoked_at', null).select('id')
    if (error) fail(error)
    return Boolean(data?.length)
  }

  async listPods(ownerId: string): Promise<Pod[]> {
    const response = await this.db
      .from('pods')
      .select('id, name, paired_at, last_seen_at, revoked_at, screen_layout, screen_layout_revision')
      .eq('owner_id', ownerId)
      .is('revoked_at', null)
    type PodRow = Omit<Pod, 'screen_layout' | 'screen_layout_revision' | 'online'> & Partial<Pick<Pod, 'screen_layout' | 'screen_layout_revision'>>
    let data = response.data as PodRow[] | null
    let error = response.error
    if (missingPodLayoutSchema(error) && this.localPodLayouts) {
      const legacy = await this.db
        .from('pods')
        .select('id, name, paired_at, last_seen_at, revoked_at')
        .eq('owner_id', ownerId)
        .is('revoked_at', null)
      data = legacy.data
      error = legacy.error
    }
    if (error) fail(error)
    const onlineAfter = Date.now() - 45_000
    return (data ?? []).map((pod) => {
      const local = pod.screen_layout ? null : this.localPodLayouts!.get(pod.id)
      return {
        ...pod,
        screen_layout: pod.screen_layout ?? local!.layout,
        screen_layout_revision: pod.screen_layout_revision ?? local!.revision,
        online: Boolean(pod.last_seen_at && new Date(pod.last_seen_at).getTime() >= onlineAfter),
      }
    })
  }

  async updatePodScreenLayout(ownerId: string, podId: string, expectedRevision: number, layout: ScreenLayout): Promise<Pod> {
    const { data, error } = await this.db.rpc('update_pod_screen_layout', {
      p_owner_id: ownerId,
      p_pod_id: podId,
      p_expected_revision: expectedRevision,
      p_layout: layout,
    })
    if (missingPodLayoutSchema(error) && this.localPodLayouts) {
      const { data: pod, error: podError } = await this.db.from('pods')
        .select('id, name, paired_at, last_seen_at, revoked_at')
        .eq('id', podId).eq('owner_id', ownerId).is('revoked_at', null).maybeSingle()
      if (podError) fail(podError)
      if (!pod) throw new StoreError('pod_not_found')
      // ponytail: local development fallback cannot transact with hosted Pod ownership; production requires the Supabase migration.
      const saved = this.localPodLayouts.update(podId, expectedRevision, layout)
      return { ...pod, screen_layout: saved.layout, screen_layout_revision: saved.revision } as Pod
    }
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as Pod
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
    const { error: expiryError } = await this.db.rpc('expire_approval_requests')
    if (expiryError) fail(expiryError)

    const [{ data, error }, { count, error: countError }] = await Promise.all([
      this.db
        .from('approval_requests')
        .select('*')
        .eq('owner_id', ownerId)
        .eq('status', 'pending')
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
    const { error } = await this.db.rpc('expire_approval_requests')
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
    return [...data as Connection[], ...(this.localGoogleCalendar?.list(ownerId) ?? [])]
  }

  async getConnection(ownerId: string, connectionId: string) {
    const local = this.localGoogleCalendar?.get(ownerId, connectionId)
    if (local) return local
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
    if (connection.provider === 'google_calendar' && this.localGoogleCalendar) {
      return this.localGoogleCalendar.create(ownerId, connection, encryptedPayload)
    }
    const { data, error } = await this.db.rpc('create_connection_with_secret', {
      p_owner_id: ownerId,
      p_name: connection.name,
      p_provider: connection.provider,
      p_protocol: connection.protocol,
      p_endpoint_url: connection.endpoint_url,
      p_auth_type: connection.auth_type,
      p_encrypted_payload: encryptedPayload,
    })
    const created = Array.isArray(data) ? data[0] : data
    if (error || !created) fail(error)
    return created as Connection
  }

  async updateConnection(
    ownerId: string,
    connectionId: string,
    changes: Partial<Pick<Connection, 'name' | 'endpoint_url' | 'auth_type'>>,
    encryptedPayload?: string,
  ) {
    if (this.localGoogleCalendar?.get(ownerId, connectionId)) {
      return this.localGoogleCalendar.update(ownerId, connectionId, changes.name, encryptedPayload)
    }
    const { data, error } = await this.db.rpc('update_connection_with_secret', {
      p_owner_id: ownerId,
      p_connection_id: connectionId,
      p_name: changes.name ?? null,
      p_endpoint_url: changes.endpoint_url ?? null,
      p_auth_type: changes.auth_type ?? null,
      p_encrypted_payload: encryptedPayload ?? null,
    })
    if (error) fail(error)
    return ((Array.isArray(data) ? data[0] : data) as Connection | null | undefined) ?? null
  }

  async updateConnectionSecret(connectionId: string, encryptedPayload: string) {
    if (this.localGoogleCalendar?.has(connectionId)) {
      this.localGoogleCalendar.updateSecret(connectionId, encryptedPayload)
      return
    }
    const { error } = await this.db
      .from('connection_secrets')
      .update({ encrypted_payload: encryptedPayload, updated_at: new Date().toISOString() })
      .eq('connection_id', connectionId)
    if (error) fail(error)
  }

  async setConnectionTest(
    ownerId: string,
    connectionId: string,
    result: {
      status: 'connected' | 'failed'
      accountLabel: string | null
      error: string | null
      encryptedPayload?: string
    },
  ) {
    if (this.localGoogleCalendar?.get(ownerId, connectionId)) {
      return this.localGoogleCalendar.setTest(ownerId, connectionId, result)
    }
    const { data, error } = await this.db.rpc('set_connection_test_result', {
      p_owner_id: ownerId,
      p_connection_id: connectionId,
      p_status: result.status,
      p_account_label: result.accountLabel,
      p_last_error: result.error,
      p_encrypted_payload: result.encryptedPayload ?? null,
    })
    if (error) fail(error)
    return ((Array.isArray(data) ? data[0] : data) as Connection | null | undefined) ?? null
  }

  async deleteConnection(ownerId: string, connectionId: string) {
    if (this.localGoogleCalendar?.get(ownerId, connectionId)) {
      return this.localGoogleCalendar.delete(ownerId, connectionId)
    }
    const { data, error } = await this.db.rpc('delete_connection_with_layout_cleanup', {
      p_owner_id: ownerId,
      p_connection_id: connectionId,
    })
    if (missingPodLayoutSchema(error)) {
      const legacy = await this.db.from('connections').delete().eq('id', connectionId).eq('owner_id', ownerId).select('id')
      if (legacy.error) fail(legacy.error)
      return Boolean(legacy.data?.length)
    }
    if (error) fail(error)
    return Boolean(data)
  }

  async createOAuthState(stateHash: string, state: OAuthState, expiresAt: string) {
    if (state.provider === 'google_calendar' && this.localGoogleCalendar) {
      this.localGoogleCalendar.createOAuthState(stateHash, state, expiresAt)
      return
    }
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

  async consumeOAuthState(stateHash: string, provider: OAuthProvider) {
    if (provider === 'google_calendar' && this.localGoogleCalendar) {
      return this.localGoogleCalendar.consumeOAuthState(stateHash)
    }
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
      .select('provider, base_url, model, encrypted_api_key, personalization_enabled, updated_at')
      .eq('owner_id', ownerId)
      .maybeSingle()
    if (error) fail(error)
    return data as StoredAiSettings | null
  }

  async setPersonalization(ownerId: string, enabled: boolean) {
    const { data, error } = await this.db.from('ai_settings')
      .update({ personalization_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('owner_id', ownerId).select('owner_id').maybeSingle()
    if (error) fail(error)
    return Boolean(data)
  }

  async saveAiSettings(
    ownerId: string,
    settings: Pick<StoredAiSettings, 'provider' | 'base_url' | 'model' | 'encrypted_api_key'>,
  ) {
    const { data, error } = await this.db
      .from('ai_settings')
      .upsert({ owner_id: ownerId, ...settings, updated_at: new Date().toISOString() })
      .select('provider, base_url, model, encrypted_api_key, personalization_enabled, updated_at')
      .single()
    if (error || !data) fail(error)
    return data as StoredAiSettings
  }

  async createCodexPairing(input: { bridgeId: string; codeHash: string; tokenHash: string }) {
    const { data, error } = await this.db.from('codex_bridge_pairing_sessions').insert({
      bridge_id: input.bridgeId,
      code_hash: input.codeHash,
      token_hash: input.tokenHash,
    }).select('id, expires_at').single()
    if (error || !data) fail(error)
    return { id: data.id, expiresAt: data.expires_at }
  }

  async getCodexPairingStatus(sessionId: string, bridgeId: string, tokenHash: string) {
    const { data: session, error } = await this.db.from('codex_bridge_pairing_sessions')
      .select('claimed_at, expires_at, token_hash').eq('id', sessionId).eq('bridge_id', bridgeId).maybeSingle()
    if (error) fail(error)
    if (!session || !equalHash(session.token_hash, tokenHash) || session.expires_at <= new Date().toISOString()) return null
    if (!session.claimed_at) return 'pending' as const
    const identity = await this.authenticateCodexBridge(bridgeId, tokenHash)
    return identity ? 'paired' as const : 'revoked' as const
  }

  async claimCodexBridge(codeHash: string, ownerId: string, name: string) {
    const { data, error } = await this.db.rpc('claim_codex_bridge', {
      p_code_hash: codeHash, p_owner_id: ownerId, p_name: name,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as CodexBridge
  }

  async authenticateCodexBridge(bridgeId: string, tokenHash: string) {
    const { data, error } = await this.db.from('codex_bridges')
      .select('id, owner_id, token_hash, last_seen_at').eq('id', bridgeId).is('revoked_at', null).maybeSingle()
    if (error) fail(error)
    if (!data || !equalHash(data.token_hash, tokenHash)) return null
    if (!data.last_seen_at || data.last_seen_at < new Date(Date.now() - 30_000).toISOString()) {
      const { error: seenError } = await this.db.from('codex_bridges').update({ last_seen_at: new Date().toISOString() }).eq('id', bridgeId)
      if (seenError) fail(seenError)
    }
    return { id: data.id, ownerId: data.owner_id }
  }

  async listCodex(ownerId: string) {
    const { data: bridges, error } = await this.db.from('codex_bridges')
      .select('id, name, version, last_error, paired_at, last_seen_at').eq('owner_id', ownerId).is('revoked_at', null).order('paired_at')
    if (error) fail(error)
    const bridgeIds = bridges.map(({ id }) => id)
    const { data: workspaces, error: workspaceError } = bridgeIds.length
      ? await this.db.from('codex_workspaces').select('id, bridge_id, local_id, label, available, updated_at').in('bridge_id', bridgeIds).order('label')
      : { data: [], error: null }
    if (workspaceError) fail(workspaceError)
    const workspaceIds = workspaces.map(({ id }) => id)
    const { data: threads, error: threadError } = workspaceIds.length
      ? await this.db.from('codex_threads').select('id, workspace_id, codex_thread_id, title, status, milestone, final_summary, last_error, updated_at').in('workspace_id', workspaceIds).order('updated_at', { ascending: false })
      : { data: [], error: null }
    if (threadError) fail(threadError)
    const { data: target, error: targetError } = await this.db.from('codex_targets')
      .select('workspace_id, thread_id, revision, updated_at').eq('owner_id', ownerId).maybeSingle()
    if (targetError) fail(targetError)
    const onlineAfter = Date.now() - 45_000
    return {
      bridges: bridges.map((bridge) => ({ ...bridge, online: Boolean(bridge.last_seen_at && new Date(bridge.last_seen_at).getTime() >= onlineAfter) })) as CodexBridge[],
      workspaces: workspaces as CodexWorkspace[], threads: threads as CodexThread[], target: target as CodexTarget | null,
    }
  }

  async revokeCodexBridge(ownerId: string, bridgeId: string) {
    const { data, error } = await this.db.rpc('revoke_codex_bridge', {
      p_owner_id: ownerId,
      p_bridge_id: bridgeId,
    })
    if (error) fail(error)
    return data === true
  }

  async syncCodexBridge(input: {
    bridgeId: string; ownerId: string; version: string; processInstanceId: string; error: string | null
    workspaces: Array<{ localId: string; label: string }>
    threads: Array<{ workspaceLocalId: string; codexThreadId: string; title: string; status: CodexThread['status']; milestone: string; finalSummary: string; error: string | null }>
  }) {
    const { data, error } = await this.db.rpc('sync_codex_bridge', {
      p_owner_id: input.ownerId,
      p_bridge_id: input.bridgeId,
      p_version: input.version,
      p_process_instance_id: input.processInstanceId,
      p_error: input.error,
      p_workspaces: input.workspaces.map(({ localId, label }) => ({ local_id: localId, label })),
      p_threads: input.threads.map((thread) => ({
        workspace_local_id: thread.workspaceLocalId,
        codex_thread_id: thread.codexThreadId,
        title: thread.title,
        status: thread.status,
        milestone: thread.milestone,
        final_summary: thread.finalSummary,
        last_error: thread.error,
      })),
    })
    if (error || !data) fail(error)
    return data as { workspaces: CodexWorkspace[]; threads: CodexThread[] }
  }

  async setCodexTarget(ownerId: string, workspaceId: string, threadId: string | null, expectedRevision: number | null) {
    const { data, error } = await this.db.rpc('set_codex_target', {
      p_owner_id: ownerId,
      p_workspace_id: workspaceId,
      p_thread_id: threadId,
      p_expected_revision: expectedRevision,
    })
    if (error) fail(error)
    return (Array.isArray(data) ? data[0] : data) as CodexTarget | null
  }

  async queueCodexCommand(input: { ownerId: string; workspaceId: string; threadId: string | null; kind: 'prompt' | 'new_thread'; payload: Record<string, unknown>; idempotencyKey: string; targetRevision?: number | null }) {
    const { data, error } = await this.db.rpc('queue_codex_command', {
      p_owner_id: input.ownerId,
      p_workspace_id: input.workspaceId,
      p_thread_id: input.threadId,
      p_kind: input.kind,
      p_payload: input.payload,
      p_idempotency_key: input.idempotencyKey,
      p_target_revision: input.targetRevision ?? null,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as CodexCommand
  }

  async reviseCodexPlan(input: { ownerId: string; podId: string; requestId: string; payloadHash: string; decisionIdempotencyKey: string; promptIdempotencyKey: string; targetRevision: number; prompt: string }) {
    const { data, error } = await this.db.rpc('revise_codex_plan', {
      p_owner_id: input.ownerId,
      p_pod_id: input.podId,
      p_request_id: input.requestId,
      p_payload_hash: input.payloadHash,
      p_decision_idempotency_key: input.decisionIdempotencyKey,
      p_prompt_idempotency_key: input.promptIdempotencyKey,
      p_target_revision: input.targetRevision,
      p_prompt: input.prompt,
    })
    if (error) fail(error)
    if (!data) throw new StoreError('request_expired')
    return (Array.isArray(data) ? data[0] : data) as CodexCommand
  }

  async createCodexInteraction(input: {
    ownerId: string; bridgeId: string; workspaceId: string; threadId: string | null; processInstanceId: string
    protocolRequestId: string; kind: 'command_approval' | 'file_change_approval' | 'permission_approval' | 'plan_review'
    encryptedPayload: string; payloadHash: string; title: string; summary: string; risk: 'low' | 'medium' | 'high'; expiresAt: string
  }) {
    const { data, error } = await this.db.rpc('create_codex_interaction', {
      p_owner_id: input.ownerId, p_bridge_id: input.bridgeId, p_workspace_id: input.workspaceId,
      p_thread_id: input.threadId, p_process_instance_id: input.processInstanceId,
      p_protocol_request_id: input.protocolRequestId, p_kind: input.kind,
      p_encrypted_payload: input.encryptedPayload, p_payload_hash: input.payloadHash,
      p_title: input.title, p_summary: input.summary, p_risk: input.risk, p_expires_at: input.expiresAt,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as ApprovalRequest
  }

  async claimCodexCommand(bridgeId: string, processInstanceId: string) {
    const { data, error } = await this.db.rpc('claim_codex_command', {
      p_bridge_id: bridgeId,
      p_process_instance_id: processInstanceId,
    })
    if (error) fail(error)
    return (data?.[0] ?? null) as CodexCommand | null
  }

  async acknowledgeCodexCommand(bridgeId: string, processInstanceId: string, commandId: string, result: { ok: boolean; error?: string }) {
    const { data, error } = await this.db.rpc('acknowledge_codex_command', {
      p_bridge_id: bridgeId,
      p_process_instance_id: processInstanceId,
      p_command_id: commandId,
      p_ok: result.ok,
      p_error: result.error?.slice(0, 500) ?? null,
    })
    if (error) fail(error)
    return data === true
  }

  async codexStatus(ownerId: string) {
    const { data: target, error } = await this.db.from('codex_targets')
      .select('workspace_id, thread_id, revision, updated_at').eq('owner_id', ownerId).maybeSingle()
    if (error) fail(error)
    if (!target?.thread_id) return { target: target as CodexTarget | null, thread: null }
    const { data: workspace, error: workspaceError } = await this.db.from('codex_workspaces')
      .select('available, codex_bridges!inner(owner_id, revoked_at)')
      .eq('id', target.workspace_id).eq('codex_bridges.owner_id', ownerId).is('codex_bridges.revoked_at', null).maybeSingle()
    if (workspaceError) fail(workspaceError)
    if (!workspace?.available) return { target: target as CodexTarget, thread: null }
    const { data: thread, error: threadError } = await this.db.from('codex_threads')
      .select('id, workspace_id, codex_thread_id, title, status, milestone, final_summary, last_error, updated_at').eq('id', target.thread_id).maybeSingle()
    if (threadError) fail(threadError)
    return { target: target as CodexTarget, thread: thread as CodexThread | null }
  }

  async codexInteractionPayload(ownerId: string, requestId: string) {
    const { data, error } = await this.db.from('codex_interactions').select('encrypted_payload')
      .eq('owner_id', ownerId).eq('approval_request_id', requestId).maybeSingle()
    if (error) fail(error)
    return data?.encrypted_payload ?? null
  }

  async getRule(ownerId: string, ruleId: string) {
    const { data, error } = await this.db
      .from('ping_rules')
      .select('id, destination_pod_id, source_connection_id, title, intent_summary, capability_id, capability_name, capability_schema_hash, capability_safety, definition, schema_version, status, action_connection_id, action_capability_id, action_capability_name, action_capability_schema_hash, action_capability_safety, activated_at, revision, created_at, updated_at')
      .eq('id', ruleId)
      .eq('owner_id', ownerId)
      .maybeSingle()
    if (error) fail(error)
    return data as PingRule | null
  }

  async listRules(ownerId: string) {
    const { data, error } = await this.db
      .from('ping_rules')
      .select('id, destination_pod_id, source_connection_id, title, intent_summary, capability_id, capability_name, capability_schema_hash, capability_safety, schema_version, status, action_connection_id, action_capability_id, action_capability_name, action_capability_schema_hash, action_capability_safety, activated_at, revision, created_at, updated_at, connections!ping_rules_owner_id_source_connection_id_fkey(name, provider, account_label, status), pods(name, revoked_at), ping_rule_runtime_states!ping_rule_runtime_states_owner_id_rule_id_fkey(baseline_completed, next_run_at, consecutive_failures, schema_drift, last_error, last_run_at, last_event_at)')
      .eq('owner_id', ownerId)
      .order('updated_at', { ascending: false })
    if (error) fail(error)
    return data.map((row) => {
      const connection = Array.isArray(row.connections) ? row.connections[0] : row.connections
      const pod = Array.isArray(row.pods) ? row.pods[0] : row.pods
      const runtime = Array.isArray(row.ping_rule_runtime_states)
        ? row.ping_rule_runtime_states[0]
        : row.ping_rule_runtime_states
      const { connections: _connections, pods: _pods, ping_rule_runtime_states: _runtime, ...rule } = row
      return {
        ...rule,
        source: connection,
        destination: { name: pod?.name ?? 'Unavailable Pod', available: Boolean(pod && !pod.revoked_at) },
        runtime: runtime ?? null,
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
      context_bindings: editingRule.schema_version === 2
        ? ((editingRule.definition as { context?: RuleDraft['context_bindings'] }).context ?? [])
        : [],
      action: editingRule.schema_version === 2
        ? ((editingRule.definition as { action?: RuleDraft['action'] }).action ?? null)
        : null,
      ready: editingRule.schema_version === 2,
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
    const { data, error } = await this.db.rpc('commit_ping_rule_session_v2', {
      p_owner_id: ownerId,
      p_session_id: sessionId,
      p_expected_revision: expectedRevision,
      p_source_connection_id: draft.source_connection_id,
      p_title: draft.title,
      p_intent_summary: draft.intent_summary,
      p_capability_id: draft.capability_id,
      p_capability_name: draft.capability_name,
      p_capability_schema_hash: draft.capability_schema_hash,
      p_definition: draft.definition,
      p_context_bindings: draft.context_bindings ?? [],
      p_action_connection_id: draft.action?.connection_id ?? null,
      p_action_capability_id: draft.action?.capability_id ?? null,
      p_action_capability_name: draft.action?.capability_name ?? null,
      p_action_capability_schema_hash: draft.action?.capability_schema_hash ?? null,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as PingRule
  }

  async deleteRule(ownerId: string, ruleId: string) {
    const { data, error } = await this.db.rpc('delete_ping_rule', {
      p_owner_id: ownerId,
      p_rule_id: ruleId,
    })
    if (error) fail(error)
    return data === true
  }

  async updateRuleStatus(
    ownerId: string,
    ruleId: string,
    expectedRevision: number,
    status: 'active' | 'paused',
  ) {
    const { data, error } = await this.db.rpc('set_ping_rule_status', {
      p_owner_id: ownerId,
      p_rule_id: ruleId,
      p_expected_revision: expectedRevision,
      p_status: status,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as PingRule
  }

  async listRuleActivity(ownerId: string, ruleId: string, cursor?: string) {
    const rule = await this.getRule(ownerId, ruleId)
    if (!rule) return null

    let before: string | undefined
    if (cursor) {
      try {
        before = Buffer.from(cursor, 'base64url').toString('utf8')
        if (!Number.isFinite(new Date(before).getTime())) before = undefined
      } catch {
        before = undefined
      }
    }
    let eventsQuery = this.db
      .from('ping_rule_events')
      .select('id, status, occurred_at, resolved_at, last_error')
      .eq('owner_id', ownerId)
      .eq('rule_id', ruleId)
      .order('occurred_at', { ascending: false })
      .limit(25)
    let runsQuery = this.db
      .from('ping_rule_runs')
      .select('id, stage, outcome, error_code, error_message, duration_ms, created_at')
      .eq('owner_id', ownerId)
      .eq('rule_id', ruleId)
      .order('created_at', { ascending: false })
      .limit(25)
    if (before) {
      eventsQuery = eventsQuery.lt('occurred_at', before)
      runsQuery = runsQuery.lt('created_at', before)
    }
    const [{ data: events, error: eventsError }, { data: runs, error: runsError }] = await Promise.all([
      eventsQuery,
      runsQuery,
    ])
    if (eventsError || runsError) fail(eventsError ?? runsError)
    const oldest = [...events.map((item) => item.occurred_at), ...runs.map((item) => item.created_at)]
      .sort()[0]
    return {
      events,
      runs,
      next_cursor: events.length === 25 || runs.length === 25
        ? Buffer.from(oldest, 'utf8').toString('base64url')
        : null,
    } as RuleActivity
  }

  async pingEventPresentation(ownerId: string, eventId: string) {
    const { data, error } = await this.db
      .from('ping_rule_events')
      .select('encrypted_draft_payload, action_payload_hash')
      .eq('owner_id', ownerId)
      .eq('id', eventId)
      .maybeSingle()
    if (error) fail(error)
    if (!data?.encrypted_draft_payload || !data.action_payload_hash) return null
    return { encryptedDraft: data.encrypted_draft_payload, actionHash: data.action_payload_hash }
  }

  async createTelegramAuthSession(ownerId: string, name: string) {
    const { data, error } = await this.db.rpc('create_telegram_auth_session', {
      p_owner_id: ownerId,
      p_connection_name: name,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as TelegramAuthSession
  }

  async getTelegramAuthSession(ownerId: string, sessionId: string) {
    const { data, error } = await this.db
      .from('telegram_auth_sessions')
      .select('id, status, connection_name, encrypted_qr_payload, qr_expires_at, password_hint, connection_id, last_error, expires_at')
      .eq('owner_id', ownerId)
      .eq('id', sessionId)
      .maybeSingle()
    if (error) fail(error)
    return data as TelegramAuthSession | null
  }

  async submitTelegramAuthPassword(ownerId: string, sessionId: string, encryptedPassword: string) {
    const { data, error } = await this.db.rpc('submit_telegram_auth_password', {
      p_owner_id: ownerId,
      p_session_id: sessionId,
      p_encrypted_password: encryptedPassword,
    })
    if (error) fail(error)
    return data === true
  }

  async cancelTelegramAuthSession(ownerId: string, sessionId: string) {
    const { data, error } = await this.db.rpc('cancel_telegram_auth_session', {
      p_owner_id: ownerId,
      p_session_id: sessionId,
    })
    if (error) fail(error)
    return data === true
  }

  async claimTelegramAuthSession(workerId: string) {
    const { data, error } = await this.db.rpc('claim_telegram_auth_session', {
      p_worker_id: workerId,
      p_lease_seconds: 90,
    })
    if (error) fail(error)
    const row = data?.[0]
    return row ? { sessionId: row.session_id, ownerId: row.owner_id, leaseToken: row.lease_token } : null
  }

  async getClaimedTelegramAuthSession(sessionId: string, leaseToken: string) {
    const { data, error } = await this.db
      .from('telegram_auth_sessions')
      .select('id, status, connection_name, encrypted_qr_payload, qr_expires_at, password_hint, encrypted_password, connection_id, last_error, expires_at, lease_token')
      .eq('id', sessionId)
      .eq('lease_token', leaseToken)
      .maybeSingle()
    if (error) fail(error)
    return data as TelegramAuthSession | null
  }

  async updateTelegramAuthSession(
    sessionId: string,
    leaseToken: string,
    changes: Partial<Pick<TelegramAuthSession, 'status' | 'encrypted_qr_payload' | 'qr_expires_at' | 'password_hint' | 'encrypted_password' | 'last_error'>>,
  ) {
    const { data, error } = await this.db
      .from('telegram_auth_sessions')
      .update({
        ...changes,
        leased_until: new Date(Date.now() + 90_000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', sessionId)
      .eq('lease_token', leaseToken)
      .select('id')
    if (error) fail(error)
    return Boolean(data?.length)
  }

  async completeTelegramAuthSession(
    sessionId: string,
    leaseToken: string,
    encryptedSecret: string,
    accountLabel: string,
  ) {
    const { data, error } = await this.db.rpc('complete_telegram_auth_session', {
      p_session_id: sessionId,
      p_lease_token: leaseToken,
      p_encrypted_connection_secret: encryptedSecret,
      p_account_label: accountLabel,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as Connection
  }

  async listActiveTelegramConnections() {
    const { data, error } = await this.db
      .from('ping_rules')
      .select('owner_id, source_connection_id, connections!ping_rules_owner_id_source_connection_id_fkey(provider, status)')
      .eq('status', 'active')
    if (error) fail(error)
    const unique = new Map<string, { ownerId: string; connectionId: string }>()
    for (const row of data) {
      const connection = Array.isArray(row.connections) ? row.connections[0] : row.connections
      if (connection?.provider === 'telegram' && connection.status === 'connected') {
        unique.set(row.source_connection_id, { ownerId: row.owner_id, connectionId: row.source_connection_id })
      }
    }
    return [...unique.values()]
  }

  async claimConnectionLease(ownerId: string, connectionId: string, workerId: string) {
    const { data, error } = await this.db.rpc('claim_connection_runtime_lease', {
      p_owner_id: ownerId,
      p_connection_id: connectionId,
      p_worker_id: workerId,
      p_lease_seconds: 60,
    })
    if (error) fail(error)
    return data as string | null
  }

  async recordConnectionHealth(ownerId: string, connectionId: string, success: boolean, errorMessage?: string) {
    const { data, error } = await this.db.rpc('record_ping_connection_health', {
      p_owner_id: ownerId,
      p_connection_id: connectionId,
      p_success: success,
      p_error: errorMessage ?? null,
    })
    if (error) fail(error)
    return Number(data ?? 0)
  }

  async listActiveRulesForConnection(ownerId: string, connectionId: string) {
    const { data, error } = await this.db
      .from('ping_rules')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('source_connection_id', connectionId)
      .eq('status', 'active')
      .eq('schema_version', 2)
    if (error) fail(error)
    const rules = await Promise.all(data.map((row) => this.getRuntimeRule(ownerId, row.id)))
    return rules.filter((rule): rule is RuntimeRule => rule !== null)
  }

  async claimDueRule(workerId: string) {
    const { data, error } = await this.db.rpc('claim_due_ping_rule', {
      p_worker_id: workerId,
      p_lease_seconds: 60,
    })
    if (error) fail(error)
    const row = data?.[0]
    return row ? { ruleId: row.rule_id, ownerId: row.owner_id, leaseToken: row.lease_token } : null
  }

  async getRuntimeRule(ownerId: string, ruleId: string) {
    const { data, error } = await this.db
      .from('ping_rules')
      .select('*, ping_rule_context_bindings(connection_id, capability_id, capability_name, capability_schema_hash, arguments, position), ping_rule_runtime_states!ping_rule_runtime_states_owner_id_rule_id_fkey(cursor, baseline_completed, next_run_at, consecutive_failures, schema_drift)')
      .eq('owner_id', ownerId)
      .eq('id', ruleId)
      .eq('schema_version', 2)
      .maybeSingle()
    if (error) fail(error)
    if (!data) return null
    const source = await this.getConnection(ownerId, data.source_connection_id)
    if (!source) return null
    const contexts = [...(data.ping_rule_context_bindings ?? [])]
      .sort((left, right) => left.position - right.position)
      .map(({ position: _position, ...binding }) => binding)
    const runtime = Array.isArray(data.ping_rule_runtime_states)
      ? data.ping_rule_runtime_states[0]
      : data.ping_rule_runtime_states
    const { ping_rule_context_bindings: _bindings, ping_rule_runtime_states: _runtime, ...rule } = data
    return { ...rule, source, contexts, runtime } as RuntimeRule
  }

  async completeRuleRun(input: {
    ruleId: string
    leaseToken: string
    success: boolean
    nextRunAt: string
    cursor: Record<string, unknown>
    baselineCompleted: boolean
    schemaDrift: boolean
    error?: string
    lastEventAt?: string
  }) {
    const { data, error } = await this.db.rpc('complete_ping_rule_run', {
      p_rule_id: input.ruleId,
      p_lease_token: input.leaseToken,
      p_success: input.success,
      p_next_run_at: input.nextRunAt,
      p_cursor: input.cursor,
      p_baseline_completed: input.baselineCompleted,
      p_schema_drift: input.schemaDrift,
      p_last_error: input.error ?? null,
      p_last_event_at: input.lastEventAt ?? null,
    })
    if (error) fail(error)
    return data === true
  }

  async enqueueRuleEvent(input: {
    ownerId: string
    ruleId: string
    identity: string
    conversationKey?: string
    providerEventId?: string
    occurredAt: string
    encryptedSource: string
    telegramRandomId?: string
  }) {
    const { data, error } = await this.db.rpc('enqueue_ping_rule_event', {
      p_owner_id: input.ownerId,
      p_rule_id: input.ruleId,
      p_event_identity: input.identity,
      p_conversation_key: input.conversationKey ?? null,
      p_provider_event_id: input.providerEventId ?? null,
      p_occurred_at: input.occurredAt,
      p_encrypted_source_payload: input.encryptedSource,
      p_telegram_random_id: input.telegramRandomId ?? null,
    })
    if (error || !data?.[0]) fail(error)
    return { eventId: data[0].event_id, inserted: data[0].inserted }
  }

  async claimRuleEvent() {
    const { data, error } = await this.db.rpc('claim_ping_rule_event', { p_lease_seconds: 120 })
    if (error) fail(error)
    const row = data?.[0]
    return row ? { eventId: row.event_id, ownerId: row.owner_id, ruleId: row.rule_id, leaseToken: row.lease_token } : null
  }

  async getRuntimeEvent(ownerId: string, eventId: string) {
    const { data, error } = await this.db
      .from('ping_rule_events')
      .select('id, owner_id, rule_id, event_identity, conversation_key, provider_event_id, occurred_at, status, encrypted_source_payload, encrypted_draft_payload, encrypted_action_payload, action_payload_hash, approval_request_id, delivery_idempotency_key, telegram_random_id, attempts')
      .eq('owner_id', ownerId)
      .eq('id', eventId)
      .maybeSingle()
    if (error) fail(error)
    return data as RuntimeEvent | null
  }

  async listConversationEvents(ownerId: string, ruleId: string, conversationKey: string, limit: number) {
    const { data, error } = await this.db
      .from('ping_rule_events')
      .select('id, owner_id, rule_id, event_identity, conversation_key, provider_event_id, occurred_at, status, encrypted_source_payload, encrypted_draft_payload, encrypted_action_payload, action_payload_hash, approval_request_id, delivery_idempotency_key, telegram_random_id, attempts')
      .eq('owner_id', ownerId)
      .eq('rule_id', ruleId)
      .eq('conversation_key', conversationKey)
      .not('status', 'in', '(detected,evaluating)')
      .not('encrypted_source_payload', 'is', null)
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(Math.max(1, Math.min(limit, 20)))
    if (error) fail(error)
    return (data ?? []) as RuntimeEvent[]
  }

  async getEditableReply(ownerId: string, requestId: string) {
    const { data, error } = await this.db.from('ping_rule_events')
      .select('id, owner_id, rule_id, event_identity, conversation_key, provider_event_id, occurred_at, status, encrypted_source_payload, encrypted_draft_payload, encrypted_action_payload, action_payload_hash, approval_request_id, delivery_idempotency_key, telegram_random_id, attempts, approval_requests!inner(status, payload_hash)')
      .eq('owner_id', ownerId).eq('approval_request_id', requestId).maybeSingle()
    if (error) fail(error)
    const request = Array.isArray(data?.approval_requests) ? data.approval_requests[0] : data?.approval_requests
    if (!data || data.status !== 'pending_approval' || request?.status !== 'pending' || !request.payload_hash) return null
    const { approval_requests: _request, ...event } = data
    return { event: event as RuntimeEvent, payloadHash: request.payload_hash }
  }

  async reviseReply(input: { ownerId: string; requestId: string; expectedHash: string; newHash: string; encryptedDraft: string; encryptedAction: string; memoryContent: string; memorySource: Record<string, unknown> }) {
    const { data, error } = await this.db.rpc('revise_ping_rule_reply', {
      p_owner_id: input.ownerId,
      p_request_id: input.requestId,
      p_expected_hash: input.expectedHash,
      p_new_hash: input.newHash,
      p_encrypted_draft_payload: input.encryptedDraft,
      p_encrypted_action_payload: input.encryptedAction,
      p_memory_content: input.memoryContent,
      p_memory_source: input.memorySource,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as ApprovalRequest
  }

  async ignoreRuleEvent(eventId: string, leaseToken: string, reason: string) {
    const { data, error } = await this.db.rpc('ignore_ping_rule_event', {
      p_event_id: eventId,
      p_lease_token: leaseToken,
      p_reason: reason,
    })
    if (error) fail(error)
    return data === true
  }

  async failRuleEvent(eventId: string, leaseToken: string, errorMessage: string, ambiguous = false) {
    const { data, error } = await this.db.rpc('fail_ping_rule_event', {
      p_event_id: eventId,
      p_lease_token: leaseToken,
      p_error: errorMessage,
      p_ambiguous: ambiguous,
    })
    if (error) fail(error)
    return data === true
  }

  async prepareRuleApproval(input: {
    eventId: string
    leaseToken: string
    encryptedDraft: string
    encryptedAction: string
    actionHash: string
    title: string
    source: string
    summary: string
    details: string
    affectedContext: string
    risk: 'low' | 'medium' | 'high'
    warnings: string[]
    expiresAt: string
  }) {
    const { data, error } = await this.db.rpc('prepare_ping_rule_approval', {
      p_event_id: input.eventId,
      p_lease_token: input.leaseToken,
      p_encrypted_draft_payload: input.encryptedDraft,
      p_encrypted_action_payload: input.encryptedAction,
      p_action_payload_hash: input.actionHash,
      p_title: input.title,
      p_source: input.source,
      p_summary: input.summary,
      p_details: input.details,
      p_affected_context: input.affectedContext,
      p_risk: input.risk,
      p_warnings: input.warnings,
      p_expires_at: input.expiresAt,
    })
    if (error || !data) fail(error)
    return (Array.isArray(data) ? data[0] : data) as ApprovalRequest
  }

  async claimApprovedAction() {
    const { data, error } = await this.db.rpc('claim_approved_ping_action', { p_lease_seconds: 120 })
    if (error) fail(error)
    const row = data?.[0]
    return row ? { eventId: row.event_id, ownerId: row.owner_id, ruleId: row.rule_id, leaseToken: row.lease_token } : null
  }

  async completeAction(
    eventId: string,
    leaseToken: string,
    result: { delivered: boolean; retryable?: boolean; ambiguous?: boolean; superseded?: boolean; error?: string },
  ) {
    const { data, error } = await this.db.rpc('complete_ping_action', {
      p_event_id: eventId,
      p_lease_token: leaseToken,
      p_delivered: result.delivered,
      p_retryable: result.retryable ?? false,
      p_ambiguous: result.ambiguous ?? false,
      p_superseded: result.superseded ?? false,
      p_error: result.error ?? null,
    })
    if (error) fail(error)
    return data === true
  }

  async recordRuleRun(input: {
    ownerId: string
    ruleId: string
    eventId?: string
    stage: string
    outcome: string
    errorCode?: string
    errorMessage?: string
    durationMs?: number
  }) {
    const { error } = await this.db.from('ping_rule_runs').insert({
      owner_id: input.ownerId,
      rule_id: input.ruleId,
      event_id: input.eventId ?? null,
      stage: input.stage,
      outcome: input.outcome,
      error_code: input.errorCode?.slice(0, 100) ?? null,
      error_message: input.errorMessage?.slice(0, 500) ?? null,
      duration_ms: input.durationMs ?? null,
    })
    if (error) fail(error)
  }

  async listAgentMemories(ownerId: string, scopes: Array<{ scope: AgentMemory['scope']; scopeId?: string; provider?: AgentMemory['provider'] }> = [], query?: string, limit = 12) {
    // ponytail: scan 100 recent rows; add SQL full-text search if memory volume grows.
    const { data, error } = await this.db
      .from('agent_memories')
      .select('id, owner_id, scope, scope_id, provider, memory_key, content, source, created_at, updated_at')
      .eq('owner_id', ownerId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .limit(Math.min(Math.max(limit * 4, 12), 100))
    if (missingMemorySchema(error)) return []
    if (error) fail(error)
    const normalized = (data as AgentMemory[]).filter((row) => {
      const inScope = !scopes.length || scopes.some((scope) =>
        scope.scope === row.scope &&
        (scope.scopeId ?? '') === (row.scope_id ?? '') &&
        (scope.provider ?? '') === (row.provider ?? '')
      )
      return inScope && (!query || `${row.memory_key} ${row.content}`.toLowerCase().includes(query.toLowerCase()))
    }).slice(0, Math.min(Math.max(limit, 1), 50))
    return normalized.map((row) => ({ ...row, scope_id: row.scope_id || null, provider: row.provider || null }))
  }

  async upsertAgentMemory(input: { ownerId: string; scope: AgentMemory['scope']; scopeId?: string; provider?: AgentMemory['provider']; memoryKey: string; content: string; source?: Record<string, unknown> }) {
    const { data, error } = await this.db.from('agent_memories').upsert({
      owner_id: input.ownerId,
      scope: input.scope,
      scope_id: input.scopeId ?? '',
      provider: input.provider ?? '',
      memory_key: input.memoryKey,
      content: input.content,
      source: input.source ?? {},
      updated_at: new Date().toISOString(),
      deleted_at: null,
    }, { onConflict: 'owner_id,scope,scope_id,provider,memory_key' }).select('id, owner_id, scope, scope_id, provider, memory_key, content, source, created_at, updated_at').single()
    if (error || !data) fail(error)
    return { ...(data as AgentMemory), scope_id: data.scope_id || null, provider: data.provider || null }
  }

  async deleteAgentMemory(ownerId: string, memoryId: string) {
    const { data, error } = await this.db.from('agent_memories').update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', memoryId).eq('owner_id', ownerId).is('deleted_at', null).select('id').maybeSingle()
    if (error) fail(error)
    return Boolean(data)
  }

  async purgeRuntimeData() {
    const { error } = await this.db.rpc('purge_ping_runtime_data')
    if (error) fail(error)
  }
}
