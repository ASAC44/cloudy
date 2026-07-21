import { createHash } from 'node:crypto'

import { ConnectionError, type ConnectionService, type MessageHistoryScope } from './connections.js'
import type { Store } from './types/store.js'
import { MemoryTelemetry } from './memory-telemetry.js'

export class MessageHistoryImporter {
  constructor(
    private readonly store: Store,
    private readonly connections: ConnectionService,
    private readonly telemetry: MemoryTelemetry = new MemoryTelemetry(() => undefined),
  ) {}

  async importOnce() {
    const claim = await this.store.claimMemoryImport()
    if (!claim) return false
    const started = Date.now()
    try {
      const scope = this.connections.decryptPrivatePayload<MessageHistoryScope>(claim.encryptedScope)
      const cursor = claim.encryptedCursor
        ? this.connections.decryptPrivatePayload<Record<string, unknown>>(claim.encryptedCursor)
        : null
      const expectedKind = scope.provider === 'gmail' ? 'sent_messages' : 'dialog_messages'
      if (claim.importKind !== expectedKind) throw new ConnectionError('invalid_history_scope')
      const page = await this.connections.readMessageHistoryPage(claim.ownerId, claim.connectionId, scope, cursor)
      for (const message of page.messages) {
        const recorded = await this.store.recordImportedMessage({
          importId: claim.importId,
          leaseToken: claim.leaseToken,
          providerMessageIdHash: digest(`${claim.connectionId}:message:${message.providerId}`),
          ...(message.conversationId ? { conversationIdHash: digest(`${claim.connectionId}:conversation:${message.conversationId}`) } : {}),
          encryptedPayload: this.connections.encryptPrivatePayload({ final_message: message.text }),
          payloadHash: digest(message.text),
          styleMetadata: message.styleMetadata,
          occurredAt: message.occurredAt,
        })
        if (!recorded) throw new ConnectionError('history_import_lease_expired')
      }
      const completed = await this.store.completeMemoryImport({
        importId: claim.importId,
        leaseToken: claim.leaseToken,
        ...(page.cursor ? { encryptedCursor: this.connections.encryptPrivatePayload(page.cursor) } : {}),
        excludedCount: page.excludedCount,
        hasMore: Boolean(page.cursor),
      })
      if (!completed) throw new ConnectionError('history_import_lease_expired')
      this.telemetry.emit({ name: 'history_import', outcome: page.cursor ? 'continued' : 'completed', ownerId: claim.ownerId, durationMs: Date.now() - started, count: page.messages.length })
    } catch (error) {
      await this.store.failMemoryImport(
        claim.importId,
        claim.leaseToken,
        safeImportError(error),
        retryableImportError(error),
      )
      this.telemetry.emit({ name: 'history_import', outcome: 'failed', ownerId: claim.ownerId, durationMs: Date.now() - started })
    }
    return true
  }
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function retryableImportError(error: unknown) {
  return !(error instanceof ConnectionError && [
    'authentication_failed', 'capability_not_found', 'connection_not_found',
    'credentials_missing', 'credentials_unreadable', 'invalid_history_scope',
  ].includes(error.code))
}

function safeImportError(error: unknown) {
  if (error instanceof ConnectionError) {
    if (error.code === 'authentication_failed') return 'The provider authorization expired.'
    if (error.code === 'connection_not_found') return 'The connection is no longer available.'
    if (error.code === 'capability_not_found') return 'This connection cannot import sent history.'
    if (error.code === 'invalid_history_scope') return 'The saved import scope is invalid.'
  }
  return 'Message history import failed.'
}
