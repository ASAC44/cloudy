import { drainCallbacks } from './callbacks.js'
import type { ConnectionService } from './connections.js'
import { RuntimeEngine } from './runtime-engine.js'
import type { RuntimeStore, Store } from './types/store.js'
import { TelegramRuntime, telegramWorkerId } from './telegram-runtime.js'

export function startRuntimeLoop(
  store: Store & RuntimeStore,
  connections: ConnectionService,
  telegramConfig?: { apiId: number; apiHash: string },
  workerId = process.env.PODEX_WORKER_ID?.slice(0, 160) || telegramWorkerId(),
) {
  const engine = new RuntimeEngine(store, connections)
  const telegram = telegramConfig
    ? new TelegramRuntime(store, connections, engine, workerId, telegramConfig)
    : null
  let stopping = false
  let retentionAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const cycle = async () => {
    await telegram?.syncLiveConnections()
    await telegram?.processAuthOnce()
    await drain(engine.pollOnce(workerId), () => engine.pollOnce(workerId))
    await drain(engine.evaluateOnce(), () => engine.evaluateOnce())
    await drain(engine.dispatchOnce(), () => engine.dispatchOnce())
    await drainCallbacks(store, connections, fetch, 10)
    if (Date.now() - retentionAt > 24 * 60 * 60_000) {
      await store.purgeRuntimeData()
      retentionAt = Date.now()
    }
  }

  const run = async () => {
    if (stopping) return
    try {
      await cycle()
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Runtime cycle failed')
    }
    if (!stopping) timer = setTimeout(run, 1_000)
  }
  void run()

  return async () => {
    stopping = true
    if (timer) clearTimeout(timer)
    await telegram?.close()
  }
}

async function drain(first: Promise<boolean>, next: () => Promise<boolean>, limit = 20) {
  if (!await first) return
  for (let index = 1; index < limit; index += 1) if (!await next()) return
}
