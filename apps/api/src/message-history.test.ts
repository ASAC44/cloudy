import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanSentText } from './connections.js'
import { MessageHistoryImporter } from './message-history.js'

test('sent text removes replies, signatures, forwards, and quoted content', () => {
  assert.equal(cleanSentText('Sounds good.\n\n-- \nAva\n> quoted'), 'Sounds good.')
  assert.equal(cleanSentText('I can do Tuesday.\n\nOn Tue, Pat wrote:\nOld message'), 'I can do Tuesday.')
  assert.equal(cleanSentText('Please see this.\n----- Forwarded Message -----\nPrivate history'), 'Please see this.')
})

test('history importer encrypts bounded user-sent examples and advances its lease', async () => {
  const recorded: Array<Record<string, unknown>> = []
  let completion: Record<string, unknown> | undefined
  const store = {
    claimMemoryImport: async () => ({
      importId: 'import-1', ownerId: 'owner-1', connectionId: 'gmail-1',
      importKind: 'sent_messages', encryptedScope: 'scope', encryptedCursor: null,
      leaseToken: 'lease-1', attempts: 1,
    }),
    recordImportedMessage: async (input: Record<string, unknown>) => { recorded.push(input); return true },
    completeMemoryImport: async (input: Record<string, unknown>) => { completion = input; return true },
    failMemoryImport: async () => { throw new Error('unexpected failure') },
  }
  const connections = {
    decryptPrivatePayload: () => ({ provider: 'gmail', after: '2026-01-01', max_messages: 50 }),
    encryptPrivatePayload: (value: unknown) => JSON.stringify(value),
    readMessageHistoryPage: async () => ({
      messages: [{
        providerId: 'provider-message-1', conversationId: 'thread-1', text: 'Can we move this to Friday?',
        occurredAt: '2026-07-20T10:00:00.000Z', styleMetadata: { channel: 'gmail', imported: true },
      }],
      excludedCount: 2,
      cursor: { page_token: 'next', processed: 25 },
    }),
  }
  assert.equal(await new MessageHistoryImporter(store as never, connections as never).importOnce(), true)
  assert.equal(recorded.length, 1)
  assert.match(String(recorded[0]?.providerMessageIdHash), /^[0-9a-f]{64}$/)
  assert.match(String(recorded[0]?.conversationIdHash), /^[0-9a-f]{64}$/)
  assert.equal(recorded[0]?.encryptedPayload, JSON.stringify({ final_message: 'Can we move this to Friday?' }))
  assert.equal(completion?.hasMore, true)
  assert.equal(completion?.excludedCount, 2)
})

test('history importer pauses invalid provider scope without logging message content', async () => {
  let failure: Record<string, unknown> | undefined
  const store = {
    claimMemoryImport: async () => ({
      importId: 'import-1', ownerId: 'owner-1', connectionId: 'gmail-1',
      importKind: 'dialog_messages', encryptedScope: 'scope', encryptedCursor: null,
      leaseToken: 'lease-1', attempts: 1,
    }),
    failMemoryImport: async (importId: string, leaseToken: string, error: string, retryable: boolean) => {
      failure = { importId, leaseToken, error, retryable }; return true
    },
  }
  const connections = { decryptPrivatePayload: () => ({ provider: 'gmail', after: '2026-01-01', max_messages: 50 }) }
  assert.equal(await new MessageHistoryImporter(store as never, connections as never).importOnce(), true)
  assert.deepEqual(failure, { importId: 'import-1', leaseToken: 'lease-1', error: 'The saved import scope is invalid.', retryable: false })
})
