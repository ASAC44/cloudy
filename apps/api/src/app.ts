import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'

import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { jwk } from 'hono/jwk'
import type { JwtVariables } from 'hono/jwt'

import type { NewRequest, Store } from './store.js'
import { StoreError } from './store.js'
import { ConnectionError, type ConnectionService, validatePublicEndpoint } from './connections.js'
import { isAiProvider, testAiSettings, type AiTester } from './ai.js'
import { RuleBuilderError, type RuleBuilderService } from './rule-builder.js'

type SupabaseJwt = { sub?: unknown; email?: unknown }
type Variables = JwtVariables<SupabaseJwt>
type AppContext = Context<{ Variables: Variables }>

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const UUID_PATTERN = new RegExp(`^${UUID}$`, 'i')
const POD_TOKEN = new RegExp(`^pod_(${UUID})\\.([A-Za-z0-9_-]{43})$`, 'i')
const AUTOMATION_TOKEN = /^pdx_([a-f0-9]{12})\.([A-Za-z0-9_-]{32})$/
const PAIRING_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const code = () => Array.from({ length: 8 }, () => CROCKFORD[randomInt(CROCKFORD.length)]).join('')
const bearer = (c: AppContext) => c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1]

function userId(c: AppContext) {
  const sub = c.get('jwtPayload').sub
  return typeof sub === 'string' ? sub : null
}

function text(value: unknown, max: number) {
  return typeof value === 'string' && value.trim() && value.trim().length <= max
    ? value.trim()
    : null
}

function optionalText(value: unknown, max: number) {
  return value === undefined || value === ''
    ? ''
    : typeof value === 'string' && value.trim().length <= max
      ? value.trim()
      : null
}

