import type { AgentMemory, ConnectionProvider } from './types/store.js'

export function memoryScopes(workspaceId?: string, provider?: ConnectionProvider) {
  return [
    { scope: 'user' as const },
    ...(workspaceId ? [{ scope: 'workspace' as const, scopeId: workspaceId }] : []),
    ...(provider ? [{ scope: 'provider' as const, provider }] : []),
  ]
}

export function memoryContext(memories: AgentMemory[], maxCharacters = 6_000) {
  let used = 0
  return memories.flatMap((memory) => {
    const line = `- [${memory.memory_key}] ${memory.content}`
    if (used + line.length > maxCharacters) return []
    used += line.length
    return [line]
  }).join('\n')
}
