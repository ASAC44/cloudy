begin;

create unique index if not exists approval_requests_owner_id_unique
  on public.approval_requests(owner_id, id);

alter table public.ping_rules
  drop constraint if exists ping_rules_schema_version_check;

alter table public.ping_rules
  alter column schema_version set default 2,
  add constraint ping_rules_schema_version_check check (schema_version in (1, 2)),
  add column status text not null default 'paused'
    check (status in ('active', 'paused', 'needs_attention')),
  add column action_connection_id uuid,
  add column action_capability_id text
    check (action_capability_id is null or char_length(action_capability_id) between 1 and 300),
  add column action_capability_name text
    check (action_capability_name is null or char_length(action_capability_name) between 1 and 160),
  add column action_capability_schema_hash text
    check (action_capability_schema_hash is null or action_capability_schema_hash ~ '^[0-9a-f]{64}$'),
  add column action_capability_safety text
    check (action_capability_safety is null or action_capability_safety = 'verified_write'),
  add column activated_at timestamptz,
  add constraint ping_rules_action_complete check (
    (action_connection_id is null and action_capability_id is null and action_capability_name is null
      and action_capability_schema_hash is null and action_capability_safety is null)
    or
    (action_connection_id is not null and action_capability_id is not null and action_capability_name is not null
      and action_capability_schema_hash is not null and action_capability_safety = 'verified_write')
  ),
  add constraint ping_rules_owner_action_connection_fkey
    foreign key (owner_id, action_connection_id)
    references public.connections(owner_id, id) on delete restrict;

update public.ping_rules
set status = 'paused', schema_version = 1
where schema_version = 1;

create index ping_rules_active_source
  on public.ping_rules(source_connection_id, id)
  where status = 'active';

create index ping_rules_action_connection
  on public.ping_rules(action_connection_id)
  where action_connection_id is not null;

create table public.ping_rule_runtime_states (
  rule_id uuid primary key references public.ping_rules(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(cursor) = 'object'),
  baseline_completed boolean not null default false,
  next_run_at timestamptz not null default now(),
  lease_token uuid,
  leased_until timestamptz,
  consecutive_failures smallint not null default 0 check (consecutive_failures between 0 and 100),
  schema_drift boolean not null default false,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_run_at timestamptz,
  last_event_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (owner_id, rule_id),
  foreign key (owner_id, rule_id)
    references public.ping_rules(owner_id, id) on delete cascade,
  check ((lease_token is null) = (leased_until is null))
);

create index ping_rule_runtime_due
  on public.ping_rule_runtime_states(next_run_at, rule_id)
  where schema_drift = false;

create index ping_rule_runtime_owner
  on public.ping_rule_runtime_states(owner_id, updated_at desc);

create table public.ping_rule_context_bindings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid not null,
  position smallint not null check (position between 0 and 2),
  connection_id uuid not null,
  capability_id text not null check (char_length(capability_id) between 1 and 300),
  capability_name text not null check (char_length(capability_name) between 1 and 160),
  capability_schema_hash text not null check (capability_schema_hash ~ '^[0-9a-f]{64}$'),
  arguments jsonb not null default '{}'::jsonb check (jsonb_typeof(arguments) = 'object'),
  created_at timestamptz not null default now(),
  unique (rule_id, position),
  foreign key (owner_id, rule_id)
    references public.ping_rules(owner_id, id) on delete cascade,
  foreign key (owner_id, connection_id)
    references public.connections(owner_id, id) on delete restrict
);

create index ping_rule_context_connection
  on public.ping_rule_context_bindings(connection_id);

create table public.ping_rule_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid not null,
  event_identity text not null check (char_length(event_identity) between 1 and 500),
  conversation_key text check (conversation_key is null or char_length(conversation_key) <= 300),
  provider_event_id text check (provider_event_id is null or char_length(provider_event_id) <= 300),
  occurred_at timestamptz not null,
  status text not null default 'detected' check (status in (
    'detected', 'evaluating', 'ignored', 'pending_approval', 'approved', 'rejected', 'expired',
    'superseded', 'delivering', 'delivered', 'failed', 'ambiguous'
  )),
  encrypted_source_payload text,
  encrypted_draft_payload text,
  encrypted_action_payload text,
  action_payload_hash text check (action_payload_hash is null or action_payload_hash ~ '^[0-9a-f]{64}$'),
  approval_request_id uuid unique,
  delivery_idempotency_key uuid not null default gen_random_uuid(),
  telegram_random_id text check (telegram_random_id is null or telegram_random_id ~ '^-?[0-9]{1,20}$'),
  attempts smallint not null default 0 check (attempts between 0 and 100),
  next_attempt_at timestamptz not null default now(),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  lease_token uuid,
  leased_until timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rule_id, event_identity),
  foreign key (owner_id, rule_id)
    references public.ping_rules(owner_id, id) on delete cascade,
  foreign key (owner_id, approval_request_id)
    references public.approval_requests(owner_id, id) on delete cascade,
  check ((lease_token is null) = (leased_until is null))
);

