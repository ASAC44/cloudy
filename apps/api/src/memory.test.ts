import assert from 'node:assert/strict'
import test from 'node:test'

import { memoryContext, memoryScopes } from './memory.js'
import type { AgentMemory } from './types/store.js'

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
