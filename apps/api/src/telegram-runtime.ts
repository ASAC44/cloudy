import { randomUUID } from 'node:crypto'

import QRCode from 'qrcode'
import { TelegramClient } from 'telegram'
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js'
import { StringSession } from 'telegram/sessions/StringSession.js'

import { ConnectionService } from './connections.js'
import { RuntimeEngine } from './runtime-engine.js'
import type { RuntimeStore, Store, TelegramAuthSession } from './types/store.js'

type AuthConfig = { apiId: number; apiHash: string }

export class TelegramRuntime {
  private readonly clients = new Map<string, TelegramClient>()
  private readonly authTasks = new Set<string>()
  private lastConnectionSync = 0

  constructor(
    private readonly store: Store & RuntimeStore,
    private readonly connections: ConnectionService,
    private readonly engine: RuntimeEngine,
    private readonly workerId: string,
    private readonly auth: AuthConfig,
  ) {}

  async processAuthOnce() {
    if (this.authTasks.size >= 5) return false
    const claim = await this.store.claimTelegramAuthSession(this.workerId)
    if (!claim) return false
    const session = await this.store.getClaimedTelegramAuthSession(claim.sessionId, claim.leaseToken)
    if (!session) return true
    this.authTasks.add(session.id)
    void this.authorize(session, claim.leaseToken).finally(() => this.authTasks.delete(session.id))
    return true
  }

  async syncLiveConnections(force = false) {
    if (!force && Date.now() - this.lastConnectionSync < 25_000) return
    this.lastConnectionSync = Date.now()
    const active = await this.store.listActiveTelegramConnections()
    const desired = new Set(active.map(({ connectionId }) => connectionId))
    for (const [connectionId, client] of this.clients) {
      if (!desired.has(connectionId)) {
        this.clients.delete(connectionId)
        await client.disconnect().catch(() => undefined)
      }
    }
    for (const item of active) {
      const lease = await this.store.claimConnectionLease(item.ownerId, item.connectionId, this.workerId)
      if (!lease) {
        const client = this.clients.get(item.connectionId)
        if (client) {
          this.clients.delete(item.connectionId)
          await client.disconnect().catch(() => undefined)
        }
        continue
      }
      try {
        const current = this.clients.get(item.connectionId)
        if (current && !current.connected) {
          await current.connect()
          if (!await current.checkAuthorization()) throw new Error('Telegram session was revoked.')
        } else if (!current) {
          await this.startLiveConnection(item.ownerId, item.connectionId)
        }
        await this.store.recordConnectionHealth(item.ownerId, item.connectionId, true)
      } catch (error) {
        const current = this.clients.get(item.connectionId)
        this.clients.delete(item.connectionId)
        await current?.disconnect().catch(() => undefined)
        await this.store.recordConnectionHealth(item.ownerId, item.connectionId, false, safeTelegramError(error))
      }
    }
  }

  async close() {
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(clients.map((client) => client.disconnect().catch(() => undefined)))
  }

