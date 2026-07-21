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
  assert.doesNotMatch(migration, /jsonb_object_length/)
  assert.match(migration, /count\(\*\) from pg_catalog\.jsonb_object_keys\(p_layout\)/)
  assert.match(migration, /connection\.owner_id = p_owner_id[\s\S]*connection\.provider = 'custom_mcp'/)
  assert.match(migration, /function public\.delete_connection_with_layout_cleanup\([\s\S]*delete from public\.connections[\s\S]*update public\.pods/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /^begin;/)
  assert.match(rollback, /drop column if exists screen_layout/)
  assert.match(rollback, /drop function if exists public\.delete_connection_with_layout_cleanup/)
  assert.match(rollback, /commit;\s*$/)
})

test('Pod screens hold one feed and the migration trims old multi-feed slots atomically', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260720030000_single_feed_screens.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260720030000_single_feed_screens.sql', root), 'utf8')

  assert.match(migration, /^begin;/)
  assert.match(migration, /jsonb_array_length\(p_layout -> direction\) > 1/)
  assert.doesNotMatch(migration, /jsonb_object_length/)
  assert.match(migration, /count\(\*\) from pg_catalog\.jsonb_object_keys\(p_layout\)/)
  assert.match(migration, /screen_layout_revision = screen_layout_revision \+ 1/)
  assert.match(migration, /add constraint pods_valid_screen_layout/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /jsonb_array_length\(p_layout -> direction\) > 6/)
  assert.match(rollback, /commit;\s*$/)
})

test('Pod screens widen to six feeds and rollback refuses to discard assignments', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260721020000_multi_feed_screens.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260721020000_multi_feed_screens.sql', root), 'utf8')

  assert.match(migration, /^begin;/)
  assert.match(migration, /jsonb_array_length\(p_layout -> direction\) > 6/)
  assert.match(migration, /drop constraint if exists pods_valid_screen_layout/)
  assert.match(migration, /add constraint pods_valid_screen_layout/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /^begin;/)
  assert.match(rollback, /raise exception 'Refusing rollback while multi-feed Pod screens exist/)
  assert.match(rollback, /jsonb_array_length\(p_layout -> direction\) > 1/)
  assert.match(rollback, /commit;\s*$/)
})

test('rule builder can request first-class Linear and Stripe connections', async () => {
  const source = await readFile(new URL('apps/api/src/rule-builder.ts', root), 'utf8')
  assert.match(source, /enum: \['github', 'gmail', 'google_calendar', 'vercel', 'telegram', 'linear', 'stripe', 'notion', 'custom_mcp', 'other'\]/)
  assert.match(source, /\['github', 'gmail', 'google_calendar', 'vercel', 'telegram', 'linear', 'stripe', 'notion', 'custom_mcp'\]\.includes/)
})

test('Google Calendar provider migration is atomic, reversible, and preserves constrained layouts', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260720040000_google_calendar_connections.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260720040000_google_calendar_connections.sql', root), 'utf8')

  assert.match(migration, /^begin;/)
  assert.match(migration, /connection_oauth_states_provider_check[\s\S]*'google_calendar'/)
  assert.match(migration, /agent_memories_provider_check[\s\S]*'google_calendar'/)
  assert.match(migration, /'app:google_calendar'/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /Refusing rollback while Google Calendar data or screen assignments exist/)
  assert.match(rollback, /check \(provider in \('github', 'gmail'\)\)/)
  assert.match(rollback, /commit;\s*$/)
})

test('Notion provider migration is atomic, reversible, and preserves constrained layouts', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260721030000_notion_connections.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260721030000_notion_connections.sql', root), 'utf8')

  assert.match(migration, /^begin;/)
  assert.match(migration, /connection_oauth_states_provider_check[\s\S]*'notion'/)
  assert.match(migration, /agent_memories_provider_check[\s\S]*'notion'/)
  assert.match(migration, /'app:notion'/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /Refusing rollback while Notion data or screen assignments exist/)
  assert.match(rollback, /check \(provider in \('github', 'gmail', 'google_calendar'\)\)/)
  assert.match(rollback, /commit;\s*$/)
})

