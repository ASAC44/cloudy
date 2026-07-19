import type { StoredAiSettings } from './store.js'

export type AiTester = (settings: StoredAiSettings, apiKey: string) => Promise<void>