create index ping_rule_events_evaluation_queue
  on public.ping_rule_events(next_attempt_at, created_at, id)
  where status in ('detected', 'evaluating');

create index ping_rule_events_delivery_queue
  on public.ping_rule_events(next_attempt_at, updated_at, id)
  where status in ('pending_approval', 'approved', 'delivering');

create index ping_rule_events_owner_activity
  on public.ping_rule_events(owner_id, rule_id, occurred_at desc, id desc);

create table public.ping_rule_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid not null,
  event_id uuid references public.ping_rule_events(id) on delete set null,
  stage text not null check (stage in ('poll', 'receive', 'evaluate', 'context', 'approval', 'deliver', 'retention')),
  outcome text not null check (outcome in ('started', 'succeeded', 'ignored', 'failed', 'ambiguous')),
  error_code text check (error_code is null or char_length(error_code) <= 100),
  error_message text check (error_message is null or char_length(error_message) <= 500),
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 3600000),
  created_at timestamptz not null default now(),
  foreign key (owner_id, rule_id)
    references public.ping_rules(owner_id, id) on delete cascade
);

create index ping_rule_runs_owner_activity
  on public.ping_rule_runs(owner_id, rule_id, created_at desc, id desc);

create index ping_rule_runs_event
  on public.ping_rule_runs(event_id)
  where event_id is not null;

create table public.telegram_auth_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  connection_name text not null check (char_length(connection_name) between 1 and 80),
  status text not null default 'pending_qr' check (status in (
    'pending_qr', 'waiting_2fa', 'connected', 'failed', 'cancelled', 'expired'
  )),
  encrypted_qr_payload text,
  qr_expires_at timestamptz,
  password_hint text check (password_hint is null or char_length(password_hint) <= 160),
  encrypted_password text,
  connection_id uuid,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  lease_token uuid,
  worker_id text check (worker_id is null or char_length(worker_id) <= 160),
  leased_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  foreign key (owner_id, connection_id)
    references public.connections(owner_id, id) on delete cascade,
  check ((lease_token is null) = (leased_until is null))
);

create unique index telegram_auth_one_active_owner
  on public.telegram_auth_sessions(owner_id)
  where status in ('pending_qr', 'waiting_2fa');

create index telegram_auth_claim_queue
  on public.telegram_auth_sessions(created_at, id)
  where status in ('pending_qr', 'waiting_2fa');

create table public.connection_runtime_leases (
  connection_id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  worker_id text not null check (char_length(worker_id) between 1 and 160),
  lease_token uuid not null,
  leased_until timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  foreign key (owner_id, connection_id)
    references public.connections(owner_id, id) on delete cascade
);

create index connection_runtime_lease_expiry
  on public.connection_runtime_leases(leased_until);

alter table public.ping_rule_runtime_states enable row level security;
alter table public.ping_rule_context_bindings enable row level security;
alter table public.ping_rule_events enable row level security;
alter table public.ping_rule_runs enable row level security;
alter table public.telegram_auth_sessions enable row level security;
alter table public.connection_runtime_leases enable row level security;

create policy "Users can read their Ping rules"
  on public.ping_rules for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Users can read their Ping runtime"
  on public.ping_rule_runtime_states for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Users can read their Ping context bindings"
  on public.ping_rule_context_bindings for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Users can read their Ping events"
  on public.ping_rule_events for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Users can read their Ping runs"
  on public.ping_rule_runs for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Users can read their Telegram setup"
  on public.telegram_auth_sessions for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Users can read their connection leases"
  on public.connection_runtime_leases for select to authenticated
  using ((select auth.uid()) = owner_id);

revoke all on public.ping_rule_runtime_states from anon, authenticated;
revoke all on public.ping_rule_context_bindings from anon, authenticated;
revoke all on public.ping_rule_events from anon, authenticated;
revoke all on public.ping_rule_runs from anon, authenticated;
revoke all on public.telegram_auth_sessions from anon, authenticated;
revoke all on public.connection_runtime_leases from anon, authenticated;

create or replace function public.commit_ping_rule_session_v2(
  p_owner_id uuid,
  p_session_id uuid,
  p_expected_revision integer,
  p_source_connection_id uuid,
  p_title text,
  p_intent_summary text,
  p_capability_id text,
  p_capability_name text,
  p_capability_schema_hash text,
  p_definition jsonb,
  p_context_bindings jsonb,
  p_action_connection_id uuid,
  p_action_capability_id text,
  p_action_capability_name text,
  p_action_capability_schema_hash text
)
returns public.ping_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  session public.rule_builder_sessions;
  rule public.ping_rules;