test('rule listing disambiguates the owner-scoped runtime-state relationship', async () => {
  const store = await readFile(new URL('apps/api/src/supabase-store.ts', root), 'utf8')
  assert.match(store, /ping_rule_runtime_states!ping_rule_runtime_states_owner_id_rule_id_fkey\(/)
})

test('Pod request queue preserves arrival order across attached apps', async () => {
  const store = await readFile(new URL('apps/api/src/supabase-store.ts', root), 'utf8')
  const currentRequest = store.match(/async currentRequest\(ownerId: string\)[\s\S]*?\n  async decideRequest/)?.[0] ?? ''

  assert.doesNotMatch(currentRequest, /order\('priority'/)
  assert.match(currentRequest, /order\('created_at', \{ ascending: true \}\)/)
})

test('runtime execution stays in the dedicated worker process', async () => {
  const api = await readFile(new URL('apps/api/src/index.ts', root), 'utf8')
  const worker = await readFile(new URL('apps/api/src/worker.ts', root), 'utf8')
  const packageJson = await readFile(new URL('apps/api/package.json', root), 'utf8')

  assert.doesNotMatch(api, /startRuntimeLoop/)
  assert.match(worker, /startRuntimeLoop/)
  assert.match(packageJson, /"start:worker": "node --env-file-if-exists=\.env dist\/worker\.js"/)
})

test('agent memories are owned, scoped, bounded, and reversible', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260720020000_agent_memories.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260720020000_agent_memories.sql', root), 'utf8')

  assert.match(migration, /owner_id uuid not null references auth\.users\(id\) on delete cascade/)
  assert.match(migration, /content text not null check \(char_length\(content\) between 1 and 2000\)/)
  assert.match(migration, /unique\(owner_id, scope, scope_id, provider, memory_key\)/)
  assert.match(migration, /alter table public\.agent_memories enable row level security/)
  assert.match(rollback, /drop table if exists public\.agent_memories/)
})

test('Cloudy rebrand replaces both scheduled job names and rolls back atomically', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260721000000_cloudy_rebrand.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260721000000_cloudy_rebrand.sql', root), 'utf8')

  for (const sql of [migration, rollback]) {
    assert.match(sql, /^begin;/)
    assert.match(sql, /cron\.unschedule/)
    assert.match(sql, /commit;\s*$/)
  }
  assert.match(migration, /podex-purge-expired-rule-builder-sessions/)
  assert.match(migration, /cloudy-purge-expired-rule-builder-sessions/)
  assert.match(migration, /podex-purge-ping-runtime-data/)
  assert.match(migration, /cloudy-purge-ping-runtime-data/)
  assert.match(rollback, /'podex-purge-expired-rule-builder-sessions'/)
  assert.match(rollback, /'podex-purge-ping-runtime-data'/)
})

test('Pod realtime invalidations are transactional, metadata-only, and reversible', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260721010000_pod_realtime_updates.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260721010000_pod_realtime_updates.sql', root), 'utf8')

  assert.match(migration, /^begin;/)
  assert.match(migration, /set search_path = ''/)
  assert.match(migration, /realtime\.send\(/)
  assert.match(migration, /'owner_id', owner_id/)
  assert.match(migration, /'pod_id', pod_id/)
  assert.match(migration, /'scope', tg_argv\[0\]/)
  assert.doesNotMatch(migration, /realtime\.broadcast_changes/)
  assert.match(migration, /after update of screen_layout, screen_layout_revision on public\.pods/)
  assert.doesNotMatch(migration, /after update of last_seen_at on public\.pods/)
  for (const table of ['approval_requests', 'pods', 'connections', 'codex_targets', 'codex_bridges']) {
    assert.match(migration, new RegExp(`on public\\.${table}`))
  }
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /^begin;/)
  assert.match(rollback, /drop function if exists public\.notify_pod_state_change\(\)/)
  assert.match(rollback, /commit;\s*$/)
})

