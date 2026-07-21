import assert from 'node:assert/strict'
import test from 'node:test'

import { gmailNotificationPresentation, gmailReviewPresentation, RuntimeEngine, pointerValue, resolveArguments } from './runtime-engine.js'
import type { RuntimeRule, RuntimeStore, Store } from './types/store.js'

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
  contexts: [],
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
  assert.throws(() => resolveArguments({ missing: { from: 'event', pointer: '/none' } }, event, {}), /could not be resolved/)
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
  })
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
