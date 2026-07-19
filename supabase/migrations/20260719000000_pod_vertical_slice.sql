create extension if not exists pgcrypto;

create table public.pod_pairing_sessions (
  id uuid primary key default gen_random_uuid(),
  pod_id uuid not null unique,
  code_hash text not null unique,
  token_hash text not null unique,
  source_ip_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  claimed_at timestamptz
);

create table public.pods (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create unique index one_active_pod_per_owner
  on public.pods(owner_id)
  where revoked_at is null;

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  source text not null check (char_length(source) between 1 and 120),
  summary text not null check (char_length(summary) between 1 and 1000),
  details text not null default '' check (char_length(details) <= 8000),
  affected_context text not null default '' check (char_length(affected_context) <= 2000),
  risk text not null check (risk in ('low', 'medium', 'high')),
  warnings text[] not null default '{}',
  priority smallint not null default 0,
  action_payload jsonb not null,
  payload_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz
);

create index approval_pending_queue
  on public.approval_requests(owner_id, priority desc, created_at)
  where status = 'pending';

create index approval_request_expiry
  on public.approval_requests(expires_at)
  where status = 'pending';

create table public.approval_decisions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.approval_requests(id) on delete cascade,
  pod_id uuid not null references public.pods(id),
  outcome text not null check (outcome in ('approved', 'rejected')),
  payload_hash text not null,
  idempotency_key uuid not null unique,
  decided_at timestamptz not null default now()
);

alter table public.pod_pairing_sessions enable row level security;
alter table public.pods enable row level security;
alter table public.approval_requests enable row level security;
alter table public.approval_decisions enable row level security;

create policy "Users can read their Pod"
  on public.pods for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Users can read their approval requests"
  on public.approval_requests for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Users can read their decisions"
  on public.approval_decisions for select to authenticated
  using (
    exists (
      select 1 from public.approval_requests request
      where request.id = approval_decisions.request_id
        and request.owner_id = (select auth.uid())
    )
  );

create or replace function public.create_pod_pairing_session(
  p_pod_id uuid,
  p_code_hash text,
  p_token_hash text,
  p_source_ip_hash text
)
returns table(id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.pod_pairing_sessions sessions
  where sessions.expires_at < now() and sessions.claimed_at is null;

  if (
    select count(*) >= 5
    from public.pod_pairing_sessions
    where source_ip_hash = p_source_ip_hash
      and created_at > now() - interval '15 minutes'
  ) then
    raise exception 'pairing_rate_limited' using errcode = 'P0001';
  end if;

  return query
  insert into public.pod_pairing_sessions(pod_id, code_hash, token_hash, source_ip_hash)
  values (p_pod_id, p_code_hash, p_token_hash, p_source_ip_hash)
  returning pod_pairing_sessions.id, pod_pairing_sessions.expires_at;
end;
$$;

create or replace function public.claim_pod_pairing(
  p_code_hash text,
  p_owner_id uuid,
  p_name text
)
returns public.pods
language plpgsql
security definer
set search_path = ''
as $$
declare
  pairing public.pod_pairing_sessions;
  pod public.pods;
begin
  select * into pairing
  from public.pod_pairing_sessions
  where code_hash = p_code_hash
  for update;

  if pairing.id is null or pairing.claimed_at is not null or pairing.expires_at <= now() then
    raise exception 'invalid_pairing_code' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.pods
    where owner_id = p_owner_id and revoked_at is null
  ) then
    raise exception 'active_pod_exists' using errcode = 'P0001';
  end if;

  insert into public.pods(id, owner_id, name, token_hash)
  values (pairing.pod_id, p_owner_id, p_name, pairing.token_hash)
  returning * into pod;

  update public.pod_pairing_sessions
  set claimed_at = now()
  where id = pairing.id;

  return pod;
end;
$$;

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

revoke all on public.pod_pairing_sessions from anon, authenticated;
revoke insert, update, delete on public.pods from anon, authenticated;
revoke insert, update, delete on public.approval_requests from anon, authenticated;
revoke insert, update, delete on public.approval_decisions from anon, authenticated;
revoke all on function public.create_pod_pairing_session(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_pod_pairing(text, uuid, text) from public, anon, authenticated;
revoke all on function public.decide_approval(uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_pod_pairing_session(uuid, text, text, text) to service_role;
grant execute on function public.claim_pod_pairing(text, uuid, text) to service_role;
grant execute on function public.decide_approval(uuid, uuid, uuid, text, text, uuid) to service_role;