begin
  select * into session
  from public.rule_builder_sessions
  where id = p_session_id and owner_id = p_owner_id
  for update;

  if session.id is null then
    raise exception 'rule_session_not_found' using errcode = 'P0001';
  end if;
  if session.status = 'completed' and session.completed_rule_id is not null then
    select * into rule from public.ping_rules where id = session.completed_rule_id and owner_id = p_owner_id;
    return rule;
  end if;
  if session.expires_at <= now() then
    raise exception 'rule_session_expired' using errcode = 'P0001';
  end if;
  if session.revision <> p_expected_revision then
    raise exception 'rule_session_conflict' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_definition) <> 'object' or p_definition->>'schema_version' <> '2'
    or jsonb_typeof(p_context_bindings) <> 'array'
    or jsonb_array_length(p_context_bindings) > 3 then
    raise exception 'invalid_rule_definition' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.pods
    where id = session.destination_pod_id and owner_id = p_owner_id and revoked_at is null
  ) then
    raise exception 'rule_pod_unavailable' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.connections
    where id = p_source_connection_id and owner_id = p_owner_id and status = 'connected'
  ) then
    raise exception 'rule_connection_unavailable' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_context_bindings) binding
    where not exists (
      select 1 from public.connections
      where id = (binding->>'connection_id')::uuid and owner_id = p_owner_id and status = 'connected'
    )
  ) then
    raise exception 'rule_connection_unavailable' using errcode = 'P0001';
  end if;
  if p_action_connection_id is not null and not exists (
    select 1 from public.connections
    where id = p_action_connection_id and owner_id = p_owner_id and status = 'connected'
  ) then
    raise exception 'rule_connection_unavailable' using errcode = 'P0001';
  end if;

  if session.editing_rule_id is null then
    insert into public.ping_rules(
      owner_id, destination_pod_id, source_connection_id, title, intent_summary,
      capability_id, capability_name, capability_schema_hash, capability_safety,
      definition, schema_version, status, action_connection_id, action_capability_id,
      action_capability_name, action_capability_schema_hash, action_capability_safety, activated_at
    ) values (
      p_owner_id, session.destination_pod_id, p_source_connection_id, p_title, p_intent_summary,
      p_capability_id, p_capability_name, p_capability_schema_hash, 'verified_read',
      p_definition, 2, 'active', p_action_connection_id, p_action_capability_id,
      p_action_capability_name, p_action_capability_schema_hash,
      case when p_action_connection_id is null then null else 'verified_write' end, now()
    ) returning * into rule;
  else
    select * into rule
    from public.ping_rules
    where id = session.editing_rule_id and owner_id = p_owner_id
    for update;
    if rule.id is null then
      raise exception 'rule_not_found' using errcode = 'P0001';
    end if;
    if rule.revision <> session.base_rule_revision then
      raise exception 'rule_edit_conflict' using errcode = 'P0001';
    end if;

    update public.approval_requests requests
    set status = 'cancelled', decided_at = now()
    where requests.status = 'pending' and requests.id in (
      select approval_request_id from public.ping_rule_events
      where rule_id = rule.id and approval_request_id is not null
    );
    update public.ping_rule_events
    set status = 'superseded', resolved_at = now(), lease_token = null, leased_until = null, updated_at = now()
    where rule_id = rule.id and status in ('detected', 'evaluating', 'pending_approval', 'approved', 'delivering');

    update public.ping_rules
    set source_connection_id = p_source_connection_id,
        destination_pod_id = session.destination_pod_id,
        title = p_title,
        intent_summary = p_intent_summary,
        capability_id = p_capability_id,
        capability_name = p_capability_name,
        capability_schema_hash = p_capability_schema_hash,
        capability_safety = 'verified_read',
        definition = p_definition,
        schema_version = 2,
        status = 'active',
        action_connection_id = p_action_connection_id,
        action_capability_id = p_action_capability_id,
        action_capability_name = p_action_capability_name,
        action_capability_schema_hash = p_action_capability_schema_hash,
        action_capability_safety = case when p_action_connection_id is null then null else 'verified_write' end,
        activated_at = now(),
        revision = revision + 1,
        updated_at = now()
    where id = rule.id
    returning * into rule;
  end if;

  delete from public.ping_rule_context_bindings where rule_id = rule.id;
  insert into public.ping_rule_context_bindings(
    owner_id, rule_id, position, connection_id, capability_id, capability_name,
    capability_schema_hash, arguments
  )
  select p_owner_id, rule.id, (entry.ordinality - 1)::smallint,
    (entry.binding->>'connection_id')::uuid,
    entry.binding->>'capability_id',
    entry.binding->>'capability_name',
    entry.binding->>'capability_schema_hash',
    coalesce(entry.binding->'arguments', '{}'::jsonb)
  from jsonb_array_elements(p_context_bindings) with ordinality as entry(binding, ordinality);

  insert into public.ping_rule_runtime_states(
    rule_id, owner_id, cursor, baseline_completed, next_run_at, consecutive_failures,
    schema_drift, last_error, lease_token, leased_until, updated_at
  ) values (
    rule.id, p_owner_id, '{}'::jsonb, false, now(), 0, false, null, null, null, now()
  )
  on conflict (rule_id) do update
  set cursor = '{}'::jsonb,
      baseline_completed = false,
      next_run_at = now(),
      consecutive_failures = 0,
      schema_drift = false,
      last_error = null,
      lease_token = null,
      leased_until = null,
      updated_at = now();

  update public.rule_builder_sessions
  set status = 'completed', completed_rule_id = rule.id,
      messages = '[]'::jsonb, draft = '{}'::jsonb,
      capability_snapshot = '[]'::jsonb, last_reply = '{}'::jsonb,
      revision = revision + 1, updated_at = now()
  where id = session.id;

  return rule;
