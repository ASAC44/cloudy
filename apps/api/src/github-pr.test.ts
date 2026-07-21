import assert from 'node:assert/strict'
import test from 'node:test'

import { GithubApiError, GithubClient, chooseMergeMethod, factOnlyPresentation, isReadyPullRequest } from './github-pr.js'

const repository = {
  allow_squash_merge: true,
  allow_rebase_merge: true,
  allow_merge_commit: true,
  permissions: { push: true },
}

const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  title: 'Retry failed payments',
  body: 'Adds bounded payment retries.',
  draft: false,
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  updated_at: '2026-07-19T18:00:00Z',
  additions: 184,
  deletions: 39,
  changed_files: 14,
  user: { login: 'vimzh' },
  head: { sha: 'a'.repeat(40), ref: 'feature/payment-retries' },
  base: { ref: 'main' },
  ...overrides,
})

function githubFetch(options: { merge?: 'success' | 'timeout'; mergedAfterTimeout?: boolean } = {}): typeof fetch {
  let mergeAttempted = false
  return (async (input, init) => {
    const url = new URL(String(input))
    const path = `${url.pathname}${url.search}`
    if (init?.method === 'PUT' && url.pathname.endsWith('/merge')) {
      mergeAttempted = true
      if (options.merge === 'timeout') throw new TypeError('socket closed')
      return Response.json({ merged: true, sha: 'b'.repeat(40) })
    }
    if (url.pathname === '/repos/cloudy/api') return Response.json(repository)
    if (url.pathname === '/repos/cloudy/api/pulls/42') {
      return Response.json(pull({ merged: options.mergedAfterTimeout === true && mergeAttempted }))
    }
    if (url.pathname.endsWith('/reviews')) return Response.json([
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } },
      { state: 'APPROVED', user: { login: 'reviewer' } },
    ])
    if (url.pathname.endsWith('/check-runs')) return Response.json({
      check_runs: [{ conclusion: 'success' }, { conclusion: 'skipped' }],
    })
    if (url.pathname.endsWith('/status')) return Response.json({ statuses: [{ state: 'success' }] })
    if (url.pathname.endsWith('/files')) return Response.json([{ filename: 'src/payments.ts' }])
    if (url.pathname.endsWith('/pulls')) return Response.json([pull()])
    throw new Error(`Unexpected GitHub request: ${path}`)
  }) as typeof fetch
}

test('GitHub readiness preserves authoritative facts and squash-preferred merge selection', async () => {
  assert.equal(chooseMergeMethod({ squash: true, rebase: true, merge: true }), 'squash')
  assert.equal(chooseMergeMethod({ squash: false, rebase: true, merge: true }), 'rebase')
  assert.equal(chooseMergeMethod({ squash: false, rebase: false, merge: true }), 'merge')

  const result = await new GithubClient('secret-token', githubFetch()).readyPullRequests(['cloudy/api'])
  assert.equal(result.items.length, 1)
  const item = result.items[0]
  assert.equal(item.event_identity, `cloudy/api#42@${'a'.repeat(40)}`)
  assert.equal(item.conversation_key, 'cloudy/api#42')
  assert.equal(item.checks_passed, 3)
  assert.equal(item.checks_total, 3)
  assert.equal(item.approvals, 1)
  assert.equal(item.merge_method, 'squash')
  assert.equal(isReadyPullRequest(item), true)
  const presentation = factOnlyPresentation(item)
  assert.equal(presentation.kind, 'github_pr_v1')
  assert.match(presentation.summary, /14 files/)
  assert.doesNotMatch(JSON.stringify(presentation), /secret-token/)
})

test('GitHub repository scope and permissions fail closed', async () => {
  await assert.rejects(() => new GithubClient('token', githubFetch()).readyPullRequests([]), GithubApiError)
  const denied = githubFetch()
  const client = new GithubClient('token', (async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/repos/cloudy/api') return Response.json({ ...repository, permissions: { push: false } })
    return denied(input, init)
  }) as typeof fetch)
  await assert.rejects(() => client.readyPullRequests(['cloudy/api']), (error: unknown) =>
    error instanceof GithubApiError && error.code === 'permission')
})

test('repository discovery paginates and rate-limit errors redact response bodies', async () => {
  const pages: number[] = []
  const client = new GithubClient('token', (async (input) => {
    const url = new URL(String(input))
    const page = Number(url.searchParams.get('page'))
    pages.push(page)
    const count = page === 1 ? 100 : 1
    return Response.json(Array.from({ length: count }, (_, index) => ({
      full_name: `owner/repo-${page}-${index}`, private: false, default_branch: 'main',
    })))
  }) as typeof fetch)
  assert.equal((await client.listRepositories()).items.length, 101)
  assert.deepEqual(pages, [1, 2])

  const limited = new GithubClient('token', (async () => new Response(
    JSON.stringify({ message: 'secret provider response' }),
    { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
  )) as typeof fetch)
  await assert.rejects(() => limited.listRepositories(), (error: unknown) =>
    error instanceof GithubApiError && error.code === 'rate_limit' && !error.message.includes('secret'))
})

test('merge sends the reviewed SHA and reconciles an uncertain completed response', async () => {
  const calls: string[] = []
  const base = githubFetch({ merge: 'timeout', mergedAfterTimeout: true })
  const client = new GithubClient('token', (async (input, init) => {
    if (init?.method === 'PUT') calls.push(String(init.body))
    return base(input, init)
  }) as typeof fetch)
  const result = await client.merge({
    repository: 'cloudy/api', number: 42,
    head_sha: 'a'.repeat(40), merge_method: 'squash',
  })
  assert.equal(result.merged, true)
  assert.deepEqual(JSON.parse(calls[0]), { sha: 'a'.repeat(40), merge_method: 'squash' })
})

test('changed SHA can never be merged', async () => {
  const client = new GithubClient('token', githubFetch())
  await assert.rejects(() => client.merge({
    repository: 'cloudy/api', number: 42,
    head_sha: 'c'.repeat(40), merge_method: 'squash',
  }), (error: unknown) => error instanceof GithubApiError && error.code === 'conflict')
})
