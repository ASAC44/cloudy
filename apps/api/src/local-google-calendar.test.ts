import assert from 'node:assert/strict'
import test from 'node:test'

import { LocalGoogleCalendarStore } from './local-google-calendar.js'

test('local Google Calendar OAuth is one-shot and connection writes are owner-scoped', () => {
  const store = new LocalGoogleCalendarStore(':memory:')
  const oauth = {
    ownerId: 'owner-1', provider: 'google_calendar' as const, connectionName: 'Calendar',
    connectionId: null, codeVerifier: 'verifier',
  }
  store.createOAuthState('state', oauth, new Date(Date.now() + 60_000).toISOString())
  assert.deepEqual(store.consumeOAuthState('state'), oauth)
  assert.equal(store.consumeOAuthState('state'), null)

  const connection = store.create('owner-1', {
    name: 'Calendar', provider: 'google_calendar', protocol: 'rest',
    endpoint_url: 'https://www.googleapis.com/calendar/v3', auth_type: 'oauth',
  }, 'encrypted')
  assert.equal(store.get('owner-2', connection.id), null)
  assert.equal(store.setTest('owner-1', connection.id, { status: 'connected', accountLabel: 'Primary', error: null })?.status, 'connected')
  store.updateSecret(connection.id, 'refreshed')
  assert.equal(store.get('owner-1', connection.id)?.encrypted_payload, 'refreshed')
  assert.equal(store.delete('owner-2', connection.id), false)
  assert.equal(store.delete('owner-1', connection.id), true)
})
