import assert from 'node:assert/strict'
import test from 'node:test'

import { drainCallbacks } from './callbacks.js'
import type { ConnectionService } from './connections.js'
import type { CallbackDelivery, Store } from './types/store.js'

const delivery: CallbackDelivery = {
  id: '00000000-0000-4000-8000-000000000050',
  requestId: '00000000-0000-4000-8000-000000000051',
  encryptedUrl: 'encrypted',
  attempt: 1,
  status: 'approved',
  decidedAt: '2026-07-19T12:00:00.000Z',
}

test('callback delivery posts the terminal outcome and marks it delivered', async () => {
  const completed: Array<{ delivered: boolean }> = []
  let available = true
  const store = {
    async expireRequests() {},
    async claimCallback() {
      if (!available) return null
      available = false
      return delivery
    },
    async completeCallback(_id: string, result: { delivered: boolean }) { completed.push(result) },
  } as unknown as Store
  const connections = {
    decryptCallbackUrl: () => 'https://1.1.1.1/resume',
  } as unknown as ConnectionService
  let payload = ''
  let dnsPinned = false

  await drainCallbacks(store, connections, async (_input, init) => {
    payload = String(init?.body)
    dnsPinned = Reflect.has(init ?? {}, 'dispatcher')
    return new Response(null, { status: 204 })
  })

  assert.deepEqual(completed, [{ delivered: true }])
  assert.deepEqual(JSON.parse(payload), {
    request_id: delivery.requestId,
    status: 'approved',
    decided_at: delivery.decidedAt,
  })
  assert.equal(dnsPinned, true)
})

test('callback delivery rejects private destinations and schedules a retry without exposing the URL', async () => {
  let available = true
  let result: { delivered: boolean; error?: string; nextAttemptAt?: string | null } | undefined
  const store = {
    async expireRequests() {},
    async claimCallback() {
      if (!available) return null
      available = false
      return delivery
    },
    async completeCallback(_id: string, value: typeof result) { result = value },
  } as unknown as Store
  const connections = {
    decryptCallbackUrl: () => 'https://127.0.0.1/private-resume-token',
  } as unknown as ConnectionService

  await drainCallbacks(store, connections, async () => {
    throw new Error('fetch should not run')
  })

  assert.equal(result?.delivered, false)
  assert.ok(result?.nextAttemptAt)
  assert.equal(result?.error?.includes('private-resume-token'), false)
})
