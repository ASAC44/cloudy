import assert from 'node:assert/strict'
import test from 'node:test'

import { gmailReplyRaw } from './connections.js'

test('Gmail reply binds the approved text to the original thread headers', () => {
  const raw = gmailReplyRaw('thread-1', 'Exact approved reply.', {
    messages: [{ payload: { headers: [
      { name: 'From', value: 'Ava <ava@example.com>' },
      { name: 'Subject', value: 'Project review' },
      { name: 'Message-ID', value: '<original@example.com>' },
    ] } }],
  })

  assert.match(raw, /^To: Ava <ava@example.com>\r\nSubject: Re: Project review/m)
  assert.match(raw, /In-Reply-To: <original@example.com>/)
  assert.ok(raw.endsWith('\r\n\r\nExact approved reply.'))
  assert.equal(gmailReplyRaw('thread-1', 'Exact approved reply.', { messages: [{ payload: { headers: [
    { name: 'From', value: 'Ava <ava@example.com>' }, { name: 'Message-ID', value: '<original@example.com>' },
  ] } }] }), gmailReplyRaw('thread-1', 'Exact approved reply.', { messages: [{ payload: { headers: [
    { name: 'From', value: 'Ava <ava@example.com>' }, { name: 'Message-ID', value: '<original@example.com>' },
  ] } }] }))
})