end;
$$;

create or replace function public.set_ping_rule_status(
  p_owner_id uuid,
  p_rule_id uuid,
  p_expected_revision integer,
  p_status text
)
returns public.ping_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  rule public.ping_rules;
begin
  if p_status not in ('active', 'paused') then
    raise exception 'invalid_rule_status' using errcode = 'P0001';
  end if;
  select * into rule from public.ping_rules
  where id = p_rule_id and owner_id = p_owner_id for update;
  if rule.id is null then raise exception 'rule_not_found' using errcode = 'P0001'; end if;
  if rule.revision <> p_expected_revision then raise exception 'rule_edit_conflict' using errcode = 'P0001'; end if;
  if p_status = 'active' and rule.schema_version <> 2 then
    raise exception 'rule_review_required' using errcode = 'P0001';
  end if;
  if p_status = 'active' and (
    not exists (
      select 1 from public.connections
      where id = rule.source_connection_id and owner_id = p_owner_id and status = 'connected'
    )
    or exists (
      select 1 from public.ping_rule_context_bindings bindings
      where bindings.rule_id = rule.id and not exists (
        select 1 from public.connections
        where id = bindings.connection_id and owner_id = p_owner_id and status = 'connected'
      )
    )
    or (rule.action_connection_id is not null and not exists (
      select 1 from public.connections
      where id = rule.action_connection_id and owner_id = p_owner_id and status = 'connected'
    ))
    or exists (
      select 1 from public.ping_rule_runtime_states
      where rule_id = rule.id and schema_drift = true
    )
  ) then
    raise exception 'rule_review_required' using errcode = 'P0001';
  end if;

  if p_status = 'paused' then
    update public.approval_requests requests
    set status = 'cancelled', decided_at = now()
    where requests.status = 'pending' and requests.id in (
      select approval_request_id from public.ping_rule_events
      where rule_id = rule.id and approval_request_id is not null
    );
    update public.ping_rule_events
    set status = 'superseded', resolved_at = now(), lease_token = null, leased_until = null, updated_at = now()
    where rule_id = rule.id and status in ('detected', 'evaluating', 'pending_approval', 'approved', 'delivering');
  end if;

  update public.ping_rules
  set status = p_status, revision = revision + 1, updated_at = now(),
      activated_at = case when p_status = 'active' then now() else activated_at end
  where id = rule.id returning * into rule;

  update public.ping_rule_runtime_states
  set next_run_at = case when p_status = 'active' then now() else next_run_at end,
      cursor = case when p_status = 'active' then '{}'::jsonb else cursor end,
      baseline_completed = case when p_status = 'active' then false else baseline_completed end,
      consecutive_failures = case when p_status = 'active' then 0 else consecutive_failures end,
      last_error = case when p_status = 'active' then null else last_error end,
      lease_token = null, leased_until = null, updated_at = now()
  where rule_id = rule.id;
  return rule;
end;
$$;

create or replace function public.delete_ping_rule(p_owner_id uuid, p_rule_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.ping_rules where id = p_rule_id and owner_id = p_owner_id for update;
  if not found then return false; end if;

  update public.approval_requests requests
  set status = 'cancelled', decided_at = now()
  where requests.status = 'pending' and requests.id in (
    select approval_request_id from public.ping_rule_events
    where rule_id = p_rule_id and approval_request_id is not null
  );
  delete from public.ping_rules where id = p_rule_id and owner_id = p_owner_id;
  return true;
end;
$$;

create or replace function public.claim_due_ping_rule(p_worker_id text, p_lease_seconds integer default 45)
returns table(rule_id uuid, owner_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.ping_rule_runtime_states;
  token uuid := gen_random_uuid();
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception 'invalid_worker_id' using errcode = 'P0001';
  end if;
  select states.* into claimed
  from public.ping_rule_runtime_states states
  join public.ping_rules rules on rules.id = states.rule_id
  where rules.status = 'active' and rules.schema_version = 2
    and coalesce(rules.definition->'source'->>'delivery', 'poll') = 'poll'
    and states.schema_drift = false and states.next_run_at <= now()
    and (states.leased_until is null or states.leased_until < now())
  order by states.next_run_at, states.rule_id
  for update of states skip locked
  limit 1;
  if claimed.rule_id is null then return; end if;
  update public.ping_rule_runtime_states
  set lease_token = token,
      leased_until = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300))),
      updated_at = now()
  where ping_rule_runtime_states.rule_id = claimed.rule_id;
  return query select claimed.rule_id, claimed.owner_id, token;
end;
$$;

