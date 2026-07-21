import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { StoreError } from './store.js'
import type { Connection, NewConnection, OAuthState, StoredConnection } from './types/store.js'

type ConnectionRow = Omit<StoredConnection, 'provider' | 'protocol' | 'auth_type' | 'status'> & {
  provider: 'google_calendar'
  protocol: 'rest'
  auth_type: 'oauth'
  status: Connection['status']
}

export class LocalGoogleCalendarStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`
      pragma foreign_keys = on;
      pragma journal_mode = wal;
      create table if not exists local_google_calendar_connections (
        id text primary key,
        owner_id text not null,
        name text not null,
        provider text not null check (provider = 'google_calendar'),
        protocol text not null check (protocol = 'rest'),
        endpoint_url text not null,
        auth_type text not null check (auth_type = 'oauth'),
        status text not null check (status in ('untested', 'connected', 'failed')),
        account_label text,
        last_error text,
        last_tested_at text,
        created_at text not null,
        updated_at text not null,
        encrypted_payload text not null,
        unique (owner_id, name)
      ) strict;
      create index if not exists local_google_calendar_connections_owner
        on local_google_calendar_connections(owner_id, created_at);
      create table if not exists local_google_calendar_oauth_states (
        state_hash text primary key,
        owner_id text not null,
        provider text not null check (provider = 'google_calendar'),
        connection_name text not null,
        connection_id text references local_google_calendar_connections(id) on delete set null,
        code_verifier text not null,
        expires_at text not null
      ) strict;
      create index if not exists local_google_calendar_oauth_expiry
        on local_google_calendar_oauth_states(expires_at);
    `)
  }

  list(ownerId: string) {
    return this.db.prepare(`
      select id, name, provider, protocol, endpoint_url, auth_type, status, account_label,
        last_error, last_tested_at, created_at, updated_at
      from local_google_calendar_connections where owner_id = ? order by created_at
    `).all(ownerId) as Connection[]
  }

  get(ownerId: string, connectionId: string) {
    return (this.db.prepare(`
      select id, name, provider, protocol, endpoint_url, auth_type, status, account_label,
        last_error, last_tested_at, created_at, updated_at, encrypted_payload
      from local_google_calendar_connections where owner_id = ? and id = ?
    `).get(ownerId, connectionId) as ConnectionRow | undefined) ?? null
  }

  has(connectionId: string) {
    return Boolean(this.db.prepare('select 1 from local_google_calendar_connections where id = ?').get(connectionId))
  }

  create(ownerId: string, connection: NewConnection, encryptedPayload: string) {
    const id = randomUUID()
    const now = new Date().toISOString()
    try {
      this.db.prepare(`
        insert into local_google_calendar_connections(
          id, owner_id, name, provider, protocol, endpoint_url, auth_type, status,
          created_at, updated_at, encrypted_payload
        ) values (?, ?, ?, 'google_calendar', 'rest', ?, 'oauth', 'untested', ?, ?, ?)
      `).run(id, ownerId, connection.name, connection.endpoint_url, now, now, encryptedPayload)
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) throw new StoreError('connection_name_exists')
      throw error
    }
    return this.get(ownerId, id)!
  }

  update(ownerId: string, connectionId: string, name: string | undefined, encryptedPayload?: string) {
    const now = new Date().toISOString()
    try {
      this.db.prepare(`
        update local_google_calendar_connections
        set name = coalesce(?, name), encrypted_payload = coalesce(?, encrypted_payload),
          status = 'untested', account_label = null, last_error = null, last_tested_at = null, updated_at = ?
        where owner_id = ? and id = ?
      `).run(name ?? null, encryptedPayload ?? null, now, ownerId, connectionId)
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) throw new StoreError('connection_name_exists')
      throw error
    }
    return this.get(ownerId, connectionId)
  }

  updateSecret(connectionId: string, encryptedPayload: string) {
    this.db.prepare('update local_google_calendar_connections set encrypted_payload = ?, updated_at = ? where id = ?')
      .run(encryptedPayload, new Date().toISOString(), connectionId)
  }

  setTest(ownerId: string, connectionId: string, result: {
    status: 'connected' | 'failed'
    accountLabel: string | null
    error: string | null
    encryptedPayload?: string
  }) {
    const now = new Date().toISOString()
    this.db.prepare(`
      update local_google_calendar_connections
      set status = ?, account_label = ?, last_error = ?, last_tested_at = ?, updated_at = ?,
        encrypted_payload = coalesce(?, encrypted_payload)
      where owner_id = ? and id = ?
    `).run(result.status, result.accountLabel, result.error, now, now, result.encryptedPayload ?? null, ownerId, connectionId)
    return this.get(ownerId, connectionId)
  }

  delete(ownerId: string, connectionId: string) {
    return this.db.prepare('delete from local_google_calendar_connections where owner_id = ? and id = ?')
      .run(ownerId, connectionId).changes > 0
  }

  createOAuthState(stateHash: string, state: OAuthState, expiresAt: string) {
    this.db.exec('begin immediate')
    try {
      this.db.prepare('delete from local_google_calendar_oauth_states where expires_at <= ?').run(new Date().toISOString())
      this.db.prepare(`
        insert into local_google_calendar_oauth_states(
          state_hash, owner_id, provider, connection_name, connection_id, code_verifier, expires_at
        ) values (?, ?, 'google_calendar', ?, ?, ?, ?)
      `).run(stateHash, state.ownerId, state.connectionName, state.connectionId, state.codeVerifier, expiresAt)
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }

  consumeOAuthState(stateHash: string) {
    this.db.exec('begin immediate')
    try {
      const row = this.db.prepare(`
        select owner_id, provider, connection_name, connection_id, code_verifier
        from local_google_calendar_oauth_states where state_hash = ? and expires_at > ?
      `).get(stateHash, new Date().toISOString()) as {
        owner_id: string
        provider: 'google_calendar'
        connection_name: string
        connection_id: string | null
        code_verifier: string
      } | undefined
      if (row) this.db.prepare('delete from local_google_calendar_oauth_states where state_hash = ?').run(stateHash)
      this.db.exec('commit')
      return row ? {
        ownerId: row.owner_id,
        provider: row.provider,
        connectionName: row.connection_name,
        connectionId: row.connection_id,
        codeVerifier: row.code_verifier,
      } satisfies OAuthState : null
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }
}
