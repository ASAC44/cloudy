import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { availableCalendarSlots, gmailNotificationPresentation, gmailReviewPresentation, learnedCandidateId, makeGithubActionEnvelope, makeLearnedActionEnvelope, RuntimeEngine, pointerValue, resolveArguments, telegramConversationContext } from './runtime-engine.js'
import type { GithubPullRequest } from './types/github.js'
import type { RuntimeEvent, RuntimeRule, RuntimeStore, Store } from './types/store.js'

const rule = (): RuntimeRule => ({
  id: 'rule-1', owner_id: 'owner-1', destination_pod_id: 'pod-1', source_connection_id: 'connection-1',
  title: 'Watch items', intent_summary: 'Watch new items', capability_id: 'capability-1', capability_name: 'List items',
  capability_schema_hash: 'a'.repeat(64), capability_safety: 'verified_read', schema_version: 2, status: 'active',
  action_connection_id: null, action_capability_id: null, action_capability_name: null,
  action_capability_schema_hash: null, action_capability_safety: null, activated_at: new Date(0).toISOString(),
  revision: 1, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  definition: {
    schema_version: 2,
    source: {
      connection_id: 'connection-1', capability_id: 'capability-1', capability_name: 'List items',
      capability_schema_hash: 'a'.repeat(64), delivery: 'poll', arguments: {},
      result: { collection_pointer: '/items', identity_pointers: ['/id'], occurred_at_pointer: '/at', conversation_pointer: null, sample_validated: true },
    },
    scope: 'All items', match: { instructions: 'All new items' }, context: [], action: null,
    cadence: { seconds: 60 }, approval: { required: true, expires_in_minutes: 15, destination: { type: 'pod', pod_id: 'pod-1' } }, assumptions: [],
  },
  source: {
    id: 'connection-1', name: 'Example', provider: 'custom_mcp', protocol: 'mcp', endpoint_url: 'https://example.com/mcp',
    auth_type: 'none', status: 'connected', account_label: null, last_error: null, last_tested_at: null,
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), encrypted_payload: 'encrypted',
  },
  contexts: [], action_candidates: [],
  runtime: { cursor: {}, baseline_completed: false, next_run_at: new Date(0).toISOString(), consecutive_failures: 0, schema_drift: false },
})

test('JSON pointers and immutable bindings support RFC 6901 escaping', () => {
  const event = { 'a/b': { '~key': 'value' }, peer_id: '42' }
  assert.equal(pointerValue(event, '/a~1b/~0key'), 'value')
  assert.deepEqual(resolveArguments({
    peer: { from: 'event', pointer: '/peer_id' },
    text: { from: 'decision', pointer: '/draft' },
    fixed: 'literal',
  }, event, { draft: 'Exact reply' }), { peer: '42', text: 'Exact reply', fixed: 'literal' })
  assert.deepEqual(resolveArguments({ peer_id: { from: 'event', pointer: '/chat/id' } }, event, {}), { peer_id: '42' })
  assert.throws(() => resolveArguments({ missing: { from: 'event', pointer: '/none' } }, event, {}), /could not be resolved/)
})

test('Telegram conversation context is chronological and includes only delivered replies', () => {
  const action = (message: string) => ({
    kind: 'capability' as const, rule_id: 'rule-1', rule_revision: 1, event_identity: 'message-1',
    connection_id: 'connection-1', capability_id: 'send', capability_schema_hash: 'hash', arguments: { message },
  })
  assert.deepEqual(telegramConversationContext([
    { id: '2', occurred_at: '2026-07-21T10:01:00Z', status: 'rejected', source: { sender_name: 'M_M', text: 'Send the final one' }, action: action('Rejected draft') },
    { id: '1', occurred_at: '2026-07-21T10:00:00Z', status: 'delivered', source: { sender_name: 'M_M', text: 'Which report?' }, action: action('The July report?') },
  ]), [
    { direction: 'incoming', text: 'Which report?', sender: 'M_M', occurred_at: '2026-07-21T10:00:00Z' },
    { direction: 'outgoing', text: 'The July report?', occurred_at: '2026-07-21T10:00:00Z' },
    { direction: 'incoming', text: 'Send the final one', sender: 'M_M', occurred_at: '2026-07-21T10:01:00Z' },
  ])
})

