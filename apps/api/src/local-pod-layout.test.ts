import assert from 'node:assert/strict'
import test from 'node:test'

import { LocalPodLayoutStore } from './local-pod-layout.js'
import { StoreError } from './store.js'

test('local Pod layouts persist and reject stale revisions atomically', () => {
  const store = new LocalPodLayoutStore(':memory:')
  const initial = store.get('pod-1')
  const layout = { ...initial.layout, left: ['app:vercel'] }

  assert.equal(initial.revision, 0)
  assert.equal(store.update('pod-1', 0, layout).revision, 1)
  assert.deepEqual(store.get('pod-1'), { layout, revision: 1 })
  assert.throws(() => store.update('pod-1', 0, initial.layout), (error) => error instanceof StoreError && error.code === 'pod_layout_conflict')
  assert.deepEqual(store.get('pod-1'), { layout, revision: 1 })
  assert.throws(
    () => store.update('pod-1', 1, { ...layout, left: ['app:github', 'app:vercel'] }),
    (error) => error instanceof StoreError && error.code === 'invalid_pod_layout',
  )
})