create or replace function public.complete_ping_rule_run(
  p_rule_id uuid,
  p_lease_token uuid,
  p_success boolean,
  p_next_run_at timestamptz,
  p_cursor jsonb,
  p_baseline_completed boolean,
  p_schema_drift boolean,
  p_last_error text,
  p_last_event_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  failures smallint;
  owner uuid;
begin
  update public.ping_rule_runtime_states
  set cursor = coalesce(p_cursor, cursor),
      baseline_completed = p_baseline_completed,
      next_run_at = p_next_run_at,
      consecutive_failures = case when p_success then 0 else least(100, consecutive_failures + 1) end,
      schema_drift = p_schema_drift,
      last_error = case when p_success then null else left(coalesce(p_last_error, 'Execution failed'), 500) end,
      last_run_at = now(),
      last_event_at = coalesce(p_last_event_at, last_event_at),
      lease_token = null, leased_until = null, updated_at = now()
  where rule_id = p_rule_id and lease_token = p_lease_token
  returning consecutive_failures, owner_id into failures, owner;
  if not found then return false; end if;
  if failures >= 3 or p_schema_drift then
    update public.ping_rules
    set status = 'needs_attention', revision = revision + 1, updated_at = now()
    where id = p_rule_id and owner_id = owner and status = 'active';
  end if;
  return true;
end;
$$;

create or replace function public.enqueue_ping_rule_event(
  p_owner_id uuid,
  p_rule_id uuid,
  p_event_identity text,
  p_conversation_key text,
  p_provider_event_id text,
  p_occurred_at timestamptz,
  p_encrypted_source_payload text,
  p_telegram_random_id text
)
returns table(event_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved uuid;
begin
  insert into public.ping_rule_events(
    owner_id, rule_id, event_identity, conversation_key, provider_event_id,
    occurred_at, encrypted_source_payload, telegram_random_id
  ) values (
    p_owner_id, p_rule_id, p_event_identity, p_conversation_key, p_provider_event_id,
    p_occurred_at, p_encrypted_source_payload, p_telegram_random_id
  ) on conflict (rule_id, event_identity) do nothing
  returning id into saved;
  if saved is not null then
    return query select saved, true;
    return;
  end if;
  return query select id, false from public.ping_rule_events
    where rule_id = p_rule_id and event_identity = p_event_identity;
end;
$$;

create or replace function public.claim_ping_rule_event(p_lease_seconds integer default 90)
returns table(event_id uuid, owner_id uuid, rule_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.ping_rule_events;
  token uuid := gen_random_uuid();
begin
  select events.* into claimed
  from public.ping_rule_events events
  join public.ping_rules rules on rules.id = events.rule_id
  where rules.status = 'active'
    and events.next_attempt_at <= now()
    and (events.status = 'detected' or (events.status = 'evaluating' and events.leased_until < now()))
  order by events.created_at, events.id
  for update of events skip locked limit 1;
  if claimed.id is null then return; end if;
  update public.ping_rule_events
  set status = 'evaluating', lease_token = token,
      leased_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 300))),
      attempts = attempts + 1, updated_at = now()
  where id = claimed.id;
  return query select claimed.id, claimed.owner_id, claimed.rule_id, token;
end;
$$;

create or replace function public.ignore_ping_rule_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ping_rule_events
  set status = 'ignored', resolved_at = now(), last_error = left(p_reason, 500),
      lease_token = null, leased_until = null, updated_at = now()
  where id = p_event_id and status = 'evaluating' and lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.fail_ping_rule_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_error text,
  p_ambiguous boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_rule uuid;
  event_attempts smallint;
begin
  update public.ping_rule_events
  set status = case when p_ambiguous then 'ambiguous' when attempts >= 3 then 'failed' else 'detected' end,
      resolved_at = case when p_ambiguous or attempts >= 3 then now() else null end,
      next_attempt_at = case attempts when 1 then now() + interval '5 seconds' else now() + interval '30 seconds' end,
      last_error = left(coalesce(p_error, 'Execution failed'), 500),
      lease_token = null, leased_until = null, updated_at = now()
  where id = p_event_id and lease_token = p_lease_token
  returning rule_id, attempts into event_rule, event_attempts;
  if not found then return false; end if;
  if p_ambiguous or event_attempts >= 3 then
    update public.ping_rules set status = 'needs_attention', revision = revision + 1, updated_at = now()
    where id = event_rule and status = 'active';
  end if;
  return true;
end;
$$;

create or replace function public.prepare_ping_rule_approval(
  p_event_id uuid,
  p_lease_token uuid,
  p_encrypted_draft_payload text,
  p_encrypted_action_payload text,
  p_action_payload_hash text,
  p_title text,
  p_source text,
  p_summary text,
  p_details text,
  p_affected_context text,
  p_risk text,
  p_warnings text[],
  p_expires_at timestamptz
)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  event public.ping_rule_events;
  old_event public.ping_rule_events;
  request public.approval_requests;