test('schedule slots exclude calendar conflicts and return three weekday openings', () => {
  const slots = availableCalendarSlots([
    { items: [{ start: { dateTime: '2026-07-21T09:00:00Z' }, end: { dateTime: '2026-07-21T10:00:00Z' } }] },
  ], {
    relevant: true, duration_minutes: 60, start_date: '2026-07-21', end_date: '2026-07-21', timezone: 'UTC', missing_fields: [],
  }, 'UTC')

  assert.deepEqual(slots.map(({ start, end }) => [start, end]), [
    ['2026-07-21T10:00:00.000Z', '2026-07-21T11:00:00.000Z'],
    ['2026-07-21T10:30:00.000Z', '2026-07-21T11:30:00.000Z'],
    ['2026-07-21T11:00:00.000Z', '2026-07-21T12:00:00.000Z'],
  ])
})

test('polling establishes a baseline, then enqueues only unseen deterministic identities', async () => {
  const runtimeRule = rule()
  const results = [
    { items: [{ id: '1', at: '2026-01-01T00:00:00Z' }, { id: '2', at: '2026-01-02T00:00:00Z' }] },
    { items: [{ id: '2', at: '2026-01-02T00:00:00Z' }, { id: '3', at: '2026-01-03T00:00:00Z' }] },
  ]
  const enqueued: string[] = []
  const store = {
    claimDueRule: async () => ({ ruleId: runtimeRule.id, ownerId: runtimeRule.owner_id, leaseToken: 'lease' }),
    getRuntimeRule: async () => runtimeRule,
    completeRuleRun: async (input: { cursor: Record<string, unknown>; baselineCompleted: boolean }) => {
      runtimeRule.runtime.cursor = input.cursor
      runtimeRule.runtime.baseline_completed = input.baselineCompleted
      return true
    },
    enqueueRuleEvent: async (input: { identity: string }) => { enqueued.push(input.identity); return { eventId: `event-${enqueued.length}`, inserted: true } },
    recordRuleRun: async () => undefined,
  } as unknown as Store & RuntimeStore
  const connections = {
    callRuntimeCapability: async () => results.shift(),
    encryptPrivatePayload: (value: unknown) => JSON.stringify(value),
  }
  const engine = new RuntimeEngine(store, connections as never)

  assert.equal(await engine.pollOnce('worker'), true)
  assert.deepEqual(enqueued, [])
  assert.equal(await engine.pollOnce('worker'), true)
  assert.equal(enqueued.length, 1)
})

test('all-incoming Gmail rules do not ask AI to infer sender metadata from IDs', async () => {
  const runtimeRule = rule()
  runtimeRule.source.provider = 'gmail'
  runtimeRule.title = 'New Gmail'
  runtimeRule.definition.source.arguments = { query: 'in:inbox -from:me', limit: 20 }
  const event = { id: 'message-1', threadId: 'thread-1' }
  let encryptedDraft = ''
  const store = {
    claimRuleEvent: async () => ({ eventId: 'event-1', ownerId: runtimeRule.owner_id, ruleId: runtimeRule.id, leaseToken: 'lease' }),
    getRuntimeRule: async () => runtimeRule,
    getRuntimeEvent: async () => ({ id: 'event-1', event_identity: 'identity', encrypted_source_payload: JSON.stringify(event) }),
    getAiSettings: async () => ({ personalization_enabled: true }),
    listAgentMemories: async () => [],
    prepareRuleApproval: async (input: { encryptedDraft: string }) => { encryptedDraft = input.encryptedDraft },
    recordRuleRun: async () => undefined,
  } as unknown as Store & RuntimeStore
  const engine = new RuntimeEngine(store, {
    decryptPrivatePayload: (value: string) => JSON.parse(value),
    encryptPrivatePayload: (value: unknown) => JSON.stringify(value),
    discoverConnectionCapabilities: async () => [{ name: 'gmail.get_thread', roles: ['context'] }],
    callRuntimeCapability: async () => ({ messages: [{ headers: { from: 'ava@example.com', subject: 'Review', date: 'Today' }, body: 'Complete original email.' }] }),
  } as never)

  assert.equal(await engine.evaluateOnce(), true)
  assert.deepEqual(JSON.parse(encryptedDraft), {
    kind: 'gmail_notification_v1', sender: 'ava@example.com', time: 'Today', subject: 'Review',
    summary: 'A new incoming Gmail message matched this Ping.', email: 'Complete original email.',
    live_context: ['gmail.get_thread'], context_warnings: [],
  })
})

