import type { ConnectionProvider } from './api'

export type ActionState = { error?: string; success?: string }

export type ConnectionInput = {
  provider: ConnectionProvider
  name: string
  endpoint_url?: string
  auth_type?: 'none' | 'bearer'
  token?: string
}