begin
  select * into event from public.ping_rule_events
  where id = p_event_id and status = 'evaluating' and lease_token = p_lease_token for update;
  if event.id is null then raise exception 'ping_event_conflict' using errcode = 'P0001'; end if;
  if p_action_payload_hash !~ '^[0-9a-f]{64}$' or p_expires_at <= now() then
    raise exception 'invalid_ping_approval' using errcode = 'P0001';
  end if;

  if event.conversation_key is not null then
    for old_event in
      select * from public.ping_rule_events
      where rule_id = event.rule_id and conversation_key = event.conversation_key
        and id <> event.id and status in ('pending_approval', 'approved')
      for update
    loop
      update public.approval_requests set status = 'cancelled', decided_at = now()
      where id = old_event.approval_request_id and status in ('pending', 'approved');
      update public.ping_rule_events
      set status = 'superseded', resolved_at = now(), updated_at = now()
      where id = old_event.id;
    end loop;
  end if;

  insert into public.approval_requests(
    owner_id, title, source, summary, details, affected_context, risk, warnings,
    priority, action_payload, payload_hash, expires_at
  ) values (
    event.owner_id, p_title, p_source, left(p_summary, 2000), left(p_details, 8000), left(p_affected_context, 2000), p_risk,
    coalesce(p_warnings, '{}'::text[]), case when p_risk = 'high' then 2 when p_risk = 'medium' then 1 else 0 end,
    jsonb_build_object('kind', 'ping_rule_action', 'event_id', event.id, 'rule_id', event.rule_id,
      'action_hash', p_action_payload_hash),
    p_action_payload_hash, p_expires_at
  ) returning * into request;

  update public.ping_rule_events
  set status = 'pending_approval', encrypted_draft_payload = p_encrypted_draft_payload,
      encrypted_action_payload = p_encrypted_action_payload, action_payload_hash = p_action_payload_hash,
      approval_request_id = request.id, lease_token = null, leased_until = null, updated_at = now()
  where id = event.id;
  return request;
end;
$$;

create or replace function public.sync_ping_event_approval_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'approved' then
    update public.ping_rule_events set status = 'approved', updated_at = now()
    where approval_request_id = new.id and status = 'pending_approval';
  elsif new.status in ('rejected', 'expired', 'cancelled') then
    update public.ping_rule_events
    set status = case new.status when 'rejected' then 'rejected' when 'expired' then 'expired' else 'superseded' end,
        resolved_at = now(), lease_token = null, leased_until = null, updated_at = now()
    where approval_request_id = new.id and status in ('pending_approval', 'approved');
  end if;
  return new;
end;
$$;

create trigger sync_ping_event_after_approval
after update of status on public.approval_requests
for each row when (old.status is distinct from new.status)
execute function public.sync_ping_event_approval_status();

create or replace function public.claim_approved_ping_action(p_lease_seconds integer default 90)
returns table(event_id uuid, owner_id uuid, rule_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.ping_rule_events;
  token uuid := gen_random_uuid();
begin
  select events.* into claimed
  from public.ping_rule_events events
  join public.ping_rules rules on rules.id = events.rule_id and rules.status = 'active'
  join public.approval_requests requests on requests.id = events.approval_request_id and requests.status = 'approved'
  where events.next_attempt_at <= now()
    and (events.status = 'approved' or (events.status = 'delivering' and events.leased_until < now()))
  order by requests.decided_at, events.id
  for update of events skip locked limit 1;
  if claimed.id is null then return; end if;
  update public.ping_rule_events
  set status = 'delivering', lease_token = token,
      leased_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 300))),
      attempts = attempts + 1, updated_at = now()
  where id = claimed.id;
  return query select claimed.id, claimed.owner_id, claimed.rule_id, token;
end;
$$;

create or replace function public.complete_ping_action(
  p_event_id uuid,
  p_lease_token uuid,
  p_delivered boolean,
  p_retryable boolean,
  p_ambiguous boolean,
  p_superseded boolean,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_rule uuid;
begin
  update public.ping_rule_events
  set status = case
        when p_delivered then 'delivered'
        when p_superseded then 'superseded'
        when p_ambiguous then 'ambiguous'
        when p_retryable and attempts < 3 then 'approved'
        else 'failed'
      end,
      resolved_at = case when p_delivered or p_superseded or p_ambiguous or attempts >= 3 or not p_retryable then now() else null end,
      next_attempt_at = case attempts when 1 then now() + interval '5 seconds' else now() + interval '30 seconds' end,
      last_error = case when p_delivered then null else left(coalesce(p_error, 'Delivery failed'), 500) end,
      lease_token = null, leased_until = null, updated_at = now()
  where id = p_event_id and status = 'delivering' and lease_token = p_lease_token
  returning rule_id into event_rule;
  if not found then return false; end if;
  if p_ambiguous or (not p_delivered and not p_superseded and (
    not p_retryable or (select attempts >= 3 from public.ping_rule_events where id = p_event_id)
  )) then
    update public.ping_rules set status = 'needs_attention', revision = revision + 1, updated_at = now()
    where id = event_rule and status = 'active';
  end if;
  return true;
end;
$$;

create or replace function public.claim_connection_runtime_lease(
  p_owner_id uuid,
  p_connection_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 45
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.connection_runtime_leases;
  token uuid := gen_random_uuid();
begin
  if not exists (
    select 1 from public.connections
    where id = p_connection_id and owner_id = p_owner_id and provider = 'telegram' and status = 'connected'
  ) then return null; end if;
  select * into existing from public.connection_runtime_leases
  where connection_id = p_connection_id for update;
  if existing.connection_id is not null and existing.leased_until >= now() and existing.worker_id <> p_worker_id then
    return null;
  end if;
  insert into public.connection_runtime_leases(connection_id, owner_id, worker_id, lease_token, leased_until)
  values (p_connection_id, p_owner_id, p_worker_id, token,
    now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300))))
  on conflict (connection_id) do update
  set worker_id = excluded.worker_id, lease_token = excluded.lease_token,
      leased_until = excluded.leased_until, heartbeat_at = now();
  return token;
