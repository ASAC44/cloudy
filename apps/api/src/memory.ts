import type { AgentMemory, ConnectionProvider, MemoryMessageExample } from './types/store.js'

export function rankMessageExamples(
  examples: Array<{ example: MemoryMessageExample; intent: string }>,
  input: { connectionId?: string; personId?: string; identityId?: string; channel?: MemoryMessageExample['channel']; intent: string },
  limit = 5,
) {
  return examples.map(({ example, intent }, index) => {
    const samePerson = Boolean(input.personId && example.person_id === input.personId)
    const sameIdentity = Boolean(input.identityId && example.identity_id === input.identityId)
    const sameChannel = Boolean(input.channel && example.channel === input.channel)
    const sameIntent = relatedIntent(input.intent, intent)
    const bucket = (sameIdentity || samePerson) && sameChannel && sameIntent ? 0
      : samePerson && sameIntent ? 1
        : sameChannel ? 2
          : sameIntent ? 3 : 4
    return {
      example,
      bucket,
      delivered: example.eligibility === 'positive',
      sameConnection: Boolean(input.connectionId && example.connection_id === input.connectionId),
      index,
    }
  }).sort((left, right) => left.bucket - right.bucket
    || Number(right.delivered) - Number(left.delivered)
    || Number(right.sameConnection) - Number(left.sameConnection)
    || left.index - right.index)
    .slice(0, Math.max(1, Math.min(limit, 10)))
    .map(({ example }) => example)
}

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
  const profile = voiceProfile(examples)
  const lines = examples.slice(0, 5).flatMap((example) => {
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
  })
  return [profile, ...lines].filter(Boolean).join('\n')
}

function voiceProfile(examples: MemoryMessageExample[]) {
  const languages = [...new Set(examples.flatMap((example) => example.language ? [example.language] : []))].slice(0, 3)
  const conventions = examples.flatMap((example) => Object.entries(example.style_metadata ?? {}).flatMap(([key, value]) => {
    if (!/^[a-z0-9_]{1,40}$/i.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) return []
    return [`${key}=${String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 120)}`]
  })).slice(0, 8)
  if (!languages.length && !conventions.length) return ''
  return `- [voice profile] ${[
    languages.length ? `languages=${languages.join(',')}` : '',
    conventions.length ? `conventions=${conventions.join(';')}` : '',
  ].filter(Boolean).join(' ')}`
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

function relatedIntent(current: string, prior: string) {
  const words = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  const currentWords = words(current)
  const priorWords = words(prior)
  if (!currentWords.size || !priorWords.size) return false
  const overlap = [...currentWords].filter((word) => priorWords.has(word)).length
  return overlap / Math.min(currentWords.size, priorWords.size) >= 0.5
}
