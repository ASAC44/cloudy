export type GithubMergeMethod = 'squash' | 'rebase' | 'merge'

export type GithubPullRequest = {
  event_identity: string
  conversation_key: string
  repository: string
  number: number
  title: string
  body: string
  author: string
  head_branch: string
  base_branch: string
  head_sha: string
  updated_at: string
  additions: number
  deletions: number
  changed_files: number
  files: string[]
  checks_passed: number
  checks_total: number
  approvals: number
  mergeable: boolean
  merge_state: string
  merge_method: GithubMergeMethod
  viewer_can_merge: boolean
  merged: boolean
  state: 'open' | 'closed'
  ready_to_merge: boolean
}

export type GithubMergeAction = {
  repository: string
  number: number
  head_sha: string
  merge_method: GithubMergeMethod
}

export type GithubPrPresentation = {
  kind: 'github_pr_v1'
  context: string
  facts: Array<[string, string]>
  summary: string
  glance_details: Array<[string, string]>
  details: Array<[string, string]>
  ai_available: boolean
}
