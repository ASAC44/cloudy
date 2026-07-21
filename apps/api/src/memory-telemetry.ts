import { createHash } from 'node:crypto'

const NAMES = new Set([
  'action_selection', 'voice_retrieval', 'graph_search', 'graph_sync',
  'history_import', 'graph_rebuild',
])
const OUTCOMES = new Set([
  'selected', 'abstained', 'disabled', 'matched', 'empty', 'succeeded',
  'failed', 'unavailable', 'completed', 'continued',
])

export type MemoryMetric = {
  name: string
  outcome: string
  ownerId?: string
  durationMs?: number
  count?: number
  lagMs?: number
}

export type MetricSink = (line: string) => void

export class MemoryTelemetry {
  constructor(private readonly sink: MetricSink = console.info) {}

  emit(metric: MemoryMetric) {
    if (!NAMES.has(metric.name) || !OUTCOMES.has(metric.outcome)) throw new Error('Invalid memory metric')
    const payload = {
      type: 'cloudy_memory_metric',
      name: metric.name,
      outcome: metric.outcome,
      ...(metric.ownerId ? { owner_hash: createHash('sha256').update(metric.ownerId).digest('hex').slice(0, 12) } : {}),
      ...(metric.durationMs === undefined ? {} : { duration_ms: bounded(metric.durationMs, 0, 600_000) }),
      ...(metric.count === undefined ? {} : { count: bounded(metric.count, 0, 1_000_000) }),
      ...(metric.lagMs === undefined ? {} : { lag_ms: bounded(metric.lagMs, 0, 30 * 86_400_000) }),
    }
    this.sink(JSON.stringify(payload))
  }
}

function bounded(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return maximum
  return Math.round(Math.max(minimum, Math.min(maximum, value)))
}
