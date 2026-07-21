import { EventEmitter } from 'node:events'

import { createClient, type RealtimeChannel } from '@supabase/supabase-js'

export const POD_EVENT_SCOPES = ['request', 'layout', 'connections', 'codex', 'revoked'] as const
export type PodEventScope = typeof POD_EVENT_SCOPES[number]
export type PodEvent = { ownerId: string; podId: string | null; scope: PodEventScope }

export interface PodEventSource {
  readonly ready: boolean
  publish(event: PodEvent): void
  subscribe(ownerId: string, listener: (event: PodEvent) => void): () => void
  subscribeStatus(listener: (ready: boolean) => void): () => void
}

export class SupabasePodEvents implements PodEventSource {
  private readonly emitter = new EventEmitter().setMaxListeners(0)
  private readonly client
  private channel: RealtimeChannel | null = null
  ready = false

  constructor(url: string, secretKey: string) {
    this.client = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  }

  start() {
    if (this.channel) return
    this.channel = this.client
      .channel('cloudy:pod-events', { config: { private: true } })
      .on('broadcast', { event: 'invalidate' }, ({ payload }) => {
        if (!payload || typeof payload !== 'object') return
        const ownerId = 'owner_id' in payload ? payload.owner_id : null
        const podId = 'pod_id' in payload ? payload.pod_id : null
        const scope = 'scope' in payload ? payload.scope : null
        if (typeof ownerId !== 'string' || (podId !== null && typeof podId !== 'string') || !POD_EVENT_SCOPES.includes(scope as PodEventScope)) return
        this.publish({ ownerId, podId, scope })
      })
      .subscribe((status) => this.setReady(status === 'SUBSCRIBED'))
  }

  publish(event: PodEvent) {
    this.emitter.emit(`owner:${event.ownerId}`, event)
  }

  subscribe(ownerId: string, listener: (event: PodEvent) => void) {
    const event = `owner:${ownerId}`
    this.emitter.on(event, listener)
    return () => this.emitter.off(event, listener)
  }

  subscribeStatus(listener: (ready: boolean) => void) {
    this.emitter.on('status', listener)
    return () => this.emitter.off('status', listener)
  }

  async close() {
    if (this.channel) await this.client.removeChannel(this.channel)
    this.channel = null
    this.setReady(false)
  }

  private setReady(ready: boolean) {
    if (ready === this.ready) return
    this.ready = ready
    this.emitter.emit('status', ready)
  }
}
