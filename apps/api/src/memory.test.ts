import assert from 'node:assert/strict'
import test from 'node:test'

import { memoryContext, memoryScopes, messageExampleContext, rankMessageExamples } from './memory.js'
import type { AgentMemory, MemoryMessageExample } from './types/store.js'

const memory = (key: string, kind: string, content: string): AgentMemory => ({
  id: key, owner_id: 'owner', scope: 'user', scope_id: null, provider: null,
  memory_key: key, content, source: { kind }, created_at: '', updated_at: '',
})

test('memory context scopes provider examples and keeps writing data out of general prompts', () => {
  assert.deepEqual(memoryScopes(undefined, 'gmail', 'connection-1'), [
    { scope: 'user' },
    { scope: 'provider', scopeId: 'connection-1', provider: 'gmail' },
  ])
  const memories = [
    memory('preference:1', 'preference', 'Keep answers short.'),
    memory('sample:1', 'writing_sample', 'hey, sounds good'),
    memory('correction:1', 'correction', 'Before: Hello. After: hey'),
  ]
  assert.match(memoryContext(memories), /hey, sounds good/)
  assert.equal(memoryContext(memories, 6_000, false), '- [preference:1] Keep answers short.')
})

test('approved message examples expose only decrypted final writing samples', () => {
  const example = (id: string, eligibility: MemoryMessageExample['eligibility'], payload: unknown): MemoryMessageExample => ({
    id, owner_id: 'owner', decision_case_id: `decision-${id}`, connection_id: 'connection',
    person_id: null, identity_id: null, channel: 'gmail', language: null,
    source_kind: 'approved_action', eligibility, encrypted_payload: JSON.stringify(payload),
    payload_hash: 'a'.repeat(64), style_metadata: {}, occurred_at: '', created_at: '', updated_at: '',
  })
  const context = messageExampleContext([
    { ...example('1', 'positive', { arguments: { message: 'hey, this works for me' } }), language: 'en', style_metadata: { greeting: 'casual' } },
    { ...example('2', 'intent_only', { kind: 'correction', original: 'Dear Anne', final: 'hey Anne' }), source_kind: 'approved_correction' },
    example('3', 'negative', { arguments: { message: 'do not include this' } }),
  ], JSON.parse)

  assert.match(context, /voice profile.*languages=en.*greeting=casual/)
  assert.match(context, /delivered gmail writing sample.*hey, this works for me/)
  assert.match(context, /approved gmail writing sample[^]*hey Anne[^]*Correction note: avoid the earlier wording: Dear Anne/)
  assert.doesNotMatch(context, /do not include this/)
})

test('imported sent messages are voice-only final writing samples', () => {
  const example: MemoryMessageExample = {
    id: 'imported', owner_id: 'owner', decision_case_id: null, connection_id: 'gmail-connection',
    person_id: null, identity_id: null, channel: 'gmail', language: null,
    source_kind: 'imported_sent', eligibility: 'positive',
    encrypted_payload: JSON.stringify({ final_message: 'Yep, Friday afternoon works for me.' }),
    payload_hash: 'a'.repeat(64), style_metadata: {}, occurred_at: '', created_at: '', updated_at: '',
  }
  const context = messageExampleContext([example], JSON.parse)
  assert.match(context, /imported user-sent gmail writing sample/)
  assert.match(context, /Friday afternoon works/)
})

test('voice examples prefer person, channel, and intent before global recency', () => {
  const example = (
    id: string,
    person: string | null,
    channel: MemoryMessageExample['channel'],
    eligibility: MemoryMessageExample['eligibility'] = 'positive',
    sourceKind: MemoryMessageExample['source_kind'] = 'approved_action',
  ): MemoryMessageExample => ({
    id, owner_id: 'owner', decision_case_id: `decision-${id}`, connection_id: `${channel}-connection`,
    person_id: person, identity_id: person ? `identity-${person}` : null, channel, language: null,
    source_kind: sourceKind, eligibility, encrypted_payload: '{}', payload_hash: 'a'.repeat(64),
    style_metadata: {}, occurred_at: '', created_at: '', updated_at: '',
  })
  const ranked = rankMessageExamples([
    { example: example('global-newest', null, 'gmail'), intent: 'Unrelated sales update' },
    { example: example('same-intent', null, 'gmail'), intent: 'Handle Vercel incidents' },
    { example: example('same-person', 'anne', 'telegram'), intent: 'Handle Vercel incidents quickly' },
    { example: example('corrected', 'anne', 'telegram', 'intent_only', 'approved_correction'), intent: 'Handle Vercel incidents' },
    { example: example('approved-only', 'anne', 'telegram', 'intent_only'), intent: 'Handle Vercel incidents' },
    { example: example('same-channel', null, 'telegram'), intent: 'Unrelated report' },
  ], {
    personId: 'anne', identityId: 'identity-anne', channel: 'telegram',
    connectionId: 'telegram-connection', intent: 'Handle Vercel incidents',
  }, 6)
  assert.deepEqual(ranked.map(({ id }) => id), [
    'corrected', 'same-person', 'approved-only', 'same-channel', 'same-intent', 'global-newest',
  ])
})
