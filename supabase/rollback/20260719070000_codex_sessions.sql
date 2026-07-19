drop function if exists public.acknowledge_codex_command(uuid, uuid, uuid, boolean, text);
drop function if exists public.revise_codex_plan(uuid, uuid, uuid, text, uuid, uuid, integer, text);
drop function if exists public.claim_codex_command(uuid, uuid);
drop function if exists public.queue_codex_command(uuid, uuid, uuid, text, jsonb, uuid, integer);
drop function if exists public.expire_approval_requests();
drop function if exists public.revoke_codex_bridge(uuid, uuid);
drop function if exists public.set_codex_target(uuid, uuid, uuid, integer);
drop function if exists public.create_codex_interaction(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, timestamptz);
drop function if exists public.sync_codex_bridge(uuid, uuid, text, uuid, text, jsonb, jsonb);
drop function if exists public.claim_codex_bridge(text, uuid, text);
drop table if exists public.codex_commands;
drop table if exists public.codex_interactions;
drop table if exists public.codex_targets;
drop table if exists public.codex_threads;
drop table if exists public.codex_workspaces;
drop table if exists public.codex_bridges;
drop table if exists public.codex_bridge_pairing_sessions;

create or replace function public.decide_approval(
  p_owner_id uuid,
  p_pod_id uuid,
  p_request_id uuid,
  p_outcome text,
  p_payload_hash text,
  p_idempotency_key uuid
)
returns public.approval_decisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.approval_requests;
  decision public.approval_decisions;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_idempotency_key::text, 0)
  );

  select * into decision
  from public.approval_decisions
  where idempotency_key = p_idempotency_key;

  if decision.id is not null then
    if decision.request_id <> p_request_id
      or decision.pod_id <> p_pod_id
      or decision.outcome <> p_outcome
      or decision.payload_hash <> p_payload_hash then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return decision;
  end if;

  if p_outcome not in ('approved', 'rejected') then
    raise exception 'invalid_outcome' using errcode = 'P0001';
  end if;

  select * into request
  from public.approval_requests
  where id = p_request_id and owner_id = p_owner_id
  for update;

  if request.id is null then
    raise exception 'request_not_found' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.pods
    where id = p_pod_id
      and owner_id = p_owner_id
      and revoked_at is null
  ) then
    raise exception 'pod_not_authorized' using errcode = 'P0001';
  end if;

  if request.status <> 'pending' then
    raise exception 'request_already_resolved' using errcode = 'P0001';
  end if;

  if request.expires_at <= now() then
    update public.approval_requests
    set status = 'expired', decided_at = now()
    where id = request.id;
    return null;
  end if;

  if request.payload_hash <> p_payload_hash then
    raise exception 'payload_changed' using errcode = 'P0001';
  end if;

  insert into public.approval_decisions(
    request_id, pod_id, outcome, payload_hash, idempotency_key
  ) values (
    request.id, p_pod_id, p_outcome, p_payload_hash, p_idempotency_key
  ) returning * into decision;

  update public.approval_requests
  set status = p_outcome, decided_at = decision.decided_at
  where id = request.id;

  return decision;
end;
$$;

revoke all on function public.decide_approval(uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.decide_approval(uuid, uuid, uuid, text, text, uuid) to service_role;
