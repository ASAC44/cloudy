import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'

export const MIN_CODEX_VERSION = [0, 144, 5]

export function compatibleVersion(value) {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return false
  const actual = match.slice(1).map(Number)
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== MIN_CODEX_VERSION[index]) return actual[index] > MIN_CODEX_VERSION[index]
  }
  return true
}

export class CloudyApi {
  constructor(baseUrl, token = null, fetcher = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.token = token
    this.fetcher = fetcher
  }

  async request(method, path, body, extraHeaders = {}) {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: { Accept: 'application/json', ...extraHeaders, ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const result = response.status === 204 ? {} : await response.json()
    if (!response.ok) throw new Error(result.error || `Cloudy returned ${response.status}`)
    return result
  }
}

export class AppServer {
  constructor(onRequest, onNotification, command = 'codex', args = null, onExit = () => {}) {
    this.onRequest = onRequest
    this.onNotification = onNotification
    this.command = command
    this.args = args
    this.onExit = onExit
    this.nextId = 1
    this.pending = new Map()
  }

  async start() {
    this.process = spawn(this.command, this.args || ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'inherit'] })
    this.process.once('exit', (code) => {
      const error = new Error(`codex app-server exited (${code ?? 'signal'})`)
      this.failAll(error)
      if (!this.stopping) this.onExit(error)
    })
    createInterface({ input: this.process.stdout }).on('line', (line) => this.receive(line))
    await this.call('initialize', { clientInfo: { name: 'cloudy_bridge', title: 'Cloudy Bridge', version: '0.1.0' } })
    this.notify('initialized', {})
  }

  receive(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const waiter = this.pending.get(String(message.id))
      if (!waiter) return
      this.pending.delete(String(message.id))
      message.error ? waiter.reject(new Error(message.error.message || 'Codex request failed')) : waiter.resolve(message.result)
    } else if (message.id !== undefined) {
      void this.onRequest(message)
    } else if (message.method) {
      void this.onNotification(message)
    }
  }

  call(method, params) {
    const id = this.nextId++
    this.write({ method, id, params })
    return new Promise((resolve, reject) => this.pending.set(String(id), { resolve, reject }))
  }

  notify(method, params) { this.write({ method, params }) }
  respond(id, result) { this.write({ id, result }) }
  write(message) { this.process.stdin.write(`${JSON.stringify(message)}\n`) }
  stop() { this.stopping = true; this.process?.kill('SIGTERM') }
  failAll(error) { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear() }
}

export class Bridge {
  constructor(config, options = {}) {
    this.config = config
    this.config.threads ||= []
    this.onConfigChange = options.onConfigChange || (async () => {})
    this.api = options.api || new CloudyApi(config.apiUrl, config.token)
    this.processInstanceId = randomUUID()
    this.pendingApprovals = new Map()
    this.pendingInteractions = new Map()
    this.completedCommands = new Set()
    this.plans = new Map()
    this.threadModes = new Map()
    this.threads = new Map()
    this.remoteWorkspaces = new Map()
    this.remoteThreads = new Map()
    this.app = options.app || new AppServer(
      async (message) => {
        try { await this.handleServerRequest(message) }
        catch (error) { this.lastError = error.message; this.app.respond(message.id, approvalResult(message.method, false, message.params || {})) }
      },
      async (message) => {
        try { await this.handleNotification(message) }
        catch (error) { this.lastError = error.message }
      },
      config.codexBin || 'codex',
      null,
      (error) => { this.lastError = error.message; this.running = false; void this.sync().catch(() => {}) },
    )
    this.running = false
  }

