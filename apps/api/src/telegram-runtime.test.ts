import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTelegramMessage } from './telegram-runtime.js'

test('personal Telegram ignores outgoing messages so approved replies cannot retrigger rules', async () => {
  assert.equal(await normalizeTelegramMessage({ out: true } as never), null)
})