function baseUrl(value: unknown) {
  const raw = text(value, 2048)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function errorResponse(c: AppContext, error: unknown) {
  if (error instanceof RuleBuilderError) {
    const status = {
      rule_session_not_found: 404,
      rule_not_found: 404,
      rule_session_expired: 410,
      rule_session_conflict: 409,
      rule_edit_conflict: 409,
      rule_pod_unavailable: 409,
      rule_connection_unavailable: 409,
      rule_not_ready: 409,
      ai_settings_required: 409,
      ai_model_incompatible: 422,
      invalid_rule_turn: 400,
      invalid_ai_response: 422,
    }[error.code] ?? 500
    return c.json({ error: error.code.replaceAll('_', ' ') }, status as 400)
  }
  if (error instanceof ConnectionError) {
    const status = {
      connection_not_found: 404,
      provider_not_configured: 503,
      endpoint_not_editable: 400,
      endpoint_required: 400,
      token_required: 400,
      invalid_endpoint: 400,
      private_endpoint: 400,
      endpoint_unreachable: 400,
      unexpected_redirect: 400,
      credentials_unreadable: 500,
      invalid_oauth_state: 400,
      oauth_exchange_failed: 400,
      capability_not_safe: 400,
      capability_not_found: 404,
    }[error.code] ?? 500
    return c.json({ error: error.code.replaceAll('_', ' ') }, status as 400)
  }
  if (!(error instanceof StoreError)) {
    console.error(error instanceof Error ? error.message : 'Unknown API error')
    return c.json({ error: 'Internal server error' }, 500)
  }

  const status = {
    pairing_rate_limited: 429,
    invalid_pairing_code: 400,
    active_pod_exists: 409,
    pod_not_authorized: 401,
    request_not_found: 404,
    request_already_resolved: 409,
    request_expired: 409,
    payload_changed: 409,
    idempotency_conflict: 409,
    connection_name_exists: 409,
    connection_in_use: 409,
    rule_session_not_found: 404,
    rule_session_expired: 410,
    rule_session_conflict: 409,
    rule_edit_conflict: 409,
    rule_pod_unavailable: 409,
    rule_connection_unavailable: 409,
    rule_not_found: 404,
    automation_key_name_exists: 409,
  }[error.code] ?? 500
  return c.json({ error: error.code.replaceAll('_', ' ') }, status as 400)
}

async function podIdentity(c: AppContext, store: Store) {
  const match = bearer(c)?.match(POD_TOKEN)
  if (!match) return null
  return store.authenticatePod(match[1], hash(match[2]))
}

async function automationIdentity(c: AppContext, store: Store) {
  const token = bearer(c)
  const match = token?.match(AUTOMATION_TOKEN)
  if (!token || !match) return null
  return store.authenticateAutomationKey(`pdx_${match[1]}`, hash(token))
}

export function createApp(
  supabaseUrl: string,
  store: Store,
  userAuthOverride?: MiddlewareHandler<{ Variables: Variables }>,
  connectionService?: ConnectionService,
  aiTester: AiTester = testAiSettings,
  ruleBuilder?: RuleBuilderService,
) {
  const app = new Hono<{ Variables: Variables }>()
  const issuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`
  const userAuth = userAuthOverride ?? (jwk({
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    alg: ['ES256', 'RS256'],
    verification: { iss: issuer, aud: 'authenticated' },
  }) as MiddlewareHandler<{ Variables: Variables }>)

  app.get('/', (c) => c.json({ name: 'podex-api', status: 'ok' }))

  for (const route of ['/v1/me', '/v1/pods', '/v1/pods/*', '/v1/requests', '/v1/requests/*', '/v1/settings/*']) {
    app.use(route, userAuth)
  }
  for (const route of ['/v1/automation-keys', '/v1/automation-keys/*']) app.use(route, userAuth)
  for (const route of [
    '/v1/connections',
    '/v1/connections/:id',
    '/v1/connections/:id/test',
    '/v1/connections/oauth/:provider/start',
  ]) app.use(route, userAuth)
  for (const route of ['/v1/rule-builder/*', '/v1/rules', '/v1/rules/*']) app.use(route, userAuth)

  app.get('/v1/me', (c) => {
    const payload = c.get('jwtPayload')
    if (typeof payload.sub !== 'string') return c.json({ error: 'Unauthorized' }, 401)
    return c.json({
      user: {
        id: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
      },
    })
  })

  app.get('/v1/settings/ai', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const settings = await store.getAiSettings(ownerId)
      return c.json({
        settings: settings ? {
          provider: settings.provider,
          base_url: settings.base_url,
          model: settings.model,
          has_api_key: true,
          updated_at: settings.updated_at,
        } : null,
      })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.put('/v1/settings/ai', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!connectionService) return c.json({ error: 'Credential encryption is not configured' }, 503)
    const body = await c.req.json().catch(() => null)
    const provider = body?.provider
    const endpoint = baseUrl(body?.base_url)
    const model = text(body?.model, 200)
    const apiKey = body?.api_key === undefined || body.api_key === '' ? '' : text(body.api_key, 1000)
    if (!isAiProvider(provider) || !endpoint || !model || apiKey === null) {
      return c.json({ error: 'A provider, valid HTTPS endpoint, model, and API key are required' }, 400)
    }
    try {
      const existing = await store.getAiSettings(ownerId)
      if (!apiKey && !existing) return c.json({ error: 'API key is required' }, 400)
      const settings = await store.saveAiSettings(ownerId, {
        provider,
        base_url: endpoint,
        model,
        encrypted_api_key: apiKey
          ? connectionService.encryptApiKey(apiKey)
          : existing!.encrypted_api_key,
      })
      return c.json({
        settings: {
          provider: settings.provider,
          base_url: settings.base_url,
          model: settings.model,
          has_api_key: true,
          updated_at: settings.updated_at,
        },
      })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/settings/ai/test', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!connectionService) return c.json({ error: 'Credential encryption is not configured' }, 503)
    try {
      const settings = await store.getAiSettings(ownerId)
      if (!settings) return c.json({ error: 'Save AI provider settings before testing' }, 400)
      await aiTester(settings, connectionService.decryptApiKey(settings.encrypted_api_key))
      return c.json({ ok: true })
    } catch (error) {
      if (error instanceof StoreError || error instanceof ConnectionError) return errorResponse(c, error)
      return c.json({ error: 'Provider test failed. Check the endpoint, model, and API key.' }, 400)
    }
  })

  app.post('/v1/pod/pairing-sessions', async (c) => {
    try {
      const podId = randomUUID()
      const secret = randomBytes(32).toString('base64url')
      const pairingCode = code()
      const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      // ponytail: a hashed IP is enough for the MVP; use an edge rate limiter if distributed abuse appears.
      const sourceIpHash = hash(forwarded || 'local')
      const session = await store.createPairingSession({
        podId,
        codeHash: hash(pairingCode),
        tokenHash: hash(secret),
        sourceIpHash,
      })
      return c.json(
        {
          session_id: session.id,
          pairing_code: pairingCode,
          pod_token: `pod_${podId}.${secret}`,
          expires_at: session.expiresAt,
        },
        201,
      )
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/v1/pod/pairing-sessions/:id', async (c) => {
    const match = bearer(c)?.match(POD_TOKEN)
    if (!match) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const status = await store.getPairingStatus(c.req.param('id'), match[1], hash(match[2]))
      return status ? c.json({ status }) : c.json({ error: 'Pairing session not found' }, 404)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/pods/claim', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    const body = await c.req.json().catch(() => null)
    const pairingCode = text(body?.code, 8)?.toUpperCase()
    const name = text(body?.name, 80)
    if (!pairingCode || !PAIRING_CODE.test(pairingCode) || !name) {
      return c.json({ error: 'An 8-character code and Pod name are required' }, 400)
    }
    try {
      return c.json({ pod: await store.claimPairing(hash(pairingCode), ownerId, name) })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/v1/pods', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    try {
      return c.json({ pods: await store.listPods(ownerId) })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.delete('/v1/pods/:id', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    try {
      return (await store.revokePod(ownerId, c.req.param('id')))
        ? c.body(null, 204)
        : c.json({ error: 'Pod not found' }, 404)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/requests', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    const body = await c.req.json().catch(() => null)
    const title = text(body?.title, 160)
    const source = text(body?.source, 120)
    const summary = text(body?.summary, 1000)
    const details = optionalText(body?.details, 8000)
    const affected = optionalText(body?.affected_context, 2000)
    const risk = body?.risk
    const warnings = Array.isArray(body?.warnings)
      ? body.warnings.map((item: unknown) => text(item, 300)).filter(Boolean)
      : []
    const expiresIn = Number(body?.expires_in_minutes)
    if (
      !title || !source || !summary || details === null || affected === null ||
      !['low', 'medium', 'high'].includes(risk) || warnings.length > 10 ||
      ![5, 15, 30, 60].includes(expiresIn)
    ) {
      return c.json({ error: 'Invalid test Ping' }, 400)
    }

    const actionPayload = {
      kind: 'test_ping' as const,
      title,
      source,
      summary,
      details,
      affected_context: affected,
      risk,
      warnings,
    }
    const request: NewRequest = {
      title,
      source,
      summary,
      details,
      affected_context: affected,
      risk,
      warnings: warnings as string[],
      priority: risk === 'high' ? 2 : risk === 'medium' ? 1 : 0,
      action_payload: actionPayload,
      expires_at: new Date(Date.now() + expiresIn * 60_000).toISOString(),
    }
    try {
      return c.json(
        { request: await store.createRequest(ownerId, request, hash(JSON.stringify(actionPayload))) },
        201,
      )
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/v1/requests', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    const status = c.req.query('status')
    if (status && !['pending', 'approved', 'rejected', 'expired', 'cancelled'].includes(status)) {
      return c.json({ error: 'Invalid status' }, 400)
    }
    try {
      return c.json({ requests: await store.listRequests(ownerId, status) })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/v1/automation-keys', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    try {
      return c.json({ keys: await store.listAutomationKeys(ownerId) })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/automation-keys', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    const body = await c.req.json().catch(() => null)
    const name = text(body?.name, 80)
    if (!name) return c.json({ error: 'Key name is required' }, 400)
    const prefix = `pdx_${randomBytes(6).toString('hex')}`
    const token = `${prefix}.${randomBytes(24).toString('base64url')}`
    try {
      const key = await store.createAutomationKey(ownerId, name, prefix, hash(token))
      return c.json({ key, token }, 201)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.delete('/v1/automation-keys/:id', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!UUID_PATTERN.test(c.req.param('id'))) return c.json({ error: 'Invalid automation key' }, 400)
    try {
      return (await store.revokeAutomationKey(ownerId, c.req.param('id')))
        ? c.body(null, 204)
        : c.json({ error: 'Automation key not found' }, 404)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/automation/approvals', async (c) => {
    const identity = await automationIdentity(c, store)
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    if (!connectionService) return c.json({ error: 'Credential encryption is not configured' }, 503)
    const body = await c.req.json().catch(() => null)
    const externalId = text(c.req.header('idempotency-key'), 200)
    const title = text(body?.title, 160)
    const source = body?.source === undefined ? 'n8n' : text(body.source, 120)
    const summary = text(body?.summary, 1000)
    const details = optionalText(body?.details, 8000)
    const affected = optionalText(body?.affected_context, 2000)
    const risk = body?.risk
    const warnings = Array.isArray(body?.warnings)
      ? body.warnings.map((item: unknown) => text(item, 300)).filter(Boolean)
      : []
    const expiresIn = Number(body?.expires_in_minutes)
    const callbackUrl = text(body?.callback_url, 2048)
    const action = body?.action
    if (
      !externalId || !title || !source || !summary || details === null || affected === null ||
      !['low', 'medium', 'high'].includes(risk) || warnings.length > 10 ||
      ![5, 15, 30, 60].includes(expiresIn) || !callbackUrl ||
      !action || typeof action !== 'object' || Array.isArray(action)
    ) return c.json({ error: 'Invalid automation approval' }, 400)

    try {
      await validatePublicEndpoint(callbackUrl)
      const actionPayload = { kind: 'n8n_approval', action }
      const request: NewRequest = {
        title,
        source,
        summary,
        details,
        affected_context: affected,
        risk,
        warnings: warnings as string[],
        priority: risk === 'high' ? 2 : risk === 'medium' ? 1 : 0,
        action_payload: actionPayload,
        expires_at: new Date(Date.now() + expiresIn * 60_000).toISOString(),
      }
      const created = await store.createAutomationRequest({
        ownerId: identity.ownerId,
        keyId: identity.id,
        externalId,
        request,
        payloadHash: hash(JSON.stringify(actionPayload)),
        encryptedCallbackUrl: connectionService.encryptCallbackUrl(callbackUrl),
      })
      return c.json({ request: automationRequest(created) }, 202)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/v1/automation/approvals/:id', async (c) => {
    const identity = await automationIdentity(c, store)
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    if (!UUID_PATTERN.test(c.req.param('id'))) return c.json({ error: 'Invalid approval request' }, 400)
    try {
      const request = await store.getAutomationRequest(identity.ownerId, c.req.param('id'))
      return request
        ? c.json({ request: automationRequest(request) })
        : c.json({ error: 'Approval request not found' }, 404)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.delete('/v1/automation/approvals/:id', async (c) => {
    const identity = await automationIdentity(c, store)
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    if (!UUID_PATTERN.test(c.req.param('id'))) return c.json({ error: 'Invalid approval request' }, 400)
    try {
      return (await store.cancelAutomationRequest(identity.ownerId, c.req.param('id')))
        ? c.body(null, 204)
        : c.json({ error: 'Pending approval request not found' }, 404)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/v1/connections', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    try {
      return c.json({ connections: await store.listConnections(ownerId) })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/rule-builder/sessions', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!ruleBuilder) return c.json({ error: 'Rule builder is not configured' }, 503)
    const body = await c.req.json().catch(() => ({}))
    const ruleId = body?.rule_id === undefined ? undefined : text(body.rule_id, 36)
    if (ruleId !== undefined && (!ruleId || !UUID_PATTERN.test(ruleId))) {
      return c.json({ error: 'Invalid rule' }, 400)
    }
    try {
      return c.json({ session: await ruleBuilder.createSession(ownerId, ruleId) }, 201)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/v1/rule-builder/sessions/:id', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!ruleBuilder) return c.json({ error: 'Rule builder is not configured' }, 503)
    if (!UUID_PATTERN.test(c.req.param('id'))) return c.json({ error: 'Invalid session' }, 400)
    try {
      return c.json({ session: await ruleBuilder.getSession(ownerId, c.req.param('id')) })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/rule-builder/sessions/:id/turns', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!ruleBuilder) return c.json({ error: 'Rule builder is not configured' }, 503)
    const body = await c.req.json().catch(() => null)
    if (!UUID_PATTERN.test(c.req.param('id')) || !Number.isInteger(body?.revision) || body.revision < 1) {
      return c.json({ error: 'Invalid rule turn' }, 400)
    }
    try {
      return c.json({ session: await ruleBuilder.turn(ownerId, c.req.param('id'), body.revision, {
        message: body.message,
        answers: body.answers,
      }) })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/rule-builder/sessions/:id/commit', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!ruleBuilder) return c.json({ error: 'Rule builder is not configured' }, 503)
    const body = await c.req.json().catch(() => null)
    if (!UUID_PATTERN.test(c.req.param('id')) || !Number.isInteger(body?.revision) || body.revision < 1) {
      return c.json({ error: 'Invalid rule commit' }, 400)
    }
    try {
      return c.json(await ruleBuilder.commit(ownerId, c.req.param('id'), body.revision))
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/v1/rules', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!ruleBuilder) return c.json({ error: 'Rule builder is not configured' }, 503)
    try {
      return c.json({ rules: await ruleBuilder.list(ownerId) })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.delete('/v1/rules/:id', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!ruleBuilder) return c.json({ error: 'Rule builder is not configured' }, 503)
    if (!UUID_PATTERN.test(c.req.param('id'))) return c.json({ error: 'Invalid rule' }, 400)
    try {
      return (await ruleBuilder.delete(ownerId, c.req.param('id')))
        ? c.body(null, 204)
        : c.json({ error: 'Rule not found' }, 404)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/connections', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!connectionService) return c.json({ error: 'Connections are not configured' }, 503)
    const body = await c.req.json().catch(() => null)
    const name = text(body?.name, 80)
    const provider = body?.provider
    const endpointUrl = body?.endpoint_url === undefined ? undefined : text(body.endpoint_url, 2000)
    const token = body?.token === undefined ? undefined : text(body.token, 5000)
    const authType = body?.auth_type
    if (
      !name || !['vercel', 'telegram', 'custom_mcp'].includes(provider) ||
      (body?.endpoint_url !== undefined && !endpointUrl) ||
      (body?.token !== undefined && !token) ||
      (authType !== undefined && !['none', 'bearer'].includes(authType))
    ) return c.json({ error: 'Invalid connection' }, 400)
    try {
      const connection = await connectionService.createManual(ownerId, {
        provider,
        name,
        endpointUrl: endpointUrl ?? undefined,
        authType,
        token: token ?? undefined,
      })
      return c.json({ connection }, 201)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.patch('/v1/connections/:id', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!connectionService) return c.json({ error: 'Connections are not configured' }, 503)
    const body = await c.req.json().catch(() => null)
    const name = body?.name === undefined ? undefined : text(body.name, 80)
    const endpointUrl = body?.endpoint_url === undefined ? undefined : text(body.endpoint_url, 2000)
    const token = body?.token === undefined ? undefined : text(body.token, 5000)
    const authType = body?.auth_type
    if (
      !UUID_PATTERN.test(c.req.param('id')) || !body ||
      (body.name !== undefined && !name) || (body.endpoint_url !== undefined && !endpointUrl) ||
      (body.token !== undefined && !token) ||
      (authType !== undefined && !['none', 'bearer'].includes(authType))
    ) return c.json({ error: 'Invalid connection changes' }, 400)
    try {
      return c.json({ connection: await connectionService.update(ownerId, c.req.param('id'), {
        name: name ?? undefined,
        endpointUrl: endpointUrl ?? undefined,
        authType,
        token: token ?? undefined,
      }) })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/connections/:id/test', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!connectionService) return c.json({ error: 'Connections are not configured' }, 503)
    if (!UUID_PATTERN.test(c.req.param('id'))) return c.json({ error: 'Invalid connection' }, 400)
    try {
      return c.json({ connection: await connectionService.test(ownerId, c.req.param('id')) })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.delete('/v1/connections/:id', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!UUID_PATTERN.test(c.req.param('id'))) return c.json({ error: 'Invalid connection' }, 400)
    try {
      return (await store.deleteConnection(ownerId, c.req.param('id')))
        ? c.body(null, 204)
        : c.json({ error: 'Connection not found' }, 404)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/connections/oauth/:provider/start', async (c) => {
    const ownerId = userId(c)
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401)
    if (!connectionService) return c.json({ error: 'Connections are not configured' }, 503)
    const provider = c.req.param('provider')
    const body = await c.req.json().catch(() => null)
    const name = text(body?.name, 80)
    const connectionId = body?.connection_id === undefined ? null : text(body.connection_id, 36)
    if (
      !['github', 'gmail'].includes(provider) || !name ||
      (connectionId !== null && !UUID_PATTERN.test(connectionId))
    ) return c.json({ error: 'Invalid OAuth connection' }, 400)
    try {
      const authorizationUrl = await connectionService.startOAuth(
        ownerId,
        provider as 'github' | 'gmail',
        name,
        connectionId,
      )
      return c.json({ authorization_url: authorizationUrl })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/v1/connections/oauth/:provider/callback', async (c) => {
    if (!connectionService) return c.json({ error: 'Connections are not configured' }, 503)
    const provider = c.req.param('provider')
    const state = c.req.query('state')
    const code = c.req.query('code')
    if (!['github', 'gmail'].includes(provider) || !state || !code) {
      return c.redirect(connectionService.redirectUrl({ error: 'oauth_failed' }))
    }
    try {
      await connectionService.finishOAuth(provider as 'github' | 'gmail', state, code)
      return c.redirect(connectionService.redirectUrl({ provider }))
    } catch {
      return c.redirect(connectionService.redirectUrl({ error: 'oauth_failed' }))
    }
  })

  app.get('/v1/pod/requests/current', async (c) => {
    try {
      const pod = await podIdentity(c, store)
      if (!pod) return c.json({ error: 'Unauthorized' }, 401)
      const current = await store.currentRequest(pod.ownerId)
      return c.json({ request: current.request, queue_size: current.queueSize })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/v1/pod/requests/:id/decision', async (c) => {
    try {
      const pod = await podIdentity(c, store)
      if (!pod) return c.json({ error: 'Unauthorized' }, 401)
      const body = await c.req.json().catch(() => null)
      if (
        !['approved', 'rejected'].includes(body?.outcome) ||
        !text(body?.payload_hash, 64) || body.payload_hash.length !== 64 ||
        !text(body?.idempotency_key, 36) || !UUID_PATTERN.test(body.idempotency_key) ||
        !UUID_PATTERN.test(c.req.param('id'))
      ) {
        return c.json({ error: 'Invalid decision' }, 400)
      }
      const decision = await store.decideRequest({
        ownerId: pod.ownerId,
        podId: pod.id,
        requestId: c.req.param('id'),
        outcome: body.outcome,
        payloadHash: body.payload_hash,
        idempotencyKey: body.idempotency_key,
      })
      return c.json({ decision })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  return app
}

function automationRequest(request: {
  id: string
  title: string
  status: string
  created_at: string
  expires_at: string
  decided_at: string | null
}) {
  return {
    id: request.id,
    title: request.title,
    status: request.status,
    created_at: request.created_at,
    expires_at: request.expires_at,
    decided_at: request.decided_at,
  }
}
