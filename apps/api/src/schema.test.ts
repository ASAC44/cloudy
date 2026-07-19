import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../../', import.meta.url)

test('Codex migration keeps hierarchy writes atomic and rollback restores decisions', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260719070000_codex_sessions.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260719070000_codex_sessions.sql', root), 'utf8')

  assert.match(migration, /foreign key \(workspace_id, bridge_id\)/)
  assert.match(migration, /foreign key \(thread_id, workspace_id\)/)
  assert.match(migration, /function public\.sync_codex_bridge\(/)
  assert.match(migration, /function public\.set_codex_target\(/)
  assert.match(migration, /function public\.revise_codex_plan\([\s\S]*if decision\.id is null then return null;/)
  assert.match(migration, /for update skip locked/)
  assert.match(migration, /unique\(bridge_id, process_instance_id, protocol_request_id\)/)
  assert.match(migration, /encrypted_payload text not null/)
  assert.match(migration, /if request\.expires_at <= now\(\) then[\s\S]*return null;/)
  assert.match(rollback, /create or replace function public\.decide_approval\(/)
  assert.match(rollback, /drop function if exists public\.revise_codex_plan/)
})

test('dynamic Ping migration keeps execution, approvals, leases, and rollback safe', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260719080000_dynamic_ping_engine.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260719080000_dynamic_ping_engine.sql', root), 'utf8')

  assert.match(migration, /^begin;/)
  assert.match(migration, /for update of states skip locked/)
  assert.match(migration, /for update of events skip locked/)
  assert.match(migration, /unique \(rule_id, event_identity\)/)
  assert.match(migration, /foreign key \(owner_id, connection_id\)[\s\S]*on delete restrict/)
  assert.match(migration, /create or replace function public\.commit_ping_rule_session_v2/)
  assert.match(migration, /create or replace function public\.prepare_ping_rule_approval/)
  assert.match(migration, /next_attempt_at timestamptz not null default now\(\)/)
  assert.match(migration, /ping_rule_events_evaluation_queue[\s\S]*next_attempt_at/)
  assert.match(migration, /ping_rule_events_delivery_queue[\s\S]*next_attempt_at/)
  assert.match(migration, /case attempts when 1 then now\(\) \+ interval '5 seconds' else now\(\) \+ interval '30 seconds' end/)
  assert.match(migration, /status = 'cancelled'[\s\S]*status = 'superseded'/)
  assert.match(migration, /conversation_key = event\.conversation_key[\s\S]*status in \('pending_approval', 'approved'\)/)
  assert.match(migration, /encrypted_source_payload = null[\s\S]*interval '7 days'/)
  assert.match(migration, /alter table public\.telegram_auth_sessions enable row level security/)
  assert.match(migration, /revoke all on function public\.claim_approved_ping_action/)
  assert.match(rollback, /raise exception 'Refusing rollback while V2 Ping rules exist/)
  assert.match(rollback, /drop table if exists public\.ping_rule_events/)
})

test('Linear and Stripe provider migration is atomic and rollback preserves connection data', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260720000000_linear_stripe_connections.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260720000000_linear_stripe_connections.sql', root), 'utf8')

  assert.match(migration, /^begin;/)
  assert.match(migration, /drop constraint connections_provider_check/)
  assert.match(migration, /'linear', 'stripe'/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /^begin;/)
  assert.match(rollback, /where provider in \('linear', 'stripe'\)/)
  assert.match(rollback, /raise exception 'Refusing rollback while Linear or Stripe connections exist'/)
  assert.match(rollback, /'telegram', 'custom_mcp'/)
  assert.match(rollback, /commit;\s*$/)
})

test('Pod screen layouts are constrained, revisioned, and rollback-safe', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260720010000_pod_screen_layout.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260720010000_pod_screen_layout.sql', root), 'utf8')

  assert.match(migration, /^begin;/)
  assert.match(migration, /constraint pods_valid_screen_layout check/)
  assert.match(migration, /where id = p_pod_id and owner_id = p_owner_id and revoked_at is null[\s\S]*for update/)
  assert.match(migration, /pod_layout_conflict/)
  assert.match(migration, /screen_layout_revision = screen_layout_revision \+ 1/)
  assert.match(migration, /array\['left', 'right', 'down'\]/)
  assert.match(migration, /connection\.owner_id = p_owner_id[\s\S]*connection\.provider = 'custom_mcp'/)
  assert.match(migration, /function public\.delete_connection_with_layout_cleanup\([\s\S]*delete from public\.connections[\s\S]*update public\.pods/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /^begin;/)
  assert.match(rollback, /drop column if exists screen_layout/)
  assert.match(rollback, /drop function if exists public\.delete_connection_with_layout_cleanup/)
  assert.match(rollback, /commit;\s*$/)
})

test('rule builder can request first-class Linear and Stripe connections', async () => {
  const source = await readFile(new URL('apps/api/src/rule-builder.ts', root), 'utf8')
  assert.match(source, /enum: \['github', 'gmail', 'vercel', 'telegram', 'linear', 'stripe', 'custom_mcp', 'other'\]/)
  assert.match(source, /\['github', 'gmail', 'vercel', 'telegram', 'linear', 'stripe', 'custom_mcp'\]\.includes/)
})

test('rule listing disambiguates the owner-scoped runtime-state relationship', async () => {
  const store = await readFile(new URL('apps/api/src/supabase-store.ts', root), 'utf8')
  assert.match(store, /ping_rule_runtime_states!ping_rule_runtime_states_owner_id_rule_id_fkey\(/)
})

test('runtime execution stays in the dedicated worker process', async () => {
  const api = await readFile(new URL('apps/api/src/index.ts', root), 'utf8')
  const worker = await readFile(new URL('apps/api/src/worker.ts', root), 'utf8')
  const packageJson = await readFile(new URL('apps/api/package.json', root), 'utf8')

  assert.doesNotMatch(api, /startRuntimeLoop/)
  assert.match(worker, /startRuntimeLoop/)
  assert.match(packageJson, /"start:worker": "node --env-file-if-exists=\.env dist\/worker\.js"/)
})
