import { serve } from '@hono/node-server'

import { createApp } from './app.js'
import { drainCallbacks } from './callbacks.js'
import { ConnectionService } from './connections.js'
import { RuleBuilderService } from './rule-builder.js'
import { SupabaseStore } from './supabase-store.js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
const connectionEncryptionKey = process.env.CONNECTION_ENCRYPTION_KEY
const publicApiUrl = process.env.PODEX_PUBLIC_API_URL
const webUrl = process.env.PODEX_WEB_URL

if (!supabaseUrl) throw new Error('SUPABASE_URL is required')
if (!supabaseSecretKey) throw new Error('SUPABASE_SECRET_KEY is required')
if (!connectionEncryptionKey) throw new Error('CONNECTION_ENCRYPTION_KEY is required')
if (!publicApiUrl) throw new Error('PODEX_PUBLIC_API_URL is required')
if (!webUrl) throw new Error('PODEX_WEB_URL is required')

const store = new SupabaseStore(supabaseUrl, supabaseSecretKey)
const connections = new ConnectionService(store, {
  encryptionKey: connectionEncryptionKey,
  publicApiUrl,
  webUrl,
  githubClientId: process.env.GITHUB_CLIENT_ID,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
})
const ruleBuilder = new RuleBuilderService(store, connections)
const app = createApp(supabaseUrl, store, undefined, connections, undefined, ruleBuilder)

let draining = false
const drain = async () => {
  if (draining) return
  draining = true
  try {
    await drainCallbacks(store, connections)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Callback delivery failed')
  } finally {
    draining = false
  }
}

void drain()
setInterval(() => void drain(), 5_000).unref()

serve({ fetch: app.fetch, port: Number(process.env.PORT) || 3001 })
