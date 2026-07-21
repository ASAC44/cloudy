begin;

do $$
begin
  if exists (select 1 from public.ping_rules where schema_version = 3) then
    raise exception 'Refusing rollback while learned communication rules exist';
  end if;
end;
$$;

drop function if exists public.prepare_ping_rule_approval_v3(uuid, uuid, text, text, text, text, text, text, text, text, text, text[], timestamptz, text, smallint);
drop function if exists public.set_ping_rule_status_v3(uuid, uuid, integer, text);
drop function if exists public.commit_ping_rule_session_v3(uuid, uuid, integer, uuid, text, text, text, text, text, jsonb, jsonb, jsonb);
drop table if exists public.ping_rule_action_candidates;

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
begin
  if p_outcome not in ('approved', 'rejected', 'expired', 'cancelled') then raise exception 'invalid_memory_outcome' using errcode = 'P0001'; end if;
  select * into event from public.ping_rule_events where approval_request_id = p_request_id for update;
  if event.id is null or event.encrypted_source_payload is null then return null; end if;
  select * into rule from public.ping_rules where id = event.rule_id and owner_id = event.owner_id;
  if rule.id is null then return null; end if;
  select id into approval_decision from public.approval_decisions where request_id = p_request_id;
  insert into public.memory_decision_cases(
    owner_id, rule_id, event_id, approval_request_id, approval_decision_id,
    action_connection_id, action_capability_id, encrypted_situation_payload,
    approval_outcome, delivery_outcome, occurred_at, decided_at
  ) values (
    event.owner_id, event.rule_id, event.id, p_request_id, approval_decision,
    rule.action_connection_id, rule.action_capability_id, event.encrypted_source_payload,
    p_outcome, case when p_outcome = 'approved' then 'pending' else 'not_applicable' end,
    event.occurred_at, p_decided_at
  ) on conflict (approval_request_id) do nothing returning id into decision_id;
  if decision_id is null then select id into decision_id from public.memory_decision_cases where approval_request_id = p_request_id; end if;
  if p_outcome in ('approved', 'rejected') then
    insert into public.memory_outbox(owner_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (event.owner_id, 'decision', decision_id, 'decision.' || p_outcome,
      jsonb_build_object('decision_case_id', decision_id, 'outcome', p_outcome),
      'decision:' || decision_id::text || ':' || p_outcome)
    on conflict (owner_id, dedupe_key) do nothing;
  end if;
  if p_outcome = 'approved' and rule.action_connection_id is not null and rule.action_capability_id is not null
    and event.encrypted_action_payload is not null and (
      rule.action_capability_id like '%:rest:gmail.send_reply'
      or rule.action_capability_id like '%:rest:gmail.send_message'
      or rule.action_capability_id like '%:rest:telegram.send_text'
      or rule.action_capability_id like '%:rest:telegram.bot_send_text'
    ) then
    select provider into action_provider from public.connections where id = rule.action_connection_id and owner_id = event.owner_id;
    select coalesce(settings.personalization_enabled, true) into personalization_enabled from public.ai_settings settings where settings.owner_id = event.owner_id;
    if coalesce(personalization_enabled, true) then
      insert into public.memory_message_examples(
        owner_id, decision_case_id, connection_id, channel, source_kind, encrypted_payload, payload_hash, occurred_at
      ) values (
        event.owner_id, decision_id, rule.action_connection_id,
        case action_provider when 'gmail' then 'gmail' when 'telegram' then 'telegram' else 'custom' end,
        case when event.encrypted_revision_payload is null then 'approved_action' else 'approved_correction' end,
        coalesce(event.encrypted_revision_payload, event.encrypted_action_payload), event.action_payload_hash, event.occurred_at
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

drop index if exists public.ping_rule_events_selected_identity;
alter table public.ping_rule_events
  drop column if exists selected_candidate_id,
  drop column if exists selected_candidate_position,
  drop column if exists selected_action_connection_id,
  drop column if exists selected_action_capability_id,
  drop column if exists selected_person_id,
  drop column if exists selected_identity_id,
  drop column if exists selected_identity_version;

alter table public.ping_rules drop constraint ping_rules_schema_version_check;
alter table public.ping_rules add constraint ping_rules_schema_version_check check (schema_version in (1, 2));

create or replace function public.claim_due_ping_rule(p_worker_id text, p_lease_seconds integer default 45)
returns table(rule_id uuid, owner_id uuid, lease_token uuid)
language plpgsql security definer set search_path = '' as $$
declare claimed public.ping_rule_runtime_states; token uuid := gen_random_uuid();
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then raise exception 'invalid_worker_id' using errcode = 'P0001'; end if;
  select states.* into claimed from public.ping_rule_runtime_states states
  join public.ping_rules rules on rules.id = states.rule_id
  where rules.status = 'active' and rules.schema_version = 2
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
    and rules.schema_version = 2 and rules.definition->'source'->>'delivery' = 'event';
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

commit;
