import { createHash } from 'node:crypto'

export type MemoryRolloutConfig = {
  learnedActionsEnabled: boolean
  learnedActionsPercent: number
  historyImportsEnabled: boolean
}

export function memoryRolloutConfig(env: NodeJS.ProcessEnv = process.env): MemoryRolloutConfig {
  return {
    learnedActionsEnabled: booleanEnv(env.MEMORY_LEARNED_ACTIONS_ENABLED, true, 'MEMORY_LEARNED_ACTIONS_ENABLED'),
    learnedActionsPercent: integerEnv(env.MEMORY_LEARNED_ACTIONS_ROLLOUT_PERCENT, 100, 'MEMORY_LEARNED_ACTIONS_ROLLOUT_PERCENT'),
    historyImportsEnabled: booleanEnv(env.MEMORY_HISTORY_IMPORTS_ENABLED, true, 'MEMORY_HISTORY_IMPORTS_ENABLED'),
  }
}

export function ownerInLearnedActionRollout(ownerId: string, config: MemoryRolloutConfig) {
  if (!config.learnedActionsEnabled || config.learnedActionsPercent === 0) return false
  if (config.learnedActionsPercent === 100) return true
  const bucket = createHash('sha256').update(`cloudy-memory-rollout:${ownerId}`).digest().readUInt32BE(0) % 10_000
  return bucket < config.learnedActionsPercent * 100
}

function booleanEnv(value: string | undefined, fallback: boolean, name: string) {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function integerEnv(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 100) throw new Error(`${name} must be an integer between 0 and 100`)
  return number
}
