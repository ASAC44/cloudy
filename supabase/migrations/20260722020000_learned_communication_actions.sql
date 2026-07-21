begin;

alter table public.ping_rules drop constraint ping_rules_schema_version_check;
alter table public.ping_rules add constraint ping_rules_schema_version_check
  check (schema_version in (1, 2, 3));

alter table public.ping_rule_events
  add column selected_candidate_id text check (selected_candidate_id is null or selected_candidate_id ~ '^[0-9a-f]{32}$'),
  add column selected_candidate_position smallint check (selected_candidate_position between 0 and 7),
  add column selected_action_connection_id uuid references public.connections(id) on delete set null,
  add column selected_action_capability_id text check (selected_action_capability_id is null or char_length(selected_action_capability_id) between 1 and 300),
  add column selected_person_id uuid,
  add column selected_identity_id uuid,
  add column selected_identity_version integer check (selected_identity_version is null or selected_identity_version > 0),
  add foreign key (owner_id, selected_person_id) references public.memory_people(owner_id, id) on delete restrict,
  add foreign key (owner_id, selected_identity_id) references public.memory_identities(owner_id, id) on delete restrict,
  add check ((selected_identity_id is null) = (selected_identity_version is null));

create index ping_rule_events_selected_identity
  on public.ping_rule_events(owner_id, selected_identity_id, occurred_at desc)
  where selected_identity_id is not null;

create table public.ping_rule_action_candidates (
  owner_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid not null,
  position smallint not null check (position between 0 and 7),
  connection_id uuid not null,
  capability_id text not null check (char_length(capability_id) between 1 and 300),
  capability_name text not null check (char_length(capability_name) between 1 and 300),
  capability_schema_hash text not null check (capability_schema_hash ~ '^[0-9a-f]{64}$'),
  arguments jsonb not null default '{}'::jsonb check (jsonb_typeof(arguments) = 'object'),
  descriptor jsonb not null check (jsonb_typeof(descriptor) = 'object'),
  identity_id uuid,
  identity_version integer,
  created_at timestamptz not null default now(),
  primary key (rule_id, position),
  unique (owner_id, rule_id, position),
  foreign key (owner_id, rule_id) references public.ping_rules(owner_id, id) on delete cascade,
  foreign key (owner_id, connection_id) references public.connections(owner_id, id) on delete restrict,
  foreign key (owner_id, identity_id) references public.memory_identities(owner_id, id) on delete restrict,
  check ((identity_id is null) = (identity_version is null)),
  check (descriptor->>'channel' in ('gmail', 'telegram')),
  check (descriptor->>'mode' in ('reply', 'new_message')),
  check (descriptor->>'body_argument' = 'message'),
  check (descriptor->>'recipient_argument' in ('thread_id', 'peer_id', 'to'))
);

create index ping_rule_action_candidates_connection
  on public.ping_rule_action_candidates(owner_id, connection_id, rule_id);
create index ping_rule_action_candidates_identity
  on public.ping_rule_action_candidates(owner_id, identity_id, rule_id)
  where identity_id is not null;

alter table public.ping_rule_action_candidates enable row level security;
revoke all on public.ping_rule_action_candidates from anon, authenticated;

create or replace function public.commit_ping_rule_session_v3(
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
  p_action_candidates jsonb
)
returns public.ping_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  rule public.ping_rules;
  session public.rule_builder_sessions;