test('optional live context warns while required live context stops drafting', async () => {
  const contextBinding = {
    connection_id: 'status-1', capability_id: 'status-1:mcp:service.status',
    capability_name: 'Check service status', capability_schema_hash: 'c'.repeat(64), arguments: {},
    policy: { required: false, activation: 'always' as const, failure_policy: 'continue_with_warning' as const },
  }
  const runtimeRule = rule()
  runtimeRule.source.provider = 'gmail'
  runtimeRule.definition.source.arguments = { query: 'in:inbox -from:me' }
  runtimeRule.contexts = [contextBinding]
  let presentation: Record<string, unknown> | undefined
  let failed = ''
  const store = {
    claimRuleEvent: async () => ({ eventId: 'event-1', ownerId: runtimeRule.owner_id, ruleId: runtimeRule.id, leaseToken: 'lease' }),
    getRuntimeRule: async () => runtimeRule,
    getRuntimeEvent: async () => ({ id: 'event-1', event_identity: 'identity', encrypted_source_payload: JSON.stringify({ threadId: 'thread-1' }) }),
    listAgentMemories: async () => [],
    prepareRuleApproval: async (input: { encryptedDraft: string }) => { presentation = JSON.parse(input.encryptedDraft); return {} },
    failRuleEvent: async (_id: string, _lease: string, error: string) => { failed = error; return true },
    recordRuleRun: async () => undefined,
  } as unknown as Store & RuntimeStore
  const connections = {
    decryptPrivatePayload: (value: string) => JSON.parse(value),
    encryptPrivatePayload: (value: unknown) => JSON.stringify(value),
    discoverConnectionCapabilities: async () => [],
    callRuntimeCapability: async () => { throw new Error('calendar unavailable') },
  }
  assert.equal(await new RuntimeEngine(store, connections as never).evaluateOnce(), true)
  assert.deepEqual(presentation?.context_warnings, ['Check service status was unavailable; the draft does not use it.'])
  assert.equal(failed, '')

  contextBinding.policy = { required: true, activation: 'always', failure_policy: 'abort' } as never
  presentation = undefined
  assert.equal(await new RuntimeEngine(store, connections as never).evaluateOnce(), true)
  assert.equal(presentation, undefined)
  assert.match(failed, /Required context Check service status failed/)
})

test('learned communication abstains when graph memory is unavailable', async () => {
  const runtimeRule = rule()
  runtimeRule.schema_version = 3
  runtimeRule.source.provider = 'gmail'
  runtimeRule.definition = {
    ...runtimeRule.definition,
    schema_version: 3,
    action: null,
    action_policy: {
      mode: 'learned_communication', recipient_scope: 'event_participants', minimum_confidence: 0.8,
      allowed_actions: [],
    },
  }
  runtimeRule.definition.source.arguments = { query: 'in:inbox -from:me' }
  runtimeRule.action_candidates = [{
    connection_id: 'gmail-1', capability_id: 'gmail-1:rest:gmail.send_reply', capability_name: 'Reply in Gmail',
    capability_schema_hash: 'b'.repeat(64),
    arguments: { thread_id: { from: 'event', pointer: '/threadId' }, message: { from: 'decision', pointer: '/draft' } },
    descriptor: { channel: 'gmail', mode: 'reply', recipient_argument: 'thread_id', body_argument: 'message' },
  }]
  let savedAction: Record<string, unknown> | undefined
  let savedPresentation: Record<string, unknown> | undefined
  const store = {
    claimRuleEvent: async () => ({ eventId: 'event-1', ownerId: runtimeRule.owner_id, ruleId: runtimeRule.id, leaseToken: 'lease' }),
    getRuntimeRule: async () => runtimeRule,
    getRuntimeEvent: async () => ({ id: 'event-1', event_identity: 'identity', encrypted_source_payload: JSON.stringify({ threadId: 'thread-1', from: 'anne@example.com' }) }),
    listAgentMemories: async () => [],
    prepareRuleApproval: async (input: { encryptedAction: string; encryptedDraft: string }) => {
      savedAction = JSON.parse(input.encryptedAction); savedPresentation = JSON.parse(input.encryptedDraft); return {}
    },
    recordRuleRun: async () => undefined,
  } as unknown as Store & RuntimeStore
  const connections = {
    decryptPrivatePayload: (value: string) => JSON.parse(value),
    encryptPrivatePayload: (value: unknown) => JSON.stringify(value),
    discoverConnectionCapabilities: async () => [{
      id: 'gmail-1:rest:gmail.send_reply', connection_id: 'gmail-1', schema_hash: 'b'.repeat(64),
      safety: 'verified_write', effect: 'write', runtime_safe: true, roles: ['action'], name: 'gmail.send_reply',
    }],
  }
  const graph = { retrieve: async () => ({ context: '', graphAvailable: false }) }
  const engine = new RuntimeEngine(store, connections as never, graph as never)
  assert.equal(await engine.evaluateOnce(), true)
  assert.equal(savedAction?.kind, 'none')
  assert.match(String((savedPresentation?.action_selection as Record<string, unknown>).rationale), /abstained/)
})

