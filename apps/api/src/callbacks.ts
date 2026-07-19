import type { ConnectionService } from './connections.js'
import { publicEndpointFetch, validatePublicEndpoint } from './connections.js'
import type { Store } from './types/store.js'

export async function drainCallbacks(
  store: Store,
  connections: ConnectionService,
  fetcher: typeof fetch = fetch,
  limit = 10,
) {
  await store.expireRequests()
  for (let index = 0; index < limit; index += 1) {
    const delivery = await store.claimCallback()
    if (!delivery) return
    try {
      const callbackUrl = connections.decryptCallbackUrl(delivery.encryptedUrl)
      await validatePublicEndpoint(callbackUrl)
      const response = await publicEndpointFetch(fetcher, callbackUrl, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: delivery.requestId,
          status: delivery.status,
          decided_at: delivery.decidedAt,
        }),
      })
      if (!response.ok) {
        throw new Error(`Callback returned HTTP ${response.status}`)
      }
      await store.completeCallback(delivery.id, { delivered: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Callback delivery failed'
      const delaySeconds = Math.min(300, 2 ** Math.min(delivery.attempt, 8))
      await store.completeCallback(delivery.id, {
        delivered: false,
        error: message,
        nextAttemptAt: delivery.attempt < 10
          ? new Date(Date.now() + delaySeconds * 1000).toISOString()
          : null,
      })
    }
  }
}