test('reply personalization revisions are atomic, owner-scoped, and reversible', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260720050000_reply_personalization.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260720050000_reply_personalization.sql', root), 'utf8')

  assert.match(migration, /personalization_enabled boolean not null default true/)
  assert.match(migration, /where id = p_request_id and owner_id = p_owner_id\s+for update/)
  assert.match(migration, /where owner_id = p_owner_id and approval_request_id = request\.id\s+for update/)
  assert.match(migration, /request\.payload_hash <> p_expected_hash/)
  assert.match(migration, /insert into public\.agent_memories[\s\S]*on conflict/)
  assert.match(migration, /revoke all on function public\.revise_ping_rule_reply/)
  assert.match(rollback, /drop function if exists public\.revise_ping_rule_reply/)
  assert.match(rollback, /drop column if exists personalization_enabled/)
})

test('canonical memory data is constrained, encrypted, transactional, and rollback-safe', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260722000000_memory_data_model.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260722000000_memory_data_model.sql', root), 'utf8')

  assert.match(migration, /^begin;/)
  for (const table of [
    'memory_people', 'memory_identities', 'memory_decision_cases', 'memory_message_examples',
    'memory_preferences', 'memory_graph_refs', 'memory_import_cursors', 'memory_outbox',
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`))
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`))
    assert.match(rollback, new RegExp(`drop table if exists public\\.${table}`))
  }
  assert.match(migration, /foreign key \(owner_id, person_id\)[\s\S]*references public\.memory_people\(owner_id, id\)/)
  assert.match(migration, /memory_identities_active_external[\s\S]*where deleted_at is null/)
  assert.match(migration, /memory_outbox_claim_queue[\s\S]*where status in \('pending', 'processing'\)/)
  assert.match(migration, /check \(\(lease_token is null\) = \(leased_until is null\)\)/)
  assert.match(migration, /num_nonnulls\(person_id, identity_id, decision_case_id, message_example_id, preference_id\) = 1/)
  assert.match(migration, /create or replace function public\.record_ping_memory_decision/)
  assert.match(migration, /'decision\.' \|\| p_outcome[\s\S]*on conflict \(owner_id, dedupe_key\) do nothing/)
  assert.match(migration, /'delivery\.' \|\| final_status[\s\S]*on conflict \(owner_id, dedupe_key\) do nothing/)
  assert.match(migration, /encrypted_revision_payload = p_memory_content/)
  assert.match(migration, /coalesce\(decisions\.outcome, requests\.status\) as outcome/)
  assert.match(migration, /cases\.delivery_outcome in \('delivered', 'failed', 'ambiguous', 'superseded'\)/)
  const revisedReply = migration.match(/create or replace function public\.revise_ping_rule_reply\([\s\S]*?\n\$\$;/)?.[0] ?? ''
  assert.doesNotMatch(revisedReply, /insert into public\.agent_memories/)
  assert.match(rollback, /Refusing rollback while canonical memory data exists/)
  assert.match(rollback, /create or replace function public\.sync_ping_event_approval_status/)
  assert.match(rollback, /create or replace function public\.complete_ping_action/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /commit;\s*$/)
})

test('memory outbox sync is leased, owner-ordered, atomic, and reversible', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260722010000_memory_outbox_sync.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260722010000_memory_outbox_sync.sql', root), 'utf8')

  assert.match(migration, /^begin;/)
  assert.match(migration, /create or replace function public\.claim_memory_outbox/)
  assert.match(migration, /for update of events skip locked/)
  assert.match(migration, /earlier\.owner_id = events\.owner_id[\s\S]*earlier\.status <> 'completed'/)
  assert.match(migration, /status = 'processing'[\s\S]*attempts = claimed_event\.attempts \+ 1[\s\S]*lease_token = token/)
  assert.match(migration, /create or replace function public\.complete_memory_outbox/)
  assert.match(migration, /where id = p_outbox_id and status = 'processing' and lease_token = p_lease_token[\s\S]*for update/)
  assert.match(migration, /insert into public\.memory_graph_refs[\s\S]*update public\.memory_outbox/)
  assert.match(migration, /create or replace function public\.fail_memory_outbox/)
  assert.match(migration, /attempts < 8 then 'pending' else 'dead_letter'/)
  assert.match(migration, /revoke all on function public\.claim_memory_outbox/)
  assert.match(migration, /grant execute on function public\.claim_memory_outbox\(integer\) to service_role/)
  assert.match(rollback, /Refusing|cannot represent/)
  assert.match(rollback, /having count\(\*\) > 1/)
  assert.match(rollback, /create unique index memory_graph_refs_decision/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /commit;\s*$/)
})