begin
  select * into session from public.rule_builder_sessions
  where id = p_session_id and owner_id = p_owner_id for update;
  if session.id is null then raise exception 'rule_session_not_found' using errcode = 'P0001'; end if;
  if session.status = 'completed' and session.completed_rule_id is not null then
    select * into rule from public.ping_rules where id = session.completed_rule_id and owner_id = p_owner_id;
    return rule;
  end if;
  if jsonb_typeof(p_definition) <> 'object' or p_definition->>'schema_version' <> '3'
    or p_definition->'action_policy'->>'mode' <> 'learned_communication'
    or jsonb_typeof(p_action_candidates) <> 'array'
    or jsonb_array_length(p_action_candidates) not between 1 and 8 then
    raise exception 'invalid_rule_definition' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_action_candidates) candidate
    where jsonb_typeof(candidate) <> 'object'
      or not exists (
        select 1 from public.connections connections
        where connections.id = (candidate->>'connection_id')::uuid
          and connections.owner_id = p_owner_id and connections.status = 'connected'
      )
      or (
        candidate->>'identity_id' is not null and not exists (
          select 1 from public.memory_identities identities
          where identities.id = (candidate->>'identity_id')::uuid
            and identities.owner_id = p_owner_id and identities.deleted_at is null
            and identities.version = (candidate->>'identity_version')::integer
            and identities.connection_id = (candidate->>'connection_id')::uuid
        )
      )
  ) then
    raise exception 'invalid_action_candidate' using errcode = 'P0001';
  end if;

  rule := public.commit_ping_rule_session_v2(
    p_owner_id, p_session_id, p_expected_revision, p_source_connection_id,
    p_title, p_intent_summary, p_capability_id, p_capability_name,
    p_capability_schema_hash,
    jsonb_set(p_definition, '{schema_version}', '2'::jsonb),
    p_context_bindings, null, null, null, null
  );

  update public.ping_rules
  set definition = p_definition, schema_version = 3, updated_at = now()
  where id = rule.id and owner_id = p_owner_id
  returning * into rule;

  delete from public.ping_rule_action_candidates where rule_id = rule.id;
  insert into public.ping_rule_action_candidates(
    owner_id, rule_id, position, connection_id, capability_id, capability_name,
    capability_schema_hash, arguments, descriptor, identity_id, identity_version
  )
  select p_owner_id, rule.id, (entry.ordinality - 1)::smallint,
    (entry.candidate->>'connection_id')::uuid,
    entry.candidate->>'capability_id', entry.candidate->>'capability_name',
    entry.candidate->>'capability_schema_hash', coalesce(entry.candidate->'arguments', '{}'::jsonb),
    entry.candidate->'descriptor', (entry.candidate->>'identity_id')::uuid,
    (entry.candidate->>'identity_version')::integer
  from jsonb_array_elements(p_action_candidates) with ordinality as entry(candidate, ordinality);

  return rule;
end;
$$;

create or replace function public.prepare_ping_rule_approval_v3(
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
  p_expires_at timestamptz,
  p_candidate_id text,
  p_candidate_position smallint
)
returns public.approval_requests
language plpgsql security definer set search_path = '' as $$
declare
  event public.ping_rule_events;
  candidate public.ping_rule_action_candidates;
  request public.approval_requests;
  person uuid;
begin
  select * into event from public.ping_rule_events
  where id = p_event_id and status = 'evaluating' and lease_token = p_lease_token for update;
  if event.id is null then raise exception 'ping_event_conflict' using errcode = 'P0001'; end if;
  select * into candidate from public.ping_rule_action_candidates
  where rule_id = event.rule_id and owner_id = event.owner_id and position = p_candidate_position;
  if candidate.rule_id is null or p_candidate_id !~ '^[0-9a-f]{32}$' then
    raise exception 'invalid_action_candidate' using errcode = 'P0001';
  end if;
  if candidate.identity_id is not null then
    select person_id into person from public.memory_identities
    where id = candidate.identity_id and owner_id = event.owner_id and connection_id = candidate.connection_id
      and version = candidate.identity_version and deleted_at is null;
    if person is null then raise exception 'identity_changed' using errcode = 'P0001'; end if;
  end if;

  request := public.prepare_ping_rule_approval(
    p_event_id, p_lease_token, p_encrypted_draft_payload, p_encrypted_action_payload,
    p_action_payload_hash, p_title, p_source, p_summary, p_details,
    p_affected_context, p_risk, p_warnings, p_expires_at
  );
  update public.ping_rule_events
  set selected_candidate_id = p_candidate_id,
      selected_candidate_position = p_candidate_position,
      selected_action_connection_id = candidate.connection_id,
      selected_action_capability_id = candidate.capability_id,
      selected_person_id = person,
      selected_identity_id = candidate.identity_id,
      selected_identity_version = candidate.identity_version,
      updated_at = now()
  where id = p_event_id;
  return request;
end;
$$;

