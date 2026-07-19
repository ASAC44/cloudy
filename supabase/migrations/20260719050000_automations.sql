create table public.automation_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  prefix text not null unique check (char_length(prefix) between 8 and 32),
  token_hash text not null unique check (char_length(token_hash) = 64),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create unique index automation_keys_active_owner_name
  on public.automation_keys(owner_id, lower(name))
  where revoked_at is null;

create index automation_keys_owner_created
  on public.automation_keys(owner_id, created_at desc);

alter table public.approval_requests
  add column automation_key_id uuid references public.automation_keys(id) on delete set null,
  add column external_id text check (external_id is null or char_length(external_id) between 1 and 200);

create unique index approval_requests_automation_external
  on public.approval_requests(automation_key_id, external_id)
  where automation_key_id is not null and external_id is not null;

create index approval_requests_automation_key
  on public.approval_requests(automation_key_id)
  where automation_key_id is not null;

create table public.approval_callbacks (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.approval_requests(id) on delete cascade,
  encrypted_url text not null check (char_length(encrypted_url) > 0),
  status text not null default 'waiting'
    check (status in ('waiting', 'pending', 'delivering', 'delivered', 'failed')),
  attempts smallint not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index approval_callbacks_delivery_queue
  on public.approval_callbacks(next_attempt_at, created_at)
  where status in ('pending', 'failed', 'delivering');

alter table public.automation_keys enable row level security;
alter table public.approval_callbacks enable row level security;

revoke all on public.automation_keys from anon, authenticated;
revoke all on public.approval_callbacks from anon, authenticated;

create or replace function public.create_automation_approval(
  p_owner_id uuid,
  p_automation_key_id uuid,
  p_external_id text,
  p_title text,
  p_source text,
  p_summary text,
  p_details text,
  p_affected_context text,
  p_risk text,
  p_warnings text[],
  p_priority smallint,
  p_action_payload jsonb,
  p_payload_hash text,
  p_expires_at timestamptz,
  p_encrypted_callback_url text
)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.approval_requests;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_automation_key_id::text || ':' || p_external_id, 0)
  );

  select * into request
  from public.approval_requests
  where automation_key_id = p_automation_key_id and external_id = p_external_id
  for update;

  if request.id is not null then
    if request.owner_id <> p_owner_id or request.payload_hash <> p_payload_hash then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return request;
  end if;

  insert into public.approval_requests(
    owner_id, automation_key_id, external_id, title, source, summary, details,
    affected_context, risk, warnings, priority, action_payload, payload_hash, expires_at
  ) values (
    p_owner_id, p_automation_key_id, p_external_id, p_title, p_source, p_summary, p_details,
    p_affected_context, p_risk, p_warnings, p_priority, p_action_payload, p_payload_hash, p_expires_at
  ) returning * into request;

  insert into public.approval_callbacks(request_id, encrypted_url)
  values (request.id, p_encrypted_callback_url);

  return request;
end;
$$;

create or replace function public.queue_approval_callback()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'pending' and new.status in ('approved', 'rejected', 'expired', 'cancelled') then
    update public.approval_callbacks
    set status = 'pending', next_attempt_at = now(), locked_at = null,
        last_error = null, updated_at = now()
    where request_id = new.id and status = 'waiting';
  end if;
  return new;
end;
$$;

create trigger queue_approval_callback_after_resolution
after update of status on public.approval_requests
for each row execute function public.queue_approval_callback();

create or replace function public.claim_approval_callback()
returns table(
  id uuid,
  request_id uuid,
  encrypted_url text,
  attempt smallint,
  request_status text,
  decided_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.approval_callbacks;
begin
  select * into claimed
  from public.approval_callbacks callbacks
  where (
    callbacks.status in ('pending', 'failed')
      and callbacks.next_attempt_at <= now()
  ) or (
    callbacks.status = 'delivering'
      and callbacks.locked_at < now() - interval '5 minutes'
  )
  order by callbacks.next_attempt_at nulls first, callbacks.created_at
  for update skip locked
  limit 1;

  if claimed.id is null then return; end if;

  update public.approval_callbacks
  set status = 'delivering', attempts = attempts + 1, locked_at = now(), updated_at = now()
  where approval_callbacks.id = claimed.id
  returning * into claimed;

  return query
  select claimed.id, claimed.request_id, claimed.encrypted_url, claimed.attempts,
    requests.status, requests.decided_at
  from public.approval_requests requests
  where requests.id = claimed.request_id;
end;
$$;

revoke all on function public.create_automation_approval(uuid, uuid, text, text, text, text, text, text, text, text[], smallint, jsonb, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.claim_approval_callback() from public, anon, authenticated;
revoke all on function public.queue_approval_callback() from public, anon, authenticated;
grant execute on function public.create_automation_approval(uuid, uuid, text, text, text, text, text, text, text, text[], smallint, jsonb, text, timestamptz, text) to service_role;
grant execute on function public.claim_approval_callback() to service_role;
