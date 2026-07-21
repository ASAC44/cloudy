import type { AgentMemory, ConnectionProvider, MemoryMessageExample } from './types/store.js'

export function memoryScopes(workspaceId?: string, provider?: ConnectionProvider, providerScopeId?: string) {
  return [
    { scope: 'user' as const },
    ...(workspaceId ? [{ scope: 'workspace' as const, scopeId: workspaceId }] : []),
    ...(provider && providerScopeId ? [{ scope: 'provider' as const, scopeId: providerScopeId, provider }] : []),
  ]
}

export function memoryContext(memories: AgentMemory[], maxCharacters = 6_000, includeWriting = true) {
  let used = 0
  return memories.filter((memory) => includeWriting || !['correction', 'writing_sample'].includes(String(memory.source.kind))).flatMap((memory) => {
    const line = `- [${memory.memory_key}] ${memory.content}`
    if (used + line.length > maxCharacters) return []
    used += line.length
    return [line]
  }).join('\n')
}

export function messageExampleContext(
  examples: MemoryMessageExample[],
  decrypt: (payload: string) => unknown,
  maxCharacters = 6_000,
) {
  let used = 0
  return examples.slice(0, 5).flatMap((example) => {
    if (!['positive', 'intent_only'].includes(example.eligibility)) return []
    let payload: unknown
    try { payload = decrypt(example.encrypted_payload) } catch { return [] }
    const sample = writingSample(payload)
    if (!sample) return []
    const weight = example.eligibility === 'positive' ? 'delivered' : 'approved'
    const line = `- [${weight} ${example.channel} writing sample] ${sample}`
    if (used + line.length > maxCharacters) return []
    used += line.length
    return [line]
  }).join('\n')
}

function writingSample(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.kind === 'correction' && typeof record.final === 'string' && record.final.trim()) {
    const original = typeof record.original === 'string' && record.original.trim()
      ? `\n  Correction note: avoid the earlier wording: ${record.original.trim().slice(0, 1_000)}` : ''
    return `${record.final.trim().slice(0, 2_000)}${original}`
  }
  const args = record.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const message = (args as Record<string, unknown>).message
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 2_000) : null
}