  version() {
    const result = spawnSync(this.config.codexBin || 'codex', ['--version'], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error('Codex CLI is not installed or is not executable')
    const version = result.stdout.trim()
    if (!compatibleVersion(version)) throw new Error(`Codex ${MIN_CODEX_VERSION.join('.')} or newer is required; found ${version}`)
    return version
  }

  async start() {
    try {
      this.codexVersion = this.version()
    } catch (error) {
      this.codexVersion = spawnSync(this.config.codexBin || 'codex', ['--version'], { encoding: 'utf8' }).stdout.trim() || 'unavailable'
      this.lastError = error.message
      await this.sync()
      throw error
    }
    this.running = true
    await this.app.start()
    await this.refreshThreads()
    await this.sync()
    while (this.running) {
      try {
        await this.poll()
        await this.sync()
      } catch (error) {
        this.lastError = error.message
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }

  stop() { this.running = false; this.app.stop() }

  async refreshThreads() {
    const previous = this.threads
    this.threads = new Map()
    for (const workspace of this.config.workspaces) {
      const result = await this.app.call('thread/list', { cwd: workspace.path, limit: 100 })
      for (const thread of result.data || []) {
        if (!this.config.threads.some((managed) => managed.id === thread.id && managed.workspaceId === workspace.id)) continue
        this.threads.set(thread.id, {
          workspaceLocalId: workspace.id,
          codexThreadId: thread.id,
          title: thread.name || thread.preview || 'Codex session',
          status: previous.get(thread.id)?.status || 'idle',
          milestone: previous.get(thread.id)?.milestone || '',
          finalSummary: previous.get(thread.id)?.finalSummary || '',
          error: null,
        })
      }
    }
  }

  async sync() {
    const result = await this.api.request('POST', '/v1/codex/bridge/sync', {
      version: this.codexVersion,
      process_instance_id: this.processInstanceId,
      error: dashboardError(this.lastError),
      workspaces: this.config.workspaces.map((workspace) => ({ localId: workspace.id, label: workspace.label })),
      threads: [...this.threads.values()],
    })
    this.remoteWorkspaces = new Map((result.workspaces || []).map((workspace) => [workspace.id, workspace]))
    this.remoteThreads = new Map((result.threads || []).map((thread) => [thread.id, thread]))
    this.lastError = null
    await this.flushInteractions()
  }

  workspace(remoteId) {
    const remote = this.remoteWorkspaces.get(remoteId)
    const local = this.config.workspaces.find((workspace) => workspace.id === remote?.local_id)
    if (!local) throw new Error('Selected workspace is not available on this bridge')
    return local
  }

  localThread(remoteId) {
    const remote = remoteId ? this.remoteThreads.get(remoteId) : null
    return remote?.codex_thread_id || null
  }

  async poll() {
    this.expireLocalInteractions()
    const instanceHeader = { 'X-Cloudy-Bridge-Instance': this.processInstanceId }
    const { command } = await this.api.request('GET', '/v1/codex/bridge/commands', undefined, instanceHeader)
    if (!command) return
    try {
      if (!this.completedCommands.has(command.id)) await this.execute(command)
      this.completedCommands.add(command.id)
    } catch (error) {
      this.lastError = error.message
      await this.api.request('POST', `/v1/codex/bridge/commands/${command.id}/ack`, { ok: false, error: dashboardError(error.message) }, instanceHeader)
      return
    }
    await this.api.request('POST', `/v1/codex/bridge/commands/${command.id}/ack`, { ok: true }, instanceHeader)
    this.completedCommands.delete(command.id)
  }

  async execute(command) {
    if (command.kind === 'new_thread') {
      const workspace = this.workspace(command.workspace_id)
      const result = await this.app.call('thread/start', { cwd: workspace.path, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' })
      this.threads.set(result.thread.id, { workspaceLocalId: workspace.id, codexThreadId: result.thread.id, title: 'New Codex session', status: 'idle', milestone: 'Ready for a voice task', finalSummary: '', error: null })
      await this.rememberThread(result.thread.id, workspace.id)
      return
    }
    if (command.kind === 'prompt') return this.prompt(command)
    if (command.kind !== 'decision') return
    const protocolId = String(command.payload.protocol_request_id)
    if (command.payload.kind === 'plan_review') {
      const plan = this.plans.get(protocolId)
      if (command.payload.outcome === 'approved' && !plan) throw new Error('The reviewed Codex plan expired locally')
      if (command.payload.outcome === 'approved' && plan) {
        if (repositoryStateId(plan.cwd) !== plan.repositoryState) {
          const thread = this.threads.get(plan.threadId)
          if (thread) { thread.status = 'error'; thread.error = 'Repository changed after plan review'; thread.milestone = 'Plan is stale—dictate the task again' }
          throw new Error('Repository changed after the reviewed plan was sealed')
        }
        await this.implement(plan)
      }
      this.plans.delete(protocolId)
      return
    }
    const pending = this.pendingApprovals.get(protocolId)
    if (!pending) throw new Error('The Codex approval belongs to a previous bridge process')
    const accepted = command.payload.outcome === 'approved'
    this.app.respond(pending.message.id, approvalResult(pending.message.method, accepted, pending.message.params))
    this.pendingApprovals.delete(protocolId)
  }

  async prompt(command) {
    const workspace = this.workspace(command.workspace_id)
    let threadId = this.localThread(command.thread_id)
    if (!threadId) {
      const started = await this.app.call('thread/start', { cwd: workspace.path, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' })
      threadId = started.thread.id
      this.threads.set(threadId, { workspaceLocalId: workspace.id, codexThreadId: threadId, title: String(command.payload.prompt).slice(0, 100), status: 'idle', milestone: '', finalSummary: '', error: null })
      await this.rememberThread(threadId, workspace.id)
    } else if (!this.threadModes.has(threadId)) {
      await this.app.call('thread/resume', { threadId, cwd: workspace.path, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' })
      this.threadModes.set(threadId, 'idle')
    }
    const active = this.threads.get(threadId)
    if (active?.activeTurnId) {
      await this.app.call('turn/steer', { threadId, expectedTurnId: active.activeTurnId, clientUserMessageId: command.idempotency_key, input: [{ type: 'text', text: String(command.payload.prompt) }] })
      return
    }
    this.threadModes.set(threadId, 'planning')
    await this.app.call('turn/start', {
      threadId,
      clientUserMessageId: command.idempotency_key,
      input: [{ type: 'text', text: `Plan this task without editing files. Return a concise, implementation-ready plan and stop: ${command.payload.prompt}` }],
      sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user',
    })
  }

  async implement(plan) {
    this.threadModes.set(plan.threadId, 'implementing')
    await this.app.call('turn/start', {
      threadId: plan.threadId,
      input: [{ type: 'text', text: 'Implement the approved plan. Re-read the current repository state, keep normal approval boundaries, run focused verification, and report the result.' }],
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [plan.cwd], networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user',
    })
  }

  async handleServerRequest(message) {
    const supported = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'])
    if (!supported.has(message.method)) {
      this.app.respond(message.id, { decision: 'decline' })
      return
    }
    const protocolId = String(message.id)
    const local = this.threads.get(message.params.threadId)
    if (!local) throw new Error('Codex requested approval for an unknown thread')
    const workspace = [...this.remoteWorkspaces.values()].find((candidate) => candidate.local_id === local.workspaceLocalId)
    const remoteThread = [...this.remoteThreads.values()].find((candidate) => candidate.codex_thread_id === message.params.threadId)
    if (!workspace) { await this.sync(); return this.handleServerRequest(message) }
    this.pendingApprovals.set(protocolId, { message, expiresAt: Date.now() + 15 * 60_000 })
    await this.queueInteraction(`${this.processInstanceId}:${protocolId}`, {
      workspace_id: workspace.id,
      thread_id: remoteThread?.id || null,
      process_instance_id: this.processInstanceId,
      protocol_request_id: protocolId,
      kind: requestKind(message.method),
      payload: { method: message.method, params: message.params },
      title: approvalTitle(message.method),
      summary: approvalSummary(message.method),
      risk: message.method === 'item/permissions/requestApproval' ? 'high' : 'medium',
    })
  }

  async handleNotification(message) {
    const params = message.params || {}
    const threadId = params.threadId || params.thread?.id || params.turn?.threadId
    if (!threadId || !this.threads.has(threadId)) return
    const thread = this.threads.get(threadId)
    if (message.method === 'turn/started') {
      thread.activeTurnId = params.turn?.id
      thread.status = this.threadModes.get(threadId) === 'implementing' ? 'implementing' : 'planning'
      thread.milestone = thread.status === 'planning' ? 'Preparing a safe implementation plan' : 'Implementing the approved plan'
      thread.finalSummary = ''
    } else if (message.method === 'item/agentMessage/delta') {
      thread.response = `${thread.response || ''}${params.delta || ''}`.slice(0, 100_000)
    } else if (message.method === 'item/started' && params.item?.type === 'commandExecution') {
      thread.status = this.threadModes.get(threadId) === 'implementing' ? 'testing' : thread.status
      thread.milestone = 'Running a repository check'
    } else if (message.method === 'turn/completed') {
      thread.activeTurnId = null
      const mode = this.threadModes.get(threadId)
      const response = thread.response || finalMessage(params.turn) || 'Codex completed the turn.'
      thread.response = ''
      if (mode === 'planning') await this.publishPlan(threadId, params.turn?.id || randomUUID(), response)
      else { thread.status = params.turn?.status === 'failed' ? 'error' : 'completed'; thread.milestone = thread.status === 'completed' ? 'Implementation and verification complete' : 'Codex could not complete the task'; thread.finalSummary = response.slice(0, 2000) }
    }
  }

  async publishPlan(threadId, turnId, planText) {
    const local = this.threads.get(threadId)
    const workspace = [...this.remoteWorkspaces.values()].find((candidate) => candidate.local_id === local.workspaceLocalId)
    const remoteThread = [...this.remoteThreads.values()].find((candidate) => candidate.codex_thread_id === threadId)
    const cwd = this.config.workspaces.find((candidate) => candidate.id === local.workspaceLocalId)?.path
    if (!workspace || !cwd) throw new Error('Planning workspace is unavailable')
    const repositoryState = repositoryStateId(cwd)
    const protocolId = `plan:${turnId}`
    this.plans.set(protocolId, { threadId, cwd, planText, repositoryState, expiresAt: Date.now() + 15 * 60_000 })
    local.status = 'waiting'
    local.milestone = 'Plan ready for approval on Cloudy'
    await this.queueInteraction(`${this.processInstanceId}:${protocolId}`, {
      workspace_id: workspace.id, thread_id: remoteThread?.id || null, process_instance_id: this.processInstanceId,
      protocol_request_id: protocolId, kind: 'plan_review', payload: { plan: planText, codex_thread_id: threadId, turn_id: turnId, repository_state: repositoryState },
      title: 'Approve Codex implementation plan', summary: planText.slice(0, 1000), risk: 'medium',
    })
  }

  async queueInteraction(key, body) {
    this.pendingInteractions.set(key, body)
    await this.flushInteractions()
  }

  async flushInteractions() {
    for (const [key, body] of this.pendingInteractions) {
      try {
        await this.api.request('POST', '/v1/codex/bridge/interactions', body)
        this.pendingInteractions.delete(key)
      } catch (error) {
        this.lastError = error.message
      }
    }
  }

  async rememberThread(threadId, workspaceId) {
    if (this.config.threads.some((thread) => thread.id === threadId)) return
    this.config.threads.push({ id: threadId, workspaceId })
    await this.onConfigChange(this.config)
  }

  expireLocalInteractions(now = Date.now()) {
    for (const [protocolId, pending] of this.pendingApprovals) {
      if (pending.expiresAt > now) continue
      this.app.respond(pending.message.id, approvalResult(pending.message.method, false, pending.message.params))
      this.pendingApprovals.delete(protocolId)
    }
    for (const [protocolId, plan] of this.plans) if (plan.expiresAt <= now) this.plans.delete(protocolId)
  }
}

export function requestKind(method) {
  return method.includes('commandExecution') ? 'command_approval' : method.includes('fileChange') ? 'file_change_approval' : 'permission_approval'
}

export function approvalTitle(method) {
  return method.includes('commandExecution') ? 'Allow Codex to run this command?' : method.includes('fileChange') ? 'Allow Codex to change files?' : 'Grant Codex additional permissions?'
}

export function approvalSummary(method) {
  return method.includes('commandExecution') ? 'Codex wants to run a repository command.' : method.includes('fileChange') ? 'Codex wants to update repository files.' : 'Codex needs additional scoped permissions.'
}

export function approvalResult(method, accepted, params) {
  if (method === 'item/permissions/requestApproval') return accepted ? { permissions: params.permissions, scope: 'turn' } : { permissions: {}, scope: 'turn' }
  return { decision: accepted ? 'accept' : 'decline' }
}

function finalMessage(turn) {
  const items = turn?.items || []
  const item = [...items].reverse().find((candidate) => candidate.type === 'agentMessage')
  return item?.text || item?.content?.map((part) => part.text || '').join('') || ''
}

function repositoryStateId(cwd) {
  const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }).stdout
  return createHash('sha256').update(`${head}\n${status}`).digest('hex')
}

function dashboardError(error) {
  if (!error) return ''
  if (error.includes('or newer is required')) return error.slice(0, 500)
  if (error.includes('not installed or is not executable')) return 'Codex CLI is not installed or is not executable'
  if (error.includes('app-server exited')) return 'Codex app-server stopped unexpectedly; the bridge service is restarting'
  if (error.includes('reviewed plan was sealed')) return 'Repository changed after plan review; create a new plan'
  return 'The local Codex bridge encountered an error; run it in the foreground for diagnostics'
}
