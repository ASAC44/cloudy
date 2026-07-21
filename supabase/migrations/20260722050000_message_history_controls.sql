begin;

alter table public.ai_settings
  add column learned_actions_enabled boolean not null default false;

alter table public.memory_message_examples
  alter column decision_case_id drop not null,
  add column provider_message_id_hash text,
  add column conversation_id_hash text,
  add constraint memory_message_examples_provider_hash_format
    check (provider_message_id_hash is null or provider_message_id_hash ~ '^[0-9a-f]{64}$'),
  add constraint memory_message_examples_conversation_hash_format
    check (conversation_id_hash is null or conversation_id_hash ~ '^[0-9a-f]{64}$'),
  add constraint memory_message_examples_source_shape check (
    (source_kind = 'imported_sent' and decision_case_id is null and provider_message_id_hash is not null)
    or (source_kind <> 'imported_sent' and decision_case_id is not null and provider_message_id_hash is null)
  );

create unique index memory_message_examples_import_source
  on public.memory_message_examples(owner_id, connection_id, provider_message_id_hash)
  where source_kind = 'imported_sent' and deleted_at is null;

create index memory_message_examples_conversation_recent
  on public.memory_message_examples(owner_id, connection_id, conversation_id_hash, occurred_at desc, id desc)
  where source_kind = 'imported_sent' and deleted_at is null;

alter table public.memory_import_cursors
  add column consented_at timestamptz not null default now(),
  add column estimated_count integer check (estimated_count is null or estimated_count >= 0),
  add column imported_count integer not null default 0 check (imported_count >= 0),
  add column excluded_count integer not null default 0 check (excluded_count >= 0),
  add column completed_at timestamptz,
  add constraint memory_import_cursor_completion check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  );

create or replace function public.configure_memory_import(
  p_owner_id uuid,
  p_connection_id uuid,
  p_import_kind text,
  p_scope_hash text,
  p_encrypted_scope text,
  p_estimated_count integer
)
returns public.memory_import_cursors
language plpgsql
security definer
set search_path = ''
as $$
declare
  provider_name text;
  configured public.memory_import_cursors;
begin
  if p_import_kind not in ('sent_messages', 'dialog_messages')
    or p_scope_hash !~ '^[0-9a-f]{64}$'
    or char_length(p_encrypted_scope) not between 1 and 20000
    or p_estimated_count is null or p_estimated_count < 0 then
    raise exception 'invalid_memory_import' using errcode = 'P0001';
  end if;

  select provider into provider_name from public.connections
  where owner_id = p_owner_id and id = p_connection_id and status = 'connected'
  for share;
  if provider_name is null
    or (p_import_kind = 'sent_messages' and provider_name <> 'gmail')
    or (p_import_kind = 'dialog_messages' and provider_name <> 'telegram') then
    raise exception 'invalid_memory_import_connection' using errcode = 'P0001';
  end if;

  insert into public.memory_import_cursors(
    owner_id, connection_id, import_kind, scope_hash, encrypted_scope,
    status, attempts, next_attempt_at, last_error, estimated_count,
    imported_count, excluded_count, consented_at, completed_at
  ) values (
    p_owner_id, p_connection_id, p_import_kind, p_scope_hash, p_encrypted_scope,
    'idle', 0, now(), null, p_estimated_count, 0, 0, now(), null
  )
  on conflict (owner_id, connection_id, import_kind, scope_hash) do update
  set encrypted_scope = excluded.encrypted_scope,
      status = 'idle', attempts = 0, next_attempt_at = now(), last_error = null,
      estimated_count = excluded.estimated_count,
      imported_count = public.memory_import_cursors.imported_count,
      excluded_count = public.memory_import_cursors.excluded_count,
      consented_at = now(), completed_at = null,
      encrypted_cursor = null, lease_token = null, leased_until = null,
      last_imported_at = null, updated_at = now()
  returning * into configured;
  return configured;
end;
$$;

