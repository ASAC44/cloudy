begin;

alter table public.ai_settings
  add column personalization_enabled boolean not null default true;

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

  if request.id is null then
    raise exception 'request_not_found' using errcode = 'P0001';
  end if;
  if request.status <> 'pending' then
    raise exception 'request_already_resolved' using errcode = 'P0001';
  end if;
  if request.expires_at <= now() then
    raise exception 'request_expired' using errcode = 'P0001';
  end if;

  select * into event
  from public.ping_rule_events
  where owner_id = p_owner_id and approval_request_id = request.id
  for update;

  if event.id is null or event.status <> 'pending_approval' then
    raise exception 'reply_not_editable' using errcode = 'P0001';
  end if;
  if request.payload_hash = p_new_hash and event.action_payload_hash = p_new_hash then
    return request;
  end if;
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
  where id = request.id
  returning * into request;

  update public.ping_rule_events
  set encrypted_draft_payload = p_encrypted_draft_payload,
      encrypted_action_payload = p_encrypted_action_payload,
      action_payload_hash = p_new_hash,
      updated_at = now()
  where id = event.id;

  if coalesce((select personalization_enabled from public.ai_settings where owner_id = p_owner_id), true) then
    insert into public.agent_memories(
      owner_id, scope, scope_id, provider, memory_key, content, source
    ) values (
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

revoke all on function public.revise_ping_rule_reply(uuid, uuid, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.revise_ping_rule_reply(uuid, uuid, text, text, text, text, text, jsonb)
  to service_role;

commit;
