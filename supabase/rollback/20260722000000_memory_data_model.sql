begin;

do $$
begin
  if exists (select 1 from public.memory_people)
    or exists (select 1 from public.memory_identities)
    or exists (select 1 from public.memory_decision_cases)
    or exists (select 1 from public.memory_message_examples)
    or exists (select 1 from public.memory_preferences)
    or exists (select 1 from public.memory_graph_refs)
    or exists (select 1 from public.memory_import_cursors)
    or exists (select 1 from public.memory_outbox)
    or exists (select 1 from public.ping_rule_events where encrypted_revision_payload is not null) then
    raise exception 'Refusing rollback while canonical memory data exists';
  end if;
end;
$$;

drop function if exists public.record_ping_memory_decision(uuid, text, timestamptz);

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

create or replace function public.revise_ping_rule_reply(
  p_owner_id uuid,
  p_request_id uuid,
  p_expected_hash text,
  p_new_hash text,
  p_encrypted_draft_payload text,
  p_encrypted_action_payload text,
  p_memory_content text,
  p_memory_source jsonb
)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.approval_requests;
  event public.ping_rule_events;
  rule public.ping_rules;
  source_provider text;
begin
  if p_expected_hash !~ '^[0-9a-f]{64}$'
    or p_new_hash !~ '^[0-9a-f]{64}$'
    or p_encrypted_draft_payload = ''
    or p_encrypted_action_payload = ''
    or char_length(p_memory_content) not between 1 and 2000
    or jsonb_typeof(p_memory_source) <> 'object' then
    raise exception 'invalid_reply_revision' using errcode = 'P0001';
  end if;

  select * into request
  from public.approval_requests
  where id = p_request_id and owner_id = p_owner_id
  for update;

  if request.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if request.status <> 'pending' then raise exception 'request_already_resolved' using errcode = 'P0001'; end if;
  if request.expires_at <= now() then raise exception 'request_expired' using errcode = 'P0001'; end if;

  select * into event
  from public.ping_rule_events
  where owner_id = p_owner_id and approval_request_id = request.id
  for update;

  if event.id is null or event.status <> 'pending_approval' then raise exception 'reply_not_editable' using errcode = 'P0001'; end if;
  if request.payload_hash = p_new_hash and event.action_payload_hash = p_new_hash then return request; end if;
  if request.payload_hash <> p_expected_hash or event.action_payload_hash <> p_expected_hash then
    raise exception 'payload_changed' using errcode = 'P0001';
  end if;

  select * into rule from public.ping_rules
  where id = event.rule_id and owner_id = p_owner_id;
  if rule.id is null then raise exception 'rule_not_found' using errcode = 'P0001'; end if;
  select provider into source_provider from public.connections
  where id = rule.source_connection_id and owner_id = p_owner_id;

  update public.approval_requests
  set payload_hash = p_new_hash,
      action_payload = jsonb_set(action_payload, '{action_hash}', to_jsonb(p_new_hash), true)
  where id = request.id returning * into request;

  update public.ping_rule_events
  set encrypted_draft_payload = p_encrypted_draft_payload,
      encrypted_action_payload = p_encrypted_action_payload,
      action_payload_hash = p_new_hash,
      updated_at = now()
  where id = event.id;

  if coalesce((select personalization_enabled from public.ai_settings where owner_id = p_owner_id), true) then
    insert into public.agent_memories(owner_id, scope, scope_id, provider, memory_key, content, source)
    values (
      p_owner_id, 'provider', rule.source_connection_id::text, source_provider,
      'correction:' || request.id::text, p_memory_content, p_memory_source
    )
    on conflict (owner_id, scope, scope_id, provider, memory_key)
    do update set content = excluded.content, source = excluded.source,
      deleted_at = null, updated_at = now();
  end if;
  return request;
end;
$$;

drop table if exists public.memory_outbox;
drop table if exists public.memory_import_cursors;
drop table if exists public.memory_graph_refs;
drop table if exists public.memory_preferences;
drop table if exists public.memory_message_examples;
drop table if exists public.memory_decision_cases;
drop table if exists public.memory_identities;
drop table if exists public.memory_people;

alter table public.ping_rule_events drop column if exists encrypted_revision_payload;
drop index if exists public.ping_rule_events_owner_id_unique;

revoke all on function public.sync_ping_event_approval_status() from public, anon, authenticated;
revoke all on function public.complete_ping_action(uuid, uuid, boolean, boolean, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.revise_ping_rule_reply(uuid, uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_ping_action(uuid, uuid, boolean, boolean, boolean, boolean, text) to service_role;
grant execute on function public.revise_ping_rule_reply(uuid, uuid, text, text, text, text, text, jsonb) to service_role;

commit;