end;
$$;

create or replace function public.record_ping_connection_health(
  p_owner_id uuid,
  p_connection_id uuid,
  p_success boolean,
  p_error text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.ping_rule_runtime_states states
  set consecutive_failures = case when p_success then 0 else least(100, states.consecutive_failures + 1) end,
      last_error = case when p_success then null else left(coalesce(p_error, 'Connection failed'), 500) end,
      updated_at = now()
  from public.ping_rules rules
  where rules.id = states.rule_id and rules.owner_id = p_owner_id
    and rules.source_connection_id = p_connection_id and rules.status = 'active'
    and rules.schema_version = 2 and rules.definition->'source'->>'delivery' = 'event';
  get diagnostics affected = row_count;
  if not p_success then
    update public.ping_rules rules
    set status = 'needs_attention', revision = revision + 1, updated_at = now()
    where rules.owner_id = p_owner_id and rules.source_connection_id = p_connection_id
      and rules.status = 'active' and exists (
        select 1 from public.ping_rule_runtime_states states
        where states.rule_id = rules.id and states.consecutive_failures >= 3
      );
  end if;
  return affected;
end;
$$;

create or replace function public.create_telegram_auth_session(p_owner_id uuid, p_connection_name text)
returns public.telegram_auth_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.telegram_auth_sessions;
begin
  update public.telegram_auth_sessions
  set status = 'expired', updated_at = now()
  where owner_id = p_owner_id and status in ('pending_qr', 'waiting_2fa') and expires_at <= now();
  if exists (
    select 1 from public.telegram_auth_sessions
    where owner_id = p_owner_id and status in ('pending_qr', 'waiting_2fa')
  ) then raise exception 'telegram_auth_in_progress' using errcode = 'P0001'; end if;
  insert into public.telegram_auth_sessions(owner_id, connection_name)
  values (p_owner_id, p_connection_name) returning * into saved;
  return saved;
end;
$$;

create or replace function public.submit_telegram_auth_password(
  p_owner_id uuid,
  p_session_id uuid,
  p_encrypted_password text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.telegram_auth_sessions
  set encrypted_password = p_encrypted_password, updated_at = now()
  where id = p_session_id and owner_id = p_owner_id and status = 'waiting_2fa' and expires_at > now();
  return found;
end;
$$;

create or replace function public.cancel_telegram_auth_session(p_owner_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.telegram_auth_sessions
  set status = 'cancelled', encrypted_qr_payload = null, encrypted_password = null,
      lease_token = null, leased_until = null, updated_at = now()
  where id = p_session_id and owner_id = p_owner_id and status in ('pending_qr', 'waiting_2fa');
  return found;
end;
$$;

create or replace function public.claim_telegram_auth_session(p_worker_id text, p_lease_seconds integer default 60)
returns table(session_id uuid, owner_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.telegram_auth_sessions;
  token uuid := gen_random_uuid();
begin
  update public.telegram_auth_sessions set status = 'expired', updated_at = now()
  where status in ('pending_qr', 'waiting_2fa') and expires_at <= now();
  select * into claimed from public.telegram_auth_sessions
  where status in ('pending_qr', 'waiting_2fa')
    and (leased_until is null or leased_until < now())
  order by created_at, id for update skip locked limit 1;
  if claimed.id is null then return; end if;
  update public.telegram_auth_sessions
  set worker_id = p_worker_id, lease_token = token,
      leased_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 300))), updated_at = now()
  where id = claimed.id;
  return query select claimed.id, claimed.owner_id, token;
end;
$$;

create or replace function public.complete_telegram_auth_session(
  p_session_id uuid,
  p_lease_token uuid,
  p_encrypted_connection_secret text,
  p_account_label text
)
returns public.connections
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth public.telegram_auth_sessions;
  connection public.connections;
begin
  select * into auth from public.telegram_auth_sessions
  where id = p_session_id and lease_token = p_lease_token
    and status in ('pending_qr', 'waiting_2fa') and expires_at > now() for update;
  if auth.id is null then raise exception 'telegram_auth_conflict' using errcode = 'P0001'; end if;
  insert into public.connections(
    owner_id, name, provider, protocol, endpoint_url, auth_type, status,
    account_label, last_tested_at
  ) values (
    auth.owner_id, auth.connection_name, 'telegram', 'rest', 'https://api.telegram.org',
    'oauth', 'connected', p_account_label, now()
  ) returning * into connection;
  insert into public.connection_secrets(connection_id, encrypted_payload)
  values (connection.id, p_encrypted_connection_secret);
  update public.telegram_auth_sessions
  set status = 'connected', connection_id = connection.id, encrypted_qr_payload = null,
      encrypted_password = null, lease_token = null, leased_until = null,
      last_error = null, updated_at = now()
  where id = auth.id;
  return connection;
end;
$$;

create or replace function public.purge_ping_runtime_data()
returns table(content_purged bigint, events_deleted bigint, runs_deleted bigint, auth_deleted bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  purged bigint;
  deleted_events bigint;
  deleted_runs bigint;
  deleted_auth bigint;
begin
  update public.ping_rule_events
  set encrypted_source_payload = null, encrypted_draft_payload = null,
      encrypted_action_payload = null, updated_at = now()
  where resolved_at < now() - interval '7 days'
    and (encrypted_source_payload is not null or encrypted_draft_payload is not null or encrypted_action_payload is not null);
  get diagnostics purged = row_count;
  delete from public.ping_rule_runs where created_at < now() - interval '30 days';
  get diagnostics deleted_runs = row_count;
  delete from public.ping_rule_events where resolved_at < now() - interval '30 days';
  get diagnostics deleted_events = row_count;
  delete from public.telegram_auth_sessions where expires_at < now() - interval '1 day';
  get diagnostics deleted_auth = row_count;
  return query select purged, deleted_events, deleted_runs, deleted_auth;
end;
$$;

revoke all on function public.commit_ping_rule_session_v2(uuid, uuid, integer, uuid, text, text, text, text, text, jsonb, jsonb, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.set_ping_rule_status(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.delete_ping_rule(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_due_ping_rule(text, integer) from public, anon, authenticated;
revoke all on function public.complete_ping_rule_run(uuid, uuid, boolean, timestamptz, jsonb, boolean, boolean, text, timestamptz) from public, anon, authenticated;
revoke all on function public.enqueue_ping_rule_event(uuid, uuid, text, text, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.claim_ping_rule_event(integer) from public, anon, authenticated;
revoke all on function public.ignore_ping_rule_event(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_ping_rule_event(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.prepare_ping_rule_approval(uuid, uuid, text, text, text, text, text, text, text, text, text, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.sync_ping_event_approval_status() from public, anon, authenticated;
revoke all on function public.claim_approved_ping_action(integer) from public, anon, authenticated;
revoke all on function public.complete_ping_action(uuid, uuid, boolean, boolean, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.claim_connection_runtime_lease(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.record_ping_connection_health(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.create_telegram_auth_session(uuid, text) from public, anon, authenticated;
revoke all on function public.submit_telegram_auth_password(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_telegram_auth_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_telegram_auth_session(text, integer) from public, anon, authenticated;
revoke all on function public.complete_telegram_auth_session(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.purge_ping_runtime_data() from public, anon, authenticated;

grant execute on function public.commit_ping_rule_session_v2(uuid, uuid, integer, uuid, text, text, text, text, text, jsonb, jsonb, uuid, text, text, text) to service_role;
grant execute on function public.set_ping_rule_status(uuid, uuid, integer, text) to service_role;
grant execute on function public.delete_ping_rule(uuid, uuid) to service_role;
grant execute on function public.claim_due_ping_rule(text, integer) to service_role;
grant execute on function public.complete_ping_rule_run(uuid, uuid, boolean, timestamptz, jsonb, boolean, boolean, text, timestamptz) to service_role;
grant execute on function public.enqueue_ping_rule_event(uuid, uuid, text, text, text, timestamptz, text, text) to service_role;
grant execute on function public.claim_ping_rule_event(integer) to service_role;
grant execute on function public.ignore_ping_rule_event(uuid, uuid, text) to service_role;
grant execute on function public.fail_ping_rule_event(uuid, uuid, text, boolean) to service_role;
grant execute on function public.prepare_ping_rule_approval(uuid, uuid, text, text, text, text, text, text, text, text, text, text[], timestamptz) to service_role;
grant execute on function public.claim_approved_ping_action(integer) to service_role;
grant execute on function public.complete_ping_action(uuid, uuid, boolean, boolean, boolean, boolean, text) to service_role;
grant execute on function public.claim_connection_runtime_lease(uuid, uuid, text, integer) to service_role;
grant execute on function public.create_telegram_auth_session(uuid, text) to service_role;
grant execute on function public.submit_telegram_auth_password(uuid, uuid, text) to service_role;
grant execute on function public.cancel_telegram_auth_session(uuid, uuid) to service_role;
grant execute on function public.claim_telegram_auth_session(text, integer) to service_role;
grant execute on function public.complete_telegram_auth_session(uuid, uuid, text, text) to service_role;
grant execute on function public.purge_ping_runtime_data() to service_role;

select cron.schedule(
  'podex-purge-ping-runtime-data',
  '43 3 * * *',
  'select public.purge_ping_runtime_data()'
)
where not exists (select 1 from cron.job where jobname = 'podex-purge-ping-runtime-data');

commit;