create or replace function public.record_ping_memory_decision(
  p_request_id uuid, p_outcome text, p_decided_at timestamptz
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  event public.ping_rule_events;
  rule public.ping_rules;
  decision_id uuid;
  approval_decision uuid;
  message_id uuid;
  action_provider text;
  personalization_enabled boolean;
  action_connection uuid;
  action_capability text;
begin
  if p_outcome not in ('approved', 'rejected', 'expired', 'cancelled') then
    raise exception 'invalid_memory_outcome' using errcode = 'P0001';
  end if;
  select * into event from public.ping_rule_events
  where approval_request_id = p_request_id for update;
  if event.id is null or event.encrypted_source_payload is null then return null; end if;
  select * into rule from public.ping_rules where id = event.rule_id and owner_id = event.owner_id;
  if rule.id is null then return null; end if;
  action_connection := coalesce(event.selected_action_connection_id, rule.action_connection_id);
  action_capability := coalesce(event.selected_action_capability_id, rule.action_capability_id);
  select id into approval_decision from public.approval_decisions where request_id = p_request_id;

  insert into public.memory_decision_cases(
    owner_id, rule_id, event_id, approval_request_id, approval_decision_id,
    selected_person_id, selected_identity_id, action_connection_id, action_capability_id,
    encrypted_situation_payload, encrypted_candidate_payload,
    approval_outcome, delivery_outcome, occurred_at, decided_at
  ) values (
    event.owner_id, event.rule_id, event.id, p_request_id, approval_decision,
    event.selected_person_id, event.selected_identity_id, action_connection, action_capability,
    event.encrypted_source_payload,
    case when event.selected_candidate_id is null then null else event.encrypted_action_payload end,
    p_outcome, case when p_outcome = 'approved' then 'pending' else 'not_applicable' end,
    event.occurred_at, p_decided_at
  ) on conflict (approval_request_id) do nothing returning id into decision_id;
  if decision_id is null then select id into decision_id from public.memory_decision_cases where approval_request_id = p_request_id; end if;

  if p_outcome in ('approved', 'rejected') then
    insert into public.memory_outbox(owner_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (
      event.owner_id, 'decision', decision_id, 'decision.' || p_outcome,
      jsonb_strip_nulls(jsonb_build_object('decision_case_id', decision_id, 'outcome', p_outcome, 'candidate_id', event.selected_candidate_id)),
      'decision:' || decision_id::text || ':' || p_outcome
    ) on conflict (owner_id, dedupe_key) do nothing;
  end if;

  if p_outcome = 'approved' and action_connection is not null and action_capability is not null
    and event.encrypted_action_payload is not null and (
      action_capability like '%:rest:gmail.send_reply'
      or action_capability like '%:rest:gmail.send_message'
      or action_capability like '%:rest:telegram.send_text'
      or action_capability like '%:rest:telegram.bot_send_text'
    ) then
    select provider into action_provider from public.connections
    where id = action_connection and owner_id = event.owner_id;
    select coalesce(settings.personalization_enabled, true) into personalization_enabled
    from public.ai_settings settings where settings.owner_id = event.owner_id;
    if coalesce(personalization_enabled, true) then
      insert into public.memory_message_examples(
        owner_id, decision_case_id, connection_id, person_id, identity_id, channel, source_kind,
        encrypted_payload, payload_hash, occurred_at
      ) values (
        event.owner_id, decision_id, action_connection, event.selected_person_id, event.selected_identity_id,
        case action_provider when 'gmail' then 'gmail' when 'telegram' then 'telegram' else 'custom' end,
        case when event.encrypted_revision_payload is null then 'approved_action' else 'approved_correction' end,
        coalesce(event.encrypted_revision_payload, event.encrypted_action_payload),
        event.action_payload_hash, event.occurred_at
      ) on conflict (decision_case_id) do nothing returning id into message_id;
    end if;
  end if;

  if p_outcome = 'cancelled' then
    update public.memory_decision_cases set delivery_outcome = 'superseded', updated_at = now()
    where id = decision_id and approval_outcome = 'approved' and delivery_outcome = 'pending';
    update public.memory_message_examples set eligibility = 'intent_only', updated_at = now()
    where decision_case_id = decision_id and eligibility = 'pending_delivery';
  end if;
  return decision_id;
end;
$$;

create or replace function public.set_ping_rule_status_v3(
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
  if p_status not in ('active', 'paused') then raise exception 'invalid_rule_status' using errcode = 'P0001'; end if;
  select * into rule from public.ping_rules
  where id = p_rule_id and owner_id = p_owner_id for update;
  if rule.id is null then raise exception 'rule_not_found' using errcode = 'P0001'; end if;
  if rule.schema_version <> 3 or rule.revision <> p_expected_revision then
    raise exception 'rule_edit_conflict' using errcode = 'P0001';
  end if;
  if p_status = 'active' and (
    not exists (select 1 from public.connections where id = rule.source_connection_id and owner_id = p_owner_id and status = 'connected')
    or not exists (select 1 from public.ping_rule_action_candidates where rule_id = rule.id)
    or exists (
      select 1 from public.ping_rule_context_bindings bindings
      where bindings.rule_id = rule.id and not exists (
        select 1 from public.connections where id = bindings.connection_id and owner_id = p_owner_id and status = 'connected'
      )
    )
    or exists (
      select 1 from public.ping_rule_action_candidates candidates
      where candidates.rule_id = rule.id and (
        not exists (select 1 from public.connections where id = candidates.connection_id and owner_id = p_owner_id and status = 'connected')
        or (candidates.identity_id is not null and not exists (
          select 1 from public.memory_identities identities
          where identities.id = candidates.identity_id and identities.owner_id = p_owner_id
            and identities.version = candidates.identity_version and identities.deleted_at is null
        ))
      )
    )
    or exists (select 1 from public.ping_rule_runtime_states where rule_id = rule.id and schema_drift = true)
  ) then raise exception 'rule_review_required' using errcode = 'P0001'; end if;

  if p_status = 'paused' then
    update public.approval_requests requests set status = 'cancelled', decided_at = now()
    where requests.status = 'pending' and requests.id in (
      select approval_request_id from public.ping_rule_events where rule_id = rule.id and approval_request_id is not null
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

create or replace function public.claim_due_ping_rule(p_worker_id text, p_lease_seconds integer default 45)
returns table(rule_id uuid, owner_id uuid, lease_token uuid)
language plpgsql security definer set search_path = '' as $$
declare claimed public.ping_rule_runtime_states; token uuid := gen_random_uuid();
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then raise exception 'invalid_worker_id' using errcode = 'P0001'; end if;
  select states.* into claimed from public.ping_rule_runtime_states states
  join public.ping_rules rules on rules.id = states.rule_id
  where rules.status = 'active' and rules.schema_version in (2, 3)
    and coalesce(rules.definition->'source'->>'delivery', 'poll') = 'poll'
    and states.schema_drift = false and states.next_run_at <= now()
    and (states.leased_until is null or states.leased_until < now())
  order by states.next_run_at, states.rule_id for update of states skip locked limit 1;
  if claimed.rule_id is null then return; end if;
  update public.ping_rule_runtime_states set lease_token = token,
    leased_until = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300))), updated_at = now()
  where ping_rule_runtime_states.rule_id = claimed.rule_id;
  return query select claimed.rule_id, claimed.owner_id, token;
end;
$$;

create or replace function public.record_ping_connection_health(
  p_owner_id uuid, p_connection_id uuid, p_success boolean, p_error text
)
returns integer language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  update public.ping_rule_runtime_states states
  set consecutive_failures = case when p_success then 0 else least(100, states.consecutive_failures + 1) end,
      last_error = case when p_success then null else left(coalesce(p_error, 'Connection failed'), 500) end,
      updated_at = now()
  from public.ping_rules rules
  where rules.id = states.rule_id and rules.owner_id = p_owner_id
    and rules.source_connection_id = p_connection_id and rules.status = 'active'
    and rules.schema_version in (2, 3) and rules.definition->'source'->>'delivery' = 'event';
  get diagnostics affected = row_count;
  if not p_success then
    update public.ping_rules rules set status = 'needs_attention', revision = revision + 1, updated_at = now()
    where rules.owner_id = p_owner_id and rules.source_connection_id = p_connection_id
      and rules.status = 'active' and exists (
        select 1 from public.ping_rule_runtime_states states where states.rule_id = rules.id and states.consecutive_failures >= 3
      );
  end if;
  return affected;
end;
$$;

revoke all on function public.commit_ping_rule_session_v3(uuid, uuid, integer, uuid, text, text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.prepare_ping_rule_approval_v3(uuid, uuid, text, text, text, text, text, text, text, text, text, text[], timestamptz, text, smallint) from public, anon, authenticated;
revoke all on function public.set_ping_rule_status_v3(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.commit_ping_rule_session_v3(uuid, uuid, integer, uuid, text, text, text, text, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.prepare_ping_rule_approval_v3(uuid, uuid, text, text, text, text, text, text, text, text, text, text[], timestamptz, text, smallint) to service_role;
grant execute on function public.set_ping_rule_status_v3(uuid, uuid, integer, text) to service_role;

commit;
