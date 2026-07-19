import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { AppServer, Bridge, approvalResult, compatibleVersion, requestKind } from '../src/bridge.js'

test('Codex version compatibility is monotonic', () => {
  assert.equal(compatibleVersion('codex-cli 0.144.5'), true)
  assert.equal(compatibleVersion('codex-cli 0.145.0'), true)
  assert.equal(compatibleVersion('codex-cli 0.143.9'), false)
})

test('approval protocol maps only one-shot accept and decline', () => {
  assert.deepEqual(approvalResult('item/commandExecution/requestApproval', true, {}), { decision: 'accept' })
  assert.deepEqual(approvalResult('item/fileChange/requestApproval', false, {}), { decision: 'decline' })
  assert.equal(requestKind('item/permissions/requestApproval'), 'permission_approval')
})

test('JSONL app-server initializes, ignores malformed lines, and completes calls', async () => {
  const notifications = []
  const fixture = fileURLToPath(new URL('./fixtures/fake-codex.js', import.meta.url))
  const app = new AppServer(async () => {}, async (message) => notifications.push(message.method), process.execPath, [fixture])
  await app.start()
  const result = await app.call('thread/list', { cwd: '/tmp' })
  app.stop()
  assert.deepEqual(result, { data: [] })
  assert.deepEqual(notifications, ['bridge/ready'])
})

test('a lost acknowledgement retries without creating a duplicate Codex session', async () => {
  const command = { id: 'command-1', kind: 'new_thread', workspace_id: 'remote-workspace', thread_id: null, idempotency_key: 'prompt-1', payload: {} }
  let ackAttempts = 0
  const api = { request: async (method, path, _body, headers) => {
    if (method === 'GET') { assert.ok(headers['X-Podex-Bridge-Instance']); return { command } }
    ackAttempts += 1
    if (ackAttempts === 1) throw new Error('response lost')
    return { ok: true }
  } }
  const calls = []
  const app = { call: async (method, params) => { calls.push({ method, params }); return { thread: { id: 'thread-1' } } }, stop() {} }
  const bridge = new Bridge({ workspaces: [{ id: 'local-workspace', label: 'Repo', path: '/tmp' }] }, { api, app })
  bridge.remoteWorkspaces.set('remote-workspace', { id: 'remote-workspace', local_id: 'local-workspace' })
  await assert.rejects(bridge.poll(), /response lost/)
  await bridge.poll()
  assert.equal(calls.filter(({ method }) => method === 'thread/start').length, 1)
  assert.equal(ackAttempts, 2)
})

test('new prompts always begin with a read-only planning turn', async () => {
  const calls = []
  const app = { call: async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/start') return { thread: { id: 'thread-2' } }
    return { turn: { id: 'turn-2' } }
  }, stop() {} }
  const bridge = new Bridge({ workspaces: [{ id: 'local-workspace', label: 'Repo', path: '/tmp' }] }, { api: {}, app })
  bridge.remoteWorkspaces.set('remote-workspace', { id: 'remote-workspace', local_id: 'local-workspace' })
  await bridge.prompt({ workspace_id: 'remote-workspace', thread_id: null, idempotency_key: 'message-1', payload: { prompt: 'Add a health check' } })
  const turn = calls.find(({ method }) => method === 'turn/start')
  assert.equal(turn.params.sandboxPolicy.type, 'readOnly')
  assert.equal(turn.params.sandboxPolicy.networkAccess, false)
  assert.match(turn.params.input[0].text, /without editing files/)
})

test('approved plans use workspace-write without network or full access', async () => {
  let turn
  const app = { call: async (method, params) => { if (method === 'turn/start') turn = params; return {} }, stop() {} }
  const bridge = new Bridge({ workspaces: [], threads: [] }, { api: {}, app })
  await bridge.implement({ threadId: 'thread-3', cwd: '/tmp' })
  assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['/tmp'], networkAccess: false })
  assert.equal(turn.approvalPolicy, 'on-request')
  assert.equal(turn.approvalsReviewer, 'user')
})
