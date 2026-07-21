import { ConnectionService } from './connections.js'
import { startRuntimeLoop } from './runtime-loop.js'
import { SupabaseStore } from './supabase-store.js'

const supabaseUrl = requiredEnv('SUPABASE_URL')
const supabaseSecretKey = requiredEnv('SUPABASE_SECRET_KEY')
const encryptionKey = requiredEnv('CONNECTION_ENCRYPTION_KEY')
const telegramApiId = process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : undefined
const telegramApiHash = process.env.TELEGRAM_API_HASH

if (telegramApiId !== undefined && (!Number.isInteger(telegramApiId) || telegramApiId <= 0)) {
  throw new Error('TELEGRAM_API_ID must be a positive integer')
}
if ((telegramApiId === undefined) !== (telegramApiHash === undefined)) {
  throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be configured together')
}

const store = new SupabaseStore(supabaseUrl, supabaseSecretKey)
const connections = new ConnectionService(store, {
  encryptionKey,
  publicApiUrl: requiredEnv('CLOUDY_PUBLIC_API_URL'),
  webUrl: requiredEnv('CLOUDY_WEB_URL'),
  githubClientId: process.env.GITHUB_CLIENT_ID,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  telegramApiId,
  telegramApiHash,
})
const stop = startRuntimeLoop(
  store,
  connections,
  telegramApiId && telegramApiHash ? { apiId: telegramApiId, apiHash: telegramApiHash } : undefined,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void stop().finally(() => process.exit(0)) })
}

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