test('learned communication refuses delivery after a verified identity changes', async () => {
  const runtimeRule = rule()
  runtimeRule.schema_version = 3
  runtimeRule.definition = {
    ...runtimeRule.definition,
    schema_version: 3,
    action: null,
    action_policy: {
      mode: 'learned_communication', recipient_scope: 'explicit_allowlist', minimum_confidence: 0.8,
      allowed_actions: [], allowed_identity_ids: ['identity-1'],
    },
  }
  const binding = {
    connection_id: 'gmail-1', capability_id: 'gmail-1:rest:gmail.send_message', capability_name: 'Send Gmail message',
    capability_schema_hash: 'b'.repeat(64), identity_id: 'identity-1', identity_version: 1,
    arguments: { subject: 'Service update', message: { from: 'decision' as const, pointer: '/draft' as const } },
    descriptor: { channel: 'gmail' as const, mode: 'new_message' as const, recipient_argument: 'to' as const, body_argument: 'message' as const },
  }
  runtimeRule.action_candidates = [binding]
  const candidate = {
    id: learnedCandidateId(runtimeRule, binding), position: 0, binding, recipient: 'anne@example.com', recipientLabel: 'Anne',
    personId: 'person-1', identityId: 'identity-1', identityVersion: 1,
  }
  const event = { id: 'event-1', event_identity: 'event-identity' } as RuntimeEvent
  const action = makeLearnedActionEnvelope(runtimeRule, event, {}, {
    match: true, title: 'Update Anne', summary: 'Send an update', risk: 'low', warnings: [], draft: 'The service is stable.',
  }, candidate)
  const completed: Array<Record<string, unknown>> = []
  let delivered = false
  const store = {
    claimApprovedAction: async () => ({ eventId: event.id, ownerId: runtimeRule.owner_id, ruleId: runtimeRule.id, leaseToken: 'lease' }),
    getRuntimeRule: async () => runtimeRule,
    getRuntimeEvent: async () => ({
      ...event, encrypted_source_payload: JSON.stringify({}), encrypted_action_payload: JSON.stringify(action),
      action_payload_hash: createHash('sha256').update(stableJson(action)).digest('hex'),
    }),
    getMemoryIdentity: async () => ({
      id: 'identity-1', owner_id: runtimeRule.owner_id, person_id: 'person-1', connection_id: 'gmail-1',
      channel: 'gmail', encrypted_identity: JSON.stringify({ address: 'changed@example.com' }), version: 2,
    }),
    completeAction: async (_eventId: string, _lease: string, result: Record<string, unknown>) => { completed.push(result); return true },
    recordRuleRun: async () => undefined,
  } as unknown as Store & RuntimeStore
  const connections = {
    decryptPrivatePayload: (value: string) => JSON.parse(value),
    discoverConnectionCapabilities: async () => [{
      id: binding.capability_id, connection_id: binding.connection_id, schema_hash: binding.capability_schema_hash,
      safety: 'verified_write', effect: 'write', runtime_safe: true, roles: ['action'], name: 'gmail.send_message',
    }],
    callRuntimeCapability: async () => { delivered = true },
  }
  assert.equal(await new RuntimeEngine(store, connections as never).dispatchOnce(), true)
  assert.equal(delivered, false)
  assert.equal(completed[0]?.delivered, false)
  assert.match(String(completed[0]?.error), /capability_changed/)
})