create or replace function public.claim_memory_import(p_lease_seconds integer default 120)
returns table(
  import_id uuid, owner_id uuid, connection_id uuid, import_kind text,
  encrypted_scope text, encrypted_cursor text, lease_token uuid, attempts smallint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.memory_import_cursors;
begin
  if p_lease_seconds not between 30 and 600 then
    raise exception 'invalid_memory_import_lease' using errcode = 'P0001';
  end if;
  select imports.* into claimed from public.memory_import_cursors imports
  where imports.status in ('idle', 'running', 'failed')
    and imports.next_attempt_at <= now()
    and (imports.leased_until is null or imports.leased_until < now())
    and imports.attempts < 10
  order by imports.next_attempt_at, imports.created_at, imports.id
  for update skip locked limit 1;
  if claimed.id is null then return; end if;

  update public.memory_import_cursors imports
  set status = 'running', attempts = imports.attempts + 1, lease_token = gen_random_uuid(),
      leased_until = now() + make_interval(secs => p_lease_seconds),
      last_error = null, updated_at = now()
  where imports.id = claimed.id returning imports.* into claimed;

  return query select claimed.id, claimed.owner_id, claimed.connection_id,
    claimed.import_kind, claimed.encrypted_scope, claimed.encrypted_cursor,
    claimed.lease_token, claimed.attempts;
end;
$$;

create or replace function public.record_imported_message(
  p_import_id uuid,
  p_lease_token uuid,
  p_provider_message_id_hash text,
  p_conversation_id_hash text,
  p_encrypted_payload text,
  p_payload_hash text,
  p_style_metadata jsonb,
  p_occurred_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  import_record public.memory_import_cursors;
  message_id uuid;
  provider_name text;
begin
  select * into import_record from public.memory_import_cursors
  where id = p_import_id and status = 'running' and lease_token = p_lease_token
    and leased_until >= now() for update;
  if import_record.id is null then return false; end if;
  if p_provider_message_id_hash !~ '^[0-9a-f]{64}$'
    or (p_conversation_id_hash is not null and p_conversation_id_hash !~ '^[0-9a-f]{64}$')
    or p_payload_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_style_metadata) <> 'object'
    or char_length(p_encrypted_payload) not between 1 and 100000 then
    raise exception 'invalid_imported_message' using errcode = 'P0001';
  end if;
  select provider into provider_name from public.connections
  where owner_id = import_record.owner_id and id = import_record.connection_id;

  insert into public.memory_message_examples(
    owner_id, decision_case_id, connection_id, channel, source_kind, eligibility,
    encrypted_payload, payload_hash, style_metadata, occurred_at,
    provider_message_id_hash, conversation_id_hash
  ) values (
    import_record.owner_id, null, import_record.connection_id,
    case provider_name when 'gmail' then 'gmail' else 'telegram' end,
    'imported_sent', 'positive', p_encrypted_payload, p_payload_hash,
    p_style_metadata, p_occurred_at, p_provider_message_id_hash, p_conversation_id_hash
  ) on conflict (owner_id, connection_id, provider_message_id_hash)
    where source_kind = 'imported_sent' and deleted_at is null do nothing
  returning id into message_id;

  if message_id is not null then
    update public.memory_import_cursors
    set imported_count = imported_count + 1, last_imported_at = now(), updated_at = now()
    where id = import_record.id;
  end if;
  return true;
end;
$$;

create or replace function public.complete_memory_import(
  p_import_id uuid,
  p_lease_token uuid,
  p_encrypted_cursor text,
  p_excluded_count integer,
  p_has_more boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_excluded_count < 0 then
    raise exception 'invalid_memory_import_count' using errcode = 'P0001';
  end if;
  update public.memory_import_cursors
  set encrypted_cursor = p_encrypted_cursor,
      excluded_count = excluded_count + p_excluded_count,
      status = case when p_has_more then 'idle' else 'completed' end,
      completed_at = case when p_has_more then null else now() end,
      next_attempt_at = case when p_has_more then now() else next_attempt_at end,
      lease_token = null, leased_until = null, updated_at = now()
  where id = p_import_id and status = 'running' and lease_token = p_lease_token
    and leased_until >= now();
  return found;
end;
$$;

create or replace function public.fail_memory_import(
  p_import_id uuid,
  p_lease_token uuid,
  p_error text,
  p_retryable boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.memory_import_cursors
  set status = case when p_retryable and attempts < 10 then 'failed' else 'paused' end,
      next_attempt_at = case attempts when 1 then now() + interval '10 seconds'
        when 2 then now() + interval '1 minute' else now() + interval '10 minutes' end,
      last_error = left(coalesce(p_error, 'Import failed'), 500),
      lease_token = null, leased_until = null, updated_at = now()
  where id = p_import_id and status = 'running' and lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.forget_memory_scope(
  p_owner_id uuid,
  p_scope text,
  p_target_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer := 0;
  changed integer;
begin
  if p_scope not in ('person', 'connection', 'everything')
    or (p_scope = 'everything' and p_target_id is not null)
    or (p_scope <> 'everything' and p_target_id is null) then
    raise exception 'invalid_memory_forget_scope' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));
  perform 1 from auth.users where id = p_owner_id for update;
  perform 1 from public.memory_import_cursors where owner_id = p_owner_id for update;

  if p_scope = 'person' then
    perform 1 from public.memory_people
    where owner_id = p_owner_id and id = p_target_id and deleted_at is null for update;
    if not found then return 0; end if;
    if exists (select 1 from public.ping_rule_events where owner_id = p_owner_id
      and selected_person_id = p_target_id and status = 'delivering' and leased_until >= now()) then
      raise exception 'memory_forget_action_in_flight' using errcode = 'P0001';
    end if;

    update public.approval_requests set status = 'cancelled', decided_at = now()
    where owner_id = p_owner_id and status = 'pending' and id in (
      select approval_request_id from public.ping_rule_events
      where owner_id = p_owner_id and selected_person_id = p_target_id and approval_request_id is not null
    );
    update public.ping_rule_events set status = 'superseded', resolved_at = now(),
      selected_person_id = null, selected_identity_id = null, selected_identity_version = null,
      lease_token = null, leased_until = null, updated_at = now()
    where owner_id = p_owner_id and selected_person_id = p_target_id
      and status in ('detected', 'evaluating', 'pending_approval', 'approved', 'delivering');

    delete from public.memory_graph_refs where owner_id = p_owner_id and (
      person_id = p_target_id
      or identity_id in (select id from public.memory_identities where owner_id = p_owner_id and person_id = p_target_id)
      or message_example_id in (select id from public.memory_message_examples where owner_id = p_owner_id and person_id = p_target_id)
      or preference_id in (select id from public.memory_preferences where owner_id = p_owner_id and person_id = p_target_id)
    );
    update public.memory_message_examples set person_id = null, identity_id = null,
      deleted_at = now(), updated_at = now()
    where owner_id = p_owner_id and person_id = p_target_id and deleted_at is null;
    get diagnostics affected = row_count;
    update public.memory_preferences set deleted_at = now(), updated_at = now()
    where owner_id = p_owner_id and person_id = p_target_id and deleted_at is null;
    get diagnostics changed = row_count; affected := affected + changed;
    update public.memory_decision_cases set selected_person_id = null, selected_identity_id = null, updated_at = now()
    where owner_id = p_owner_id and selected_person_id = p_target_id;
    update public.memory_identities set deleted_at = now(), version = version + 1, updated_at = now()
    where owner_id = p_owner_id and person_id = p_target_id and deleted_at is null;
    get diagnostics changed = row_count; affected := affected + changed;
    update public.memory_people set deleted_at = now(), version = version + 1, updated_at = now()
    where owner_id = p_owner_id and id = p_target_id and deleted_at is null;
    affected := affected + 1;
  elsif p_scope = 'connection' then
    if not exists (select 1 from public.connections where owner_id = p_owner_id and id = p_target_id) then return 0; end if;
    if exists (select 1 from public.ping_rule_events where owner_id = p_owner_id
      and (selected_action_connection_id = p_target_id
        or selected_identity_id in (select id from public.memory_identities where owner_id = p_owner_id and connection_id = p_target_id))
      and status = 'delivering' and leased_until >= now()) then
      raise exception 'memory_forget_action_in_flight' using errcode = 'P0001';
    end if;
    update public.approval_requests set status = 'cancelled', decided_at = now()
    where owner_id = p_owner_id and status = 'pending' and id in (
      select approval_request_id from public.ping_rule_events
      where owner_id = p_owner_id and (selected_action_connection_id = p_target_id
        or selected_identity_id in (select id from public.memory_identities where owner_id = p_owner_id and connection_id = p_target_id))
        and approval_request_id is not null
    );
    update public.ping_rule_events set status = 'superseded', resolved_at = now(),
      selected_person_id = case when selected_identity_id in (select id from public.memory_identities where owner_id = p_owner_id and connection_id = p_target_id) then null else selected_person_id end,
      selected_identity_id = case when selected_identity_id in (select id from public.memory_identities where owner_id = p_owner_id and connection_id = p_target_id) then null else selected_identity_id end,
      selected_identity_version = case when selected_identity_id in (select id from public.memory_identities where owner_id = p_owner_id and connection_id = p_target_id) then null else selected_identity_version end,
      lease_token = null, leased_until = null, updated_at = now()
    where owner_id = p_owner_id and (selected_action_connection_id = p_target_id
      or selected_identity_id in (select id from public.memory_identities where owner_id = p_owner_id and connection_id = p_target_id))
      and status in ('detected', 'evaluating', 'pending_approval', 'approved', 'delivering');
    delete from public.memory_graph_refs where owner_id = p_owner_id and (
      identity_id in (select id from public.memory_identities where owner_id = p_owner_id and connection_id = p_target_id)
      or message_example_id in (select id from public.memory_message_examples where owner_id = p_owner_id and connection_id = p_target_id)
      or preference_id in (select id from public.memory_preferences where owner_id = p_owner_id and connection_id = p_target_id)
    );
    update public.memory_message_examples set deleted_at = now(), updated_at = now()
    where owner_id = p_owner_id and connection_id = p_target_id and deleted_at is null;
    get diagnostics affected = row_count;
    update public.memory_preferences set deleted_at = now(), updated_at = now()
    where owner_id = p_owner_id and connection_id = p_target_id and deleted_at is null;
    get diagnostics changed = row_count; affected := affected + changed;
    update public.memory_decision_cases set selected_identity_id = null, action_connection_id = null, updated_at = now()
    where owner_id = p_owner_id and (action_connection_id = p_target_id
      or selected_identity_id in (select id from public.memory_identities where owner_id = p_owner_id and connection_id = p_target_id));
    update public.memory_identities set deleted_at = now(), version = version + 1, updated_at = now()
    where owner_id = p_owner_id and connection_id = p_target_id and deleted_at is null;
    get diagnostics changed = row_count; affected := affected + changed;
    delete from public.memory_import_cursors where owner_id = p_owner_id and connection_id = p_target_id;
  else
    if exists (select 1 from public.ping_rule_events where owner_id = p_owner_id
      and status = 'delivering' and leased_until >= now()) then
      raise exception 'memory_forget_action_in_flight' using errcode = 'P0001';
    end if;
    update public.ai_settings set personalization_enabled = false,
      learned_actions_enabled = false, updated_at = now() where owner_id = p_owner_id;
    update public.approval_requests set status = 'cancelled', decided_at = now()
    where owner_id = p_owner_id and status = 'pending' and id in (
      select approval_request_id from public.ping_rule_events
      where owner_id = p_owner_id and (selected_person_id is not null or selected_identity_id is not null)
        and approval_request_id is not null
    );
    update public.ping_rule_events set status = 'superseded', resolved_at = now(),
      selected_person_id = null, selected_identity_id = null, selected_identity_version = null,
      lease_token = null, leased_until = null, updated_at = now()
    where owner_id = p_owner_id and (selected_person_id is not null or selected_identity_id is not null)
      and status in ('detected', 'evaluating', 'pending_approval', 'approved');
    delete from public.memory_graph_refs where owner_id = p_owner_id;
    delete from public.memory_outbox where owner_id = p_owner_id;
    delete from public.memory_import_cursors where owner_id = p_owner_id;
    delete from public.memory_message_examples where owner_id = p_owner_id;
    delete from public.memory_preferences where owner_id = p_owner_id;
    delete from public.memory_decision_cases where owner_id = p_owner_id;
    delete from public.memory_identities where owner_id = p_owner_id;
    delete from public.memory_people where owner_id = p_owner_id;
    update public.agent_memories set deleted_at = now(), updated_at = now()
    where owner_id = p_owner_id and deleted_at is null;
    get diagnostics affected = row_count;
  end if;

  insert into public.memory_outbox(owner_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
  values (p_owner_id, 'user', p_owner_id, 'user.rebuild',
    jsonb_build_object('scope', p_scope),
    'forget:' || p_scope || ':' || coalesce(p_target_id::text, 'everything') || ':' || gen_random_uuid()::text);
  return affected;
end;
$$;

revoke all on function public.configure_memory_import(uuid, uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.claim_memory_import(integer) from public, anon, authenticated;
revoke all on function public.record_imported_message(uuid, uuid, text, text, text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_memory_import(uuid, uuid, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.fail_memory_import(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.forget_memory_scope(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.configure_memory_import(uuid, uuid, text, text, text, integer) to service_role;
grant execute on function public.claim_memory_import(integer) to service_role;
grant execute on function public.record_imported_message(uuid, uuid, text, text, text, text, jsonb, timestamptz) to service_role;
grant execute on function public.complete_memory_import(uuid, uuid, text, integer, boolean) to service_role;
grant execute on function public.fail_memory_import(uuid, uuid, text, boolean) to service_role;
grant execute on function public.forget_memory_scope(uuid, text, uuid) to service_role;

commit;
