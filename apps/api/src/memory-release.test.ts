import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateDecisions, normalizedEditSimilarity } from './memory-evaluation.js'
import { memoryRolloutConfig, ownerInLearnedActionRollout } from './memory-rollout.js'
import { MemoryTelemetry } from './memory-telemetry.js'

test('decision evaluation measures correct choices, calibrated abstention, and unsafe selection', () => {
  const result = evaluateDecisions([
    { expectedCandidateId: 'gmail-anne', selectedCandidateId: 'gmail-anne', expectedAbstention: false, confidence: 0.94, threshold: 0.8 },
    { expectedCandidateId: 'telegram-pat', selectedCandidateId: 'telegram-pat', expectedAbstention: false, confidence: 0.82, threshold: 0.8 },
    { expectedCandidateId: 'gmail-anne', selectedCandidateId: null, expectedAbstention: true, confidence: 0.79, threshold: 0.8 },
    { expectedCandidateId: null, selectedCandidateId: null, expectedAbstention: true, confidence: 0.3, threshold: 0.8 },
    { expectedCandidateId: null, selectedCandidateId: null, expectedAbstention: true, confidence: 0.99, threshold: 0.8 },
    { expectedCandidateId: null, selectedCandidateId: 'telegram-pat', expectedAbstention: true, confidence: 0.9, threshold: 0.8 },
  ])
  assert.deepEqual(result, { accuracy: 5 / 6, abstentionAccuracy: 5 / 6, unsafeSelections: 1 })
})

test('voice evaluation reports exact and edited writing similarity', () => {
  assert.equal(normalizedEditSimilarity('hey Anne', 'hey Anne'), 1)
  assert.ok(normalizedEditSimilarity('hey Anne', 'Hello Anne') <= 0.6)
  assert.ok(normalizedEditSimilarity('can you take a look?', 'could you take a look?') > 0.75)
  assert.equal(normalizedEditSimilarity('', ''), 1)
})

test('rollout gates are deterministic, bounded, and fail closed', () => {
  assert.throws(() => memoryRolloutConfig({ MEMORY_LEARNED_ACTIONS_ROLLOUT_PERCENT: '101' }), /between 0 and 100/)
  assert.throws(() => memoryRolloutConfig({ MEMORY_HISTORY_IMPORTS_ENABLED: 'yes' }), /true or false/)
  const disabled = memoryRolloutConfig({ MEMORY_LEARNED_ACTIONS_ENABLED: 'false' })
  assert.equal(ownerInLearnedActionRollout('owner-1', disabled), false)
  const half = memoryRolloutConfig({ MEMORY_LEARNED_ACTIONS_ROLLOUT_PERCENT: '50' })
  assert.equal(ownerInLearnedActionRollout('owner-1', half), ownerInLearnedActionRollout('owner-1', half))
  assert.equal(ownerInLearnedActionRollout('owner-1', { ...half, learnedActionsPercent: 100 }), true)
})

test('memory telemetry emits only bounded identifiers, enums, counts, and timings', () => {
  const lines: string[] = []
  const telemetry = new MemoryTelemetry((line) => lines.push(line))
  telemetry.emit({ name: 'action_selection', outcome: 'abstained', ownerId: 'owner-private-id', durationMs: 12.4, count: 3 })
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0]!, /owner-private-id/)
  assert.deepEqual(Object.keys(JSON.parse(lines[0]!)).sort(), ['count', 'duration_ms', 'name', 'outcome', 'owner_hash', 'type'])
  assert.throws(() => telemetry.emit({ name: 'message_text', outcome: 'succeeded' }), /Invalid memory metric/)
})
