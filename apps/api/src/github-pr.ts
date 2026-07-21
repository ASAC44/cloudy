import type {
  GithubMergeAction,
  GithubMergeMethod,
  GithubPrPresentation,
  GithubPullRequest,
} from './types/github.js'

export type {
  GithubMergeAction,
  GithubMergeMethod,
  GithubPrPresentation,
  GithubPullRequest,
} from './types/github.js'

type Json = Record<string, unknown>

export class GithubApiError extends Error {
  constructor(
    readonly code: 'authentication' | 'permission' | 'rate_limit' | 'not_found' | 'conflict' | 'unavailable' | 'ambiguous',
    message: string = code,
  ) {
    super(message)
  }
}

export class GithubClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  async listRepositories() {
    const repositories: Array<{ full_name: string; private: boolean; default_branch: string }> = []
    for (let page = 1; page <= 3; page += 1) {
      const items = await this.json(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`)
      if (!Array.isArray(items)) throw new GithubApiError('unavailable')
      repositories.push(...items.flatMap((item) => {
        if (!record(item) || typeof item.full_name !== 'string') return []
        return [{
          full_name: item.full_name,
          private: item.private === true,
          default_branch: typeof item.default_branch === 'string' ? item.default_branch : 'main',
        }]
      }))
      if (items.length < 100) break
    }
    return { items: repositories }
  }

  async readyPullRequests(repositories: string[]) {
    if (!repositories.length || repositories.length > 10 || repositories.some((repo) => !repositoryName(repo))) {
      throw new GithubApiError('unavailable', 'Invalid repository scope')
    }
    const groups = await Promise.all(repositories.map(async (repository) => {
      const [owner, repo] = repository.split('/')
      const [repositoryInfo, pulls] = await Promise.all([
        this.json(`/repos/${owner}/${repo}`),
        this.paged(`/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`),
      ])
      if (!record(repositoryInfo) || !Array.isArray(pulls)) throw new GithubApiError('unavailable')
      const viewerCanMerge = record(repositoryInfo.permissions) && repositoryInfo.permissions.push === true
      if (!viewerCanMerge) throw new GithubApiError('permission', `No merge permission for ${repository}`)
      return (await Promise.all(pulls.filter((pull) => record(pull) && pull.draft !== true).map((pull) =>
        this.inspect(repository, Number((pull as Json).number), repositoryInfo),
      ))).filter(isReadyPullRequest)
    }))
    return { items: groups.flat() }
  }

  async inspect(repository: string, number: number, knownRepository?: Json): Promise<GithubPullRequest> {
    const [owner, repo] = repository.split('/')
    if (!repositoryName(repository) || !Number.isInteger(number) || number < 1) throw new GithubApiError('not_found')
    const pull = await this.json(`/repos/${owner}/${repo}/pulls/${number}`)
    if (!record(pull)) throw new GithubApiError('unavailable')
    const repositoryInfo = knownRepository ?? await this.json(`/repos/${owner}/${repo}`)
    if (!record(repositoryInfo)) throw new GithubApiError('unavailable')
    const head = record(pull.head) ? pull.head : {}
    const base = record(pull.base) ? pull.base : {}
    const user = record(pull.user) ? pull.user : {}
    const headSha = string(head.sha)
    const [reviews, checkRuns, statuses, files] = headSha ? await Promise.all([
      this.paged(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`),
      this.json(`/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`),
      this.json(`/repos/${owner}/${repo}/commits/${headSha}/status`),
      this.paged(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`),
    ]) : [[], {}, {}, []]
    const latestReviews = new Map<string, string>()
    if (Array.isArray(reviews)) for (const review of reviews) {
      if (!record(review) || !record(review.user)) continue
      const login = string(review.user.login)
      const state = string(review.state).toUpperCase()
      if (login && state) latestReviews.set(login, state)
    }
    const runs = record(checkRuns) && Array.isArray(checkRuns.check_runs) ? checkRuns.check_runs : []
    const contexts = record(statuses) && Array.isArray(statuses.statuses) ? statuses.statuses : []
    const passedRuns = runs.filter((run) => record(run) && ['success', 'neutral', 'skipped'].includes(string(run.conclusion))).length
    const passedContexts = contexts.filter((status) => record(status) && status.state === 'success').length
    const mergeMethod = chooseMergeMethod({
      squash: repositoryInfo.allow_squash_merge === true,
      rebase: repositoryInfo.allow_rebase_merge === true,
      merge: repositoryInfo.allow_merge_commit === true,
    })
    return {
      event_identity: `${repository}#${number}@${headSha}`,
      conversation_key: `${repository}#${number}`,
      repository,
      number,
      title: clip(string(pull.title), 240),
      body: clip(string(pull.body), 4_000),
      author: clip(string(user.login) || 'unknown', 80),
      head_branch: clip(string(head.ref), 200),
      base_branch: clip(string(base.ref), 200),
      head_sha: headSha,
      updated_at: string(pull.updated_at) || new Date().toISOString(),
      additions: integer(pull.additions),
      deletions: integer(pull.deletions),
      changed_files: integer(pull.changed_files),
      files: Array.isArray(files) ? files.flatMap((file) => record(file) && typeof file.filename === 'string' ? [clip(file.filename, 300)] : []).slice(0, 100) : [],
      checks_passed: passedRuns + passedContexts,
      checks_total: runs.length + contexts.length,
      approvals: [...latestReviews.values()].filter((state) => state === 'APPROVED').length,
      mergeable: pull.mergeable === true,
      merge_state: string(pull.mergeable_state),
      merge_method: mergeMethod,
      viewer_can_merge: record(repositoryInfo.permissions) && repositoryInfo.permissions.push === true,
      merged: pull.merged === true,
    }
  }

