import type { AgentMemory, ConnectionProvider } from './types/store.js'

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