test('reply corrections replace draft-bound arguments and remain encrypted until approval', async () => {
  const runtimeRule = rule()
  runtimeRule.action_connection_id = 'connection-1'
  runtimeRule.action_capability_id = 'send-reply'
  runtimeRule.action_capability_name = 'Send reply'
  runtimeRule.action_capability_schema_hash = 'b'.repeat(64)
  runtimeRule.action_capability_safety = 'verified_write'
  runtimeRule.definition.action = {
    connection_id: 'connection-1', capability_id: 'send-reply', capability_name: 'Send reply',
    capability_schema_hash: 'b'.repeat(64), arguments: { message: { from: 'decision', pointer: '/draft' }, thread_id: 'thread-1' },
  }
  const action = {
    kind: 'capability', rule_id: runtimeRule.id, rule_revision: runtimeRule.revision, event_identity: 'message-1',
    connection_id: 'connection-1', capability_id: 'send-reply', capability_schema_hash: 'b'.repeat(64),
    arguments: { message: 'Old reply', thread_id: 'thread-1' },
  }
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
      : JSON.stringify(value)
  const payloadHash = createHash('sha256').update(canonical(action)).digest('hex')
  let revision: Parameters<RuntimeStore['reviseReply']>[0] | undefined
  const event = {
    id: 'event-1', owner_id: 'owner-1', rule_id: runtimeRule.id, event_identity: 'message-1', status: 'pending_approval',
    encrypted_draft_payload: JSON.stringify({ proposed_reply: 'Old reply' }), encrypted_action_payload: JSON.stringify(action),
    action_payload_hash: payloadHash, approval_request_id: 'request-1',
  }
  const store = {
    getEditableReply: async () => ({ event, payloadHash }),
    getRuntimeRule: async () => runtimeRule,
    reviseReply: async (input: Parameters<RuntimeStore['reviseReply']>[0]) => { revision = input; return {} },
  } as unknown as Store & RuntimeStore
  const engine = new RuntimeEngine(store, {
    decryptPrivatePayload: (value: string) => JSON.parse(value),
    encryptPrivatePayload: (value: unknown) => JSON.stringify(value),
  } as never)

  assert.deepEqual(await engine.editableReply('owner-1', 'request-1'), { reply: 'Old reply', payload_hash: payloadHash })
  const result = await engine.reviseReply('owner-1', 'request-1', payloadHash, 'New reply')
  assert.equal(JSON.parse(revision!.encryptedAction).arguments.message, 'New reply')
  assert.deepEqual(JSON.parse(revision!.encryptedRevision), {
    kind: 'correction', original: 'Old reply', final: 'New reply', request_id: 'request-1',
    rule_id: 'rule-1', provider: 'custom_mcp', connection_id: 'connection-1',
  })
  assert.deepEqual(revision!.revisionSource, { kind: 'correction', request_id: 'request-1', rule_id: 'rule-1' })
  assert.equal(result.payload_hash, revision!.newHash)
})

test('GitHub polling also establishes a baseline without alerting on existing pull requests', async () => {
  const runtimeRule = rule()
  runtimeRule.source.provider = 'github'
  runtimeRule.capability_name = 'Watch merge-ready GitHub pull requests'
  runtimeRule.definition.source.result = {
    collection_pointer: '/items', identity_pointers: ['/event_identity'], occurred_at_pointer: '/updated_at',
    conversation_pointer: '/conversation_key', sample_validated: true,
  }
  const enqueued: string[] = []
  const item = {
    event_identity: `cloudy/api#42@${'a'.repeat(40)}`,
    conversation_key: 'cloudy/api#42',
    updated_at: '2026-07-19T18:00:00Z',
  }
  const store = {
    claimDueRule: async () => ({ ruleId: runtimeRule.id, ownerId: runtimeRule.owner_id, leaseToken: 'lease' }),
    getRuntimeRule: async () => runtimeRule,
    completeRuleRun: async () => true,
    enqueueRuleEvent: async (input: { identity: string }) => { enqueued.push(input.identity); return { eventId: 'event', inserted: true } },
    recordRuleRun: async () => undefined,
  } as unknown as Store & RuntimeStore
  const engine = new RuntimeEngine(store, {
    callRuntimeCapability: async () => ({ items: [item] }),
    encryptPrivatePayload: (value: unknown) => JSON.stringify(value),
  } as never)

  assert.equal(await engine.pollOnce('worker'), true)
  assert.equal(enqueued.length, 0)
})