  async merge(action: GithubMergeAction) {
    const current = await this.inspect(action.repository, action.number)
    if (current.merged) {
      if (current.head_sha === action.head_sha) return { merged: true, sha: current.head_sha }
      throw new GithubApiError('conflict', 'A different pull request commit was merged')
    }
    if (current.head_sha !== action.head_sha || !isReadyPullRequest(current) || current.merge_method !== action.merge_method) {
      throw new GithubApiError('conflict', 'Pull request changed after approval')
    }
    const [owner, repo] = action.repository.split('/')
    let result: unknown
    try {
      result = await this.json(`/repos/${owner}/${repo}/pulls/${action.number}/merge`, {
        method: 'PUT',
        body: JSON.stringify({ sha: action.head_sha, merge_method: action.merge_method }),
      })
    } catch (error) {
      if (!(error instanceof GithubApiError) || error.code !== 'ambiguous') throw error
      let reconciled: GithubPullRequest
      try {
        reconciled = await this.inspect(action.repository, action.number)
      } catch (reconcileError) {
        if (reconcileError instanceof GithubApiError
          && ['authentication', 'permission'].includes(reconcileError.code)) throw reconcileError
        throw error
      }
      if (reconciled.merged && reconciled.head_sha === action.head_sha) {
        return { merged: true, sha: action.head_sha }
      }
      if (reconciled.head_sha === action.head_sha && isReadyPullRequest(reconciled)) {
        throw new GithubApiError('unavailable', 'Merge result was uncertain; retrying the exact commit')
      }
      if (reconciled.head_sha !== action.head_sha || !isReadyPullRequest(reconciled)) {
        throw new GithubApiError('conflict', 'Pull request changed after approval')
      }
      throw error
    }
    if (!record(result) || result.merged !== true) throw new GithubApiError('conflict', string(record(result) ? result.message : 'Merge failed'))
    return { merged: true, sha: string(result.sha) }
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(`https://api.github.com${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10',
          ...init?.headers,
        },
        redirect: 'manual',
        signal: init?.signal ?? AbortSignal.timeout(15_000),
      })
    } catch (error) {
      if (error instanceof GithubApiError) throw error
      throw new GithubApiError('ambiguous')
    }
    if (response.status === 401) throw new GithubApiError('authentication')
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') throw new GithubApiError('rate_limit')
    if (response.status === 403) throw new GithubApiError('permission')
    if (response.status === 404) throw new GithubApiError('not_found')
    if ([405, 409, 422].includes(response.status)) throw new GithubApiError('conflict')
    if (!response.ok) throw new GithubApiError(response.status >= 500 ? 'unavailable' : 'ambiguous')
    return await response.json()
  }

  private async paged(path: string, maxPages = 3) {
    const items: unknown[] = []
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.json(`${path}&page=${page}`)
      if (!Array.isArray(result)) throw new GithubApiError('unavailable')
      items.push(...result)
      if (result.length < 100) break
    }
    return items
  }
}

export function chooseMergeMethod(allowed: { squash: boolean; rebase: boolean; merge: boolean }): GithubMergeMethod {
  if (allowed.squash) return 'squash'
  if (allowed.rebase) return 'rebase'
  if (allowed.merge) return 'merge'
  throw new GithubApiError('conflict', 'Repository does not allow merging')
}

export function isReadyPullRequest(pull: GithubPullRequest) {
  return !pull.merged && pull.mergeable && pull.merge_state === 'clean' && pull.viewer_can_merge
}

export function factOnlyPresentation(pull: GithubPullRequest, aiAvailable = false, expiresAt?: string): GithubPrPresentation {
  const checks = pull.checks_total ? `${pull.checks_passed}/${pull.checks_total}` : 'None'
  return {
    kind: 'github_pr_v1',
    context: `${pull.repository} · ${pull.head_branch} → ${pull.base_branch}`,
    facts: [
      ['AUTHOR', pull.author],
      ['FILES', String(pull.changed_files)],
      ['DIFF', `+${pull.additions}/-${pull.deletions}`],
      ['CHECKS', checks],
      ['REVIEWS', String(pull.approvals)],
      ['AREA', pull.repository.split('/').at(-1) ?? pull.repository],
      ['MERGE', title(pull.merge_method)],
      ['EXPIRES', expiresAt ? `${expiresAt.slice(11, 16)} UTC` : '15m after request'],
    ],
    summary: `PR #${pull.number} changes ${pull.changed_files} files with +${pull.additions}/-${pull.deletions}. GitHub reports it is mergeable, required checks and reviews are satisfied, and ${pull.merge_method} merge is available.`,
    glance_details: [
      ['SAFETY', 'Exact reviewed commit SHA required at merge time'],
      ['ROLLBACK', 'Revert the resulting merge commit if needed'],
      ['OWNER', `${pull.author} · ${pull.repository}`],
      ['MONITOR', 'CI, deployment, errors, and user impact'],
    ],
    details: [
      ['DECISION REQUESTED', `Allow PR #${pull.number} to ${pull.merge_method}-merge into ${pull.base_branch}.`],
      ['CURRENT BEHAVIOR', 'The pull request is open and has not been merged.'],
      ['PROPOSED CHANGE', pull.body || pull.title],
      ['END-TO-END FLOW', `Merge ${pull.head_branch} at ${pull.head_sha.slice(0, 12)} into ${pull.base_branch}.`],
      ['SYSTEMS AND DATA', pull.files.length ? `Changed paths include ${pull.files.slice(0, 12).join(', ')}.` : `${pull.changed_files} files changed.`],
      ['CUSTOMER IMPACT', 'No verified customer-impact description was provided.'],
      ['FAILURE MODES', 'A new commit, failed check, closed PR, or lost merge permission prevents delivery.'],
      ['REVIEW EVIDENCE', `${checks} checks passed; ${pull.approvals} approving review${pull.approvals === 1 ? '' : 's'}; GitHub merge state is clean.`],
      ['SAFETY AND ROLLBACK', 'Cloudy revalidates the exact head SHA immediately before merging. Revert the merge commit to roll back.'],
      ['AFTER MERGE', 'Monitor CI, deployments, errors, and the behavior affected by the changed files.'],
    ],
    ai_available: aiAvailable,
  }
}

function repositoryName(value: string) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
}

function record(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function integer(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function clip(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max)
}

function title(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
