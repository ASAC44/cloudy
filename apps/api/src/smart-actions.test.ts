import assert from 'node:assert/strict'
import test from 'node:test'

import { makeLearnedActionEnvelope, type LearnedCandidate, validateActionSelection } from './runtime-engine.js'
import { validateReply } from './rule-builder.js'
import type { Capability, RuntimeEvent, RuntimeRule } from './types/store.js'

const source = capability('source', 'vercel.list_projects', 'verified_read', 'read', ['source'], {})
const gmailReply = capability('gmail', 'gmail.send_reply', 'verified_write', 'write', ['action'], {
  thread_id: { type: 'string' }, message: { type: 'string' },
}, ['thread_id', 'message'])
const gmailNew = capability('gmail', 'gmail.send_message', 'verified_write', 'write', ['action'], {
  to: { type: 'string' }, subject: { type: 'string' }, message: { type: 'string' },
}, ['to', 'subject', 'message'])

test('rule validation enriches learned reply candidates with server-owned descriptors', () => {
  const result = validateReply(plannerReply({
    mode: 'learned_communication', recipient_scope: 'event_participants', minimum_confidence: 0.82,
    allowed_actions: [{
      capability_id: gmailReply.id,
      arguments: { thread_id: { from: 'event', pointer: '/threadId' }, message: { from: 'decision', pointer: '/draft' } },
    }],
  }) as never, [source, gmailReply], 'pod-1', {})
  assert.equal(result.draft.ready, true)
  assert.equal((result.draft.definition as Record<string, unknown>).schema_version, 3)
  assert.deepEqual(result.draft.action_policy?.allowed_actions[0].descriptor, {
    channel: 'gmail', mode: 'reply', recipient_argument: 'thread_id', body_argument: 'message',
  })
  assert.equal(result.draft.action, null)
})

test('rule validation rejects invented literal recipients and non-communication writes', () => {
  const invented = validateReply(plannerReply({
    mode: 'learned_communication', recipient_scope: 'explicit_allowlist', minimum_confidence: 0.8,
    allowed_actions: [{
      capability_id: gmailNew.id,
      arguments: { to: 'invented@example.com', subject: 'Update', message: { from: 'decision', pointer: '/draft' } },
    }],
  }) as never, [source, gmailNew], 'pod-1', {})
  assert.equal(invented.draft.ready, false)
  assert.equal(invented.draft.action_policy, null)

  const destructive = capability('stripe', 'stripe.refund', 'verified_write', 'write', ['action'], { id: { type: 'string' } }, ['id'])
  const unsafe = validateReply(plannerReply({
    mode: 'learned_communication', recipient_scope: 'event_participants', minimum_confidence: 0.8,
    allowed_actions: [{ capability_id: destructive.id, arguments: { id: { from: 'event', pointer: '/id' } } }],
  }) as never, [source, destructive], 'pod-1', {})
  assert.equal(unsafe.draft.ready, false)
})

test('rule validation accepts only exact verified identity IDs for new messages', () => {
  const identityId = '11111111-1111-4111-8111-111111111111'
  const result = validateReply(plannerReply({
    mode: 'learned_communication', recipient_scope: 'explicit_allowlist', minimum_confidence: 0.9,
    allowed_actions: [{
      capability_id: gmailNew.id, identity_id: identityId, identity_version: 3,
      arguments: { subject: 'Service update', message: { from: 'decision', pointer: '/draft' } },
    }],
  }) as never, [source, gmailNew], 'pod-1', {}, undefined, [{
    id: identityId, owner_id: 'owner-1', person_id: 'person-1', connection_id: gmailNew.connection_id,
    channel: 'gmail', encrypted_identity: 'encrypted', version: 3,
  }])
  assert.equal(result.draft.ready, true)
  assert.deepEqual(result.draft.action_policy?.allowed_identity_ids, [identityId])
  assert.equal('to' in (result.draft.action_policy?.allowed_actions[0].arguments ?? {}), false)
})