test('learned communication rules constrain candidates and preserve selected-action learning', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260722020000_learned_communication_actions.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260722020000_learned_communication_actions.sql', root), 'utf8')
  assert.match(migration, /^begin;/)
  assert.match(migration, /schema_version in \(1, 2, 3\)/)
  assert.match(migration, /create table public\.ping_rule_action_candidates/)
  assert.match(migration, /foreign key \(owner_id, rule_id\).*ping_rules\(owner_id, id\)/)
  assert.match(migration, /foreign key \(owner_id, identity_id\).*memory_identities\(owner_id, id\)/)
  assert.match(migration, /check \(\(identity_id is null\) = \(identity_version is null\)\)/)
  assert.match(migration, /jsonb_array_length\(p_action_candidates\) not between 1 and 8/)
  assert.match(migration, /identities\.version = \(candidate->>'identity_version'\)::integer/)
  assert.match(migration, /create or replace function public\.prepare_ping_rule_approval_v3/)
  assert.match(migration, /selected_action_connection_id = candidate\.connection_id/)
  assert.match(migration, /coalesce\(event\.selected_action_connection_id, rule\.action_connection_id\)/)
  assert.match(migration, /encrypted_candidate_payload/)
  assert.match(migration, /rules\.schema_version in \(2, 3\)/)
  assert.match(rollback, /Refusing rollback while learned communication rules exist/)
  assert.match(rollback, /drop table if exists public\.ping_rule_action_candidates/)
  assert.match(rollback, /schema_version in \(1, 2\)/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /commit;\s*$/)
})

test('live context policies are normalized, fail-safe, indexed, and reversible', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260722030000_voice_context_policies.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260722030000_voice_context_policies.sql', root), 'utf8')
  assert.match(migration, /^begin;/)
  assert.match(migration, /add column required boolean not null default true/)
  assert.match(migration, /activation in \('always', 'scheduling_intent', 'selected_recipient', 'selected_thread'\)/)
  assert.match(migration, /required and failure_policy = 'abort'/)
  assert.match(migration, /create trigger apply_ping_context_policy_before_write/)
  assert.match(migration, /rules\.definition->'context'->new\.position->'policy'/)
  assert.match(rollback, /Refusing rollback while context policies would be lost/)
  assert.match(rollback, /drop trigger if exists apply_ping_context_policy_before_write/)
  assert.match(migration, /commit;\s*$/)
  assert.match(rollback, /commit;\s*$/)
})

test('voice example lookup has an owner-scoped eligible recency index', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260722040000_voice_example_lookup.sql', root), 'utf8')
  const rollback = await readFile(new URL('supabase/rollback/20260722040000_voice_example_lookup.sql', root), 'utf8')
  assert.match(migration, /memory_message_examples_owner_eligible_recent/)
  assert.match(migration, /owner_id, eligibility, occurred_at desc, id desc/)
  assert.match(migration, /where deleted_at is null/)
  assert.match(rollback, /drop index if exists public\.memory_message_examples_owner_eligible_recent/)
})

test('local Supabase startup replays tracked migrations and injects local credentials', async () => {
  const config = await readFile(new URL('supabase/config.toml', root), 'utf8')
  const launcher = await readFile(new URL('scripts/local.sh', root), 'utf8')

  assert.match(config, /\[db\.migrations\]\s+enabled = true/)
  assert.match(config, /\[db\.seed\]\s+enabled = false/)
  assert.match(launcher, /supabase db reset --local/)
  assert.match(launcher, /supabase status -o env/)
  assert.match(launcher, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/)
  assert.match(launcher, /SUPABASE_SECRET_KEY/)
})
