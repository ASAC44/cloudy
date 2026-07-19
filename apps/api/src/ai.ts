import { createAnthropic } from '@ai-sdk/anthropic'
import { createCerebras } from '@ai-sdk/cerebras'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText, type LanguageModel } from 'ai'

import { ConnectionError, publicEndpointFetch, validatePublicEndpoint } from './connections.js'
import type { AiProvider, StoredAiSettings } from './types/store.js'
import type { AiTester } from './types/ai.js'

export type { AiTester } from './types/ai.js'

const PROVIDERS = new Set<AiProvider>(['openai', 'cerebras', 'openrouter', 'anthropic', 'custom'])

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && PROVIDERS.has(value as AiProvider)
}

export function createAiModel(
  settings: Pick<StoredAiSettings, 'provider' | 'base_url' | 'model'>,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): LanguageModel {
  const options = {
    apiKey,
    baseURL: settings.base_url,
    fetch: endpointFetch(settings.base_url, fetcher),
  }

  switch (settings.provider) {
    case 'openai':
      return createOpenAI(options)(settings.model)
    case 'cerebras':
      return createCerebras(options)(settings.model)
    case 'openrouter':
      return createOpenRouter(options)(settings.model)
    case 'anthropic':
      return createAnthropic(options)(settings.model)
    case 'custom':
      return createOpenAICompatible({ ...options, name: 'custom' })(settings.model)
  }
}

export const testAiSettings: AiTester = async (settings, apiKey) => {
  await validatePublicEndpoint(settings.base_url)
  await generateText({
    model: createAiModel(settings, apiKey),
    prompt: 'Reply with OK.',
    maxOutputTokens: 32,
  })
}

function endpointFetch(baseUrl: string, fetcher: typeof fetch): typeof fetch {
  const origin = new URL(baseUrl).origin
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== origin) throw new ConnectionError('unexpected_redirect')
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000)
    const response = await publicEndpointFetch(fetcher, input, { ...init, redirect: 'manual', signal })
    if (response.status >= 300 && response.status < 400) throw new ConnectionError('unexpected_redirect')
    return response
  }
}