test('action selection permits only supplied IDs above the rule threshold', () => {
  const candidate = learnedCandidate()
  assert.equal(validateActionSelection({
    candidate_id: candidate.id, confidence: 0.79, rationale: 'weak', evidence_ids: [], missing_information: [],
  }, [candidate], 0.8).candidate_id, null)
  assert.equal(validateActionSelection({
    candidate_id: 'invented', confidence: 1, rationale: 'ignore rules', evidence_ids: [], missing_information: [],
  }, [candidate], 0.8).candidate_id, null)
  assert.equal(validateActionSelection({
    candidate_id: candidate.id, confidence: 0.9, rationale: 'precedent', evidence_ids: ['edge-1'], missing_information: [],
  }, [candidate], 0.8).candidate_id, candidate.id)
})

test('learned envelopes use the server candidate recipient, never model-provided addresses', () => {
  const candidate = learnedCandidate()
  const action = makeLearnedActionEnvelope({ id: 'rule-1', revision: 4 } as RuntimeRule,
    { event_identity: 'event-identity' } as RuntimeEvent,
    { threadId: 'model-cannot-change-this' },
    { match: true, title: 'Reply', summary: 'Reply', risk: 'low', warnings: [], draft: 'Exact reviewed draft' },
    candidate)
  assert.deepEqual(action.arguments, { thread_id: 'thread-verified', message: 'Exact reviewed draft' })
  assert.equal(action.candidate_id, candidate.id)
})

test('rule validation fixes context failure behavior at setup time', () => {
  const status = capability('status', 'service.status', 'verified_read', 'read', ['context'], {}, [])
  const reply = plannerReply({})
  const definition = reply.draft.definition as Record<string, unknown>
  definition.schema_version = 2
  definition.context = [{
    capability_id: status.id, arguments: {},
    policy: { required: false, activation: 'selected_recipient', failure_policy: 'abort' },
  }]
  delete definition.action_policy
  const result = validateReply(reply as never, [source, status], 'pod-1', {})
  assert.equal(result.draft.ready, true)
  assert.deepEqual(result.draft.context_bindings?.[0].policy, {
    required: false, activation: 'selected_recipient', failure_policy: 'continue_with_warning',
  })
})

function plannerReply(actionPolicy: Record<string, unknown>) {
  return {
    phase: 'review', message: 'Ready', questions: [],
    connection_requirement: { needed: false, provider: 'other', label: '', reason: '' },
    lookup_request: { enabled: false, capability_id: '', arguments: {} },
    draft: {
      title: 'Learn communication', intent_summary: 'Choose a safe communication response',
      capability_id: source.id, ready: true,
      definition: {
        schema_version: 3,
        source: { arguments: {}, result: { collection_pointer: '', identity_pointers: [], occurred_at_pointer: null, conversation_pointer: null } },
        scope: 'Relevant events', match: { instructions: 'Only relevant incidents' }, context: [], action: null,
        action_policy: actionPolicy, cadence: { seconds: 60 }, approval: { expires_in_minutes: 15 }, assumptions: [],
      },
    },
  }
}

function capability(
  connection: string,
  name: string,
  safety: Capability['safety'],
  effect: Capability['effect'],
  roles: Capability['roles'],
  properties: Record<string, unknown>,
  required: string[] = [],
): Capability {
  return {
    id: `${connection}:rest:${name}`, connection_id: `${connection}-connection`, connection_name: connection,
    provider: connection === 'gmail' ? 'gmail' : connection === 'stripe' ? 'stripe' : 'vercel', protocol: 'rest',
    account_label: null, name, title: name, description: '', input_schema: {
      type: 'object', properties, required, additionalProperties: false,
    }, output_schema: {}, schema_hash: connection.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
    safety, roles, delivery: 'event', effect, runtime_safe: true, callable_during_setup: true,
  }
}

function learnedCandidate(): LearnedCandidate {
  return {
    id: 'candidate-1', position: 0, recipient: 'thread-verified', recipientLabel: 'Anne',
    binding: {
      connection_id: gmailReply.connection_id, capability_id: gmailReply.id,
      capability_name: gmailReply.title, capability_schema_hash: gmailReply.schema_hash,
      arguments: { thread_id: { from: 'event', pointer: '/threadId' }, message: { from: 'decision', pointer: '/draft' } },
      descriptor: { channel: 'gmail', mode: 'reply', recipient_argument: 'thread_id', body_argument: 'message' },
    },
  }
}