  private async authorize(session: TelegramAuthSession, leaseToken: string) {
    const stringSession = new StringSession('')
    const client = new TelegramClient(stringSession, this.auth.apiId, this.auth.apiHash, { connectionRetries: 3 })
    try {
      await client.connect()
      const user = await client.signInUserWithQrCode(this.auth, {
        qrCode: async ({ token, expires }) => {
          const expiresAt = new Date(expires * 1000).toISOString()
          const loginUrl = `tg://login?token=${token.toString('base64url')}`
          const dataUrl = await QRCode.toDataURL(loginUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
          const updated = await this.store.updateTelegramAuthSession(session.id, leaseToken, {
            status: 'pending_qr',
            encrypted_qr_payload: this.connections.encryptPrivatePayload({ dataUrl }),
            qr_expires_at: expiresAt,
            last_error: null,
          })
          if (!updated) throw new Error('AUTH_USER_CANCEL')
        },
        password: async (hint) => {
          const updated = await this.store.updateTelegramAuthSession(session.id, leaseToken, {
            status: 'waiting_2fa',
            password_hint: hint?.slice(0, 160) ?? null,
            encrypted_qr_payload: null,
            qr_expires_at: null,
          })
          if (!updated) throw new Error('AUTH_USER_CANCEL')
          return await this.waitForPassword(session.id, leaseToken, session.expires_at)
        },
        onError: async (error) => {
          await this.store.updateTelegramAuthSession(session.id, leaseToken, {
            last_error: safeTelegramError(error),
          })
          return error.message === 'AUTH_USER_CANCEL'
        },
      })
      const label = telegramAccountLabel(user)
      await this.store.completeTelegramAuthSession(
        session.id,
        leaseToken,
        this.connections.encryptTelegramSession(stringSession.save()),
        label,
      )
    } catch (error) {
      await this.store.updateTelegramAuthSession(session.id, leaseToken, {
        status: error instanceof Error && error.message === 'AUTH_USER_CANCEL' ? 'cancelled' : 'failed',
        encrypted_qr_payload: null,
        qr_expires_at: null,
        encrypted_password: null,
        last_error: safeTelegramError(error),
      }).catch(() => undefined)
    } finally {
      await client.disconnect().catch(() => undefined)
    }
  }

  private async waitForPassword(sessionId: string, leaseToken: string, expiresAt: string) {
    let polls = 0
    while (Date.now() < new Date(expiresAt).getTime()) {
      const session = await this.store.getClaimedTelegramAuthSession(sessionId, leaseToken)
      if (!session || session.status === 'cancelled' || session.status === 'expired') throw new Error('AUTH_USER_CANCEL')
      if (session.encrypted_password) {
        const { password } = this.connections.decryptPrivatePayload<{ password: string }>(session.encrypted_password)
        await this.store.updateTelegramAuthSession(sessionId, leaseToken, { encrypted_password: null })
        if (password) return password
      }
      polls += 1
      if (polls % 30 === 0) await this.store.updateTelegramAuthSession(sessionId, leaseToken, {})
      await delay(1_000)
    }
    throw new Error('AUTH_USER_CANCEL')
  }

  private async startLiveConnection(ownerId: string, connectionId: string) {
    const client = await this.connections.connectTelegram(ownerId, connectionId)
    const handler = async (event: NewMessageEvent) => {
      try {
        const normalized = await normalizeTelegramEvent(event)
        if (!normalized) return
        const rules = await this.store.listActiveRulesForConnection(ownerId, connectionId)
        await Promise.all(rules.map((rule) => this.engine.receiveEvent(rule, normalized)))
      } catch (error) {
        const rules = await this.store.listActiveRulesForConnection(ownerId, connectionId).catch(() => [])
        await Promise.all(rules.map((rule) => this.store.recordRuleRun({
          ownerId,
          ruleId: rule.id,
          stage: 'receive',
          outcome: 'failed',
          errorCode: 'telegram_receive_failed',
          errorMessage: safeTelegramError(error),
        }).catch(() => undefined)))
      }
    }
    client.addEventHandler(handler, new NewMessage({}))
    this.clients.set(connectionId, client)
    await this.catchUp(ownerId, connectionId, client)
  }

  private async catchUp(ownerId: string, connectionId: string, client: TelegramClient) {
    const since = Math.floor((Date.now() - 5 * 60_000) / 1000)
    const dialogs = await client.getDialogs({ limit: 50 })
    const rules = await this.store.listActiveRulesForConnection(ownerId, connectionId)
    for (const dialog of dialogs) {
      if (!dialog.entity) continue
      const messages = await client.getMessages(dialog.entity, { limit: 20 })
      for (const message of [...messages].reverse()) {
        if (message.date < since) continue
        const normalized = await normalizeTelegramMessage(message)
        if (!normalized) continue
        await Promise.all(rules.map((rule) => this.engine.receiveEvent(rule, normalized)))
      }
    }
  }
}

async function normalizeTelegramEvent(event: NewMessageEvent) {
  return normalizeTelegramMessage(event.message)
}

export async function normalizeTelegramMessage(message: NewMessageEvent['message']) {
  if (message.out) return null
  const peerClass = message.peerId?.className ?? ''
  if (peerClass.includes('Encrypted')) return null
  const peerId = message.chatId?.toString() ?? message.peerId?.toString()
  if (!peerId) return null
  const text = (message.message ?? '').slice(0, 8_000)
  const media = message.media
  const sender = await message.getSender().catch(() => undefined)
  return {
    id: `${peerId}:${message.id}`,
    provider_event_id: String(message.id),
    occurred_at: new Date(message.date * 1000).toISOString(),
    conversation_key: peerId,
    peer_id: peerId,
    sender_id: message.senderId?.toString() ?? null,
    sender_name: telegramSenderLabel(sender),
    chat_type: message.isPrivate ? 'dm' : message.isGroup ? 'group' : message.isChannel ? 'channel' : 'dm',
    text,
    attachment: media ? {
      type: media.className,
      caption_present: Boolean(text),
      downloaded: false,
    } : null,
  }
}

function telegramSenderLabel(sender: Awaited<ReturnType<NewMessageEvent['message']['getSender']>> | undefined) {
  if (!sender) return 'Telegram contact'
  if ('username' in sender && sender.username) return `@${sender.username}`
  if ('firstName' in sender && sender.firstName) {
    return `${sender.firstName}${'lastName' in sender && sender.lastName ? ` ${sender.lastName}` : ''}`.slice(0, 160)
  }
  if ('title' in sender && sender.title) return String(sender.title).slice(0, 160)
  return 'Telegram contact'
}

function telegramAccountLabel(user: Awaited<ReturnType<TelegramClient['signInUserWithQrCode']>>) {
  if ('username' in user && user.username) return `@${user.username}`
  if ('firstName' in user && user.firstName) return String(user.firstName)
  return 'Telegram account'
}

function safeTelegramError(error: unknown) {
  if (!(error instanceof Error)) return 'Telegram connection failed.'
  return error.message.replace(/[\r\n]+/g, ' ').slice(0, 500)
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export const telegramWorkerId = () => `worker-${randomUUID()}`