test('GitHub notification-only rules do not require a merge action', () => {
  const runtimeRule = rule()
  runtimeRule.source.provider = 'github'
  const event = { event_identity: 'podex/api#42@abc' } as RuntimeEvent
  const pull = {
    repository: 'podex/api', number: 42, head_sha: 'a'.repeat(40), merge_method: 'squash',
  } as GithubPullRequest

  assert.deepEqual(makeGithubActionEnvelope(runtimeRule, event, pull), {
    kind: 'none', rule_id: runtimeRule.id, rule_revision: runtimeRule.revision,
    event_identity: event.event_identity, connection_id: null, capability_id: null,
    capability_schema_hash: null, arguments: {},
  })

  runtimeRule.action_connection_id = 'connection-1'
  runtimeRule.action_capability_id = 'merge-pr'
  runtimeRule.action_capability_name = 'Merge a GitHub pull request'
  runtimeRule.action_capability_schema_hash = 'b'.repeat(64)
  runtimeRule.definition.action = {
    connection_id: 'connection-1', capability_id: 'merge-pr', capability_name: 'Merge a GitHub pull request',
    capability_schema_hash: 'b'.repeat(64), arguments: {},
  }
  assert.deepEqual(makeGithubActionEnvelope(runtimeRule, event, pull).arguments, {
    repository: 'podex/api', number: 42, head_sha: 'a'.repeat(40), merge_method: 'squash',
  })
})

test('event delivery ignores history from before activation', async () => {
  const runtimeRule = rule()
  runtimeRule.definition.source.delivery = 'event'
  runtimeRule.definition.source.result.occurred_at_pointer = '/occurred_at'
  runtimeRule.activated_at = '2026-01-02T00:00:00Z'
  let enqueued = false
  const store = {
    enqueueRuleEvent: async () => { enqueued = true; return { eventId: 'event', inserted: true } },
    recordRuleRun: async () => undefined,
  } as unknown as Store & RuntimeStore
  const engine = new RuntimeEngine(store, { encryptPrivatePayload: () => 'encrypted' } as never)
  const accepted = await engine.receiveEvent(runtimeRule, { id: 'old', occurred_at: '2026-01-01T00:00:00Z' })
  assert.equal(accepted, false)
  assert.equal(enqueued, false)
})

test('Stripe writes do not execute before an approved action is claimable', async () => {
  let called = false
  const runtimeRule = rule()
  runtimeRule.source.provider = 'stripe'
  const store = { claimApprovedAction: async () => null } as unknown as Store & RuntimeStore
  const engine = new RuntimeEngine(store, {
    callRuntimeCapability: async () => { called = true },
  } as never)

  assert.equal(await engine.dispatchOnce(), false)
  assert.equal(called, false)
})

test('Gmail approvals expose the complete reviewed email and exact reply', () => {
  const presentation = gmailReviewPresentation(
    { threadId: 'thread-1' },
    [{ messages: [{ headers: { from: 'ava@example.com', subject: 'Review', date: 'Today' }, body: 'Complete original email.' }] }],
    { thread_id: 'thread-1', message: 'Exact approved reply.' },
    { match: true, title: 'Reply', summary: 'A reply is ready.', risk: 'low', warnings: [], draft: 'Exact approved reply.' },
  )
  assert.deepEqual(presentation, {
    kind: 'email_reply_v1', sender: 'ava@example.com', time: 'Today', subject: 'Review', summary: 'A reply is ready.',
    email: 'Complete original email.', response: 'Exact approved reply.',
  })
})

test('Gmail notification presentation exposes the complete email without a reply', () => {
  const presentation = gmailNotificationPresentation(
    { threadId: 'thread-1' },
    [{ messages: [{ headers: { from: 'ava@example.com', subject: 'Review', date: 'Today' }, body: 'Complete original email.' }] }],
    { match: true, title: 'Notify', summary: 'A new email arrived.', risk: 'low', warnings: [], draft: null },
  )
  assert.deepEqual(presentation, {
    kind: 'gmail_notification_v1', sender: 'ava@example.com', time: 'Today', subject: 'Review',
    summary: 'A new email arrived.', email: 'Complete original email.',
  })
})

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}
