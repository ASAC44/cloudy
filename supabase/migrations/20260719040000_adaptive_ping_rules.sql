create unique index pods_owner_id_unique
  on public.pods(owner_id, id);

create unique index connections_owner_id_unique
  on public.connections(owner_id, id);

create table public.ping_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  destination_pod_id uuid not null,
  source_connection_id uuid not null,
  title text not null check (char_length(title) between 1 and 160),
  intent_summary text not null check (char_length(intent_summary) between 1 and 1000),
  capability_id text not null check (char_length(capability_id) between 1 and 300),
  capability_name text not null check (char_length(capability_name) between 1 and 160),
  capability_schema_hash text not null check (capability_schema_hash ~ '^[0-9a-f]{64}$'),
  capability_safety text not null check (capability_safety in ('verified_read', 'unannotated')),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  schema_version smallint not null default 1 check (schema_version = 1),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, destination_pod_id)
    references public.pods(owner_id, id) on delete restrict,
  foreign key (owner_id, source_connection_id)
    references public.connections(owner_id, id) on delete restrict
);

create index ping_rules_owner_updated
  on public.ping_rules(owner_id, updated_at desc);

create index ping_rules_destination_pod
  on public.ping_rules(destination_pod_id);

create index ping_rules_source_connection
  on public.ping_rules(source_connection_id);

create table public.rule_builder_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  destination_pod_id uuid not null,
  editing_rule_id uuid references public.ping_rules(id) on delete set null,
  completed_rule_id uuid references public.ping_rules(id) on delete set null,
  base_rule_revision integer check (base_rule_revision is null or base_rule_revision > 0),
  status text not null default 'open' check (status in ('open', 'completed')),
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  draft jsonb not null default '{}'::jsonb check (jsonb_typeof(draft) = 'object'),
  capability_snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(capability_snapshot) = 'array'),
  last_reply jsonb not null default '{}'::jsonb check (jsonb_typeof(last_reply) = 'object'),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  foreign key (owner_id, destination_pod_id)
    references public.pods(owner_id, id) on delete restrict
);

create index rule_builder_sessions_owner_updated
  on public.rule_builder_sessions(owner_id, updated_at desc);

create index rule_builder_sessions_expiry
  on public.rule_builder_sessions(expires_at)
  where status = 'open';

alter table public.ping_rules enable row level security;
alter table public.rule_builder_sessions enable row level security;

revoke all on public.ping_rules from anon, authenticated;
revoke all on public.rule_builder_sessions from anon, authenticated;

create or replace function public.commit_ping_rule_session(
  p_owner_id uuid,
  p_session_id uuid,
  p_expected_revision integer,
  p_source_connection_id uuid,
  p_title text,
  p_intent_summary text,
  p_capability_id text,
  p_capability_name text,
  p_capability_schema_hash text,
  p_capability_safety text,
  p_definition jsonb
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
    select * into rule from public.ping_rules where id = session.completed_rule_id;
    return rule;
  end if;

  if session.expires_at <= now() then
    raise exception 'rule_session_expired' using errcode = 'P0001';
  end if;

  if session.revision <> p_expected_revision then
    raise exception 'rule_session_conflict' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.pods
    where id = session.destination_pod_id
      and owner_id = p_owner_id
      and revoked_at is null
  ) then
    raise exception 'rule_pod_unavailable' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.connections
    where id = p_source_connection_id
      and owner_id = p_owner_id
      and status = 'connected'
  ) then
    raise exception 'rule_connection_unavailable' using errcode = 'P0001';
  end if;

  if session.editing_rule_id is null then
    insert into public.ping_rules(
      owner_id,
      destination_pod_id,
      source_connection_id,
      title,
      intent_summary,
      capability_id,
      capability_name,
      capability_schema_hash,
      capability_safety,
      definition
    ) values (
      p_owner_id,
      session.destination_pod_id,
      p_source_connection_id,
      p_title,
      p_intent_summary,
      p_capability_id,
      p_capability_name,
      p_capability_schema_hash,
      p_capability_safety,
      p_definition
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

    update public.ping_rules
    set source_connection_id = p_source_connection_id,
        destination_pod_id = session.destination_pod_id,
        title = p_title,
        intent_summary = p_intent_summary,
        capability_id = p_capability_id,
        capability_name = p_capability_name,
        capability_schema_hash = p_capability_schema_hash,
        capability_safety = p_capability_safety,
        definition = p_definition,
        revision = revision + 1,
        updated_at = now()
    where id = rule.id
    returning * into rule;
  end if;

  update public.rule_builder_sessions
  set status = 'completed',
      completed_rule_id = rule.id,
      messages = '[]'::jsonb,
      draft = '{}'::jsonb,
      capability_snapshot = '[]'::jsonb,
      last_reply = '{}'::jsonb,
      revision = revision + 1,
      updated_at = now()
  where id = session.id;

  return rule;
end;
$$;

create or replace function public.purge_expired_rule_builder_sessions()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  delete from public.rule_builder_sessions where expires_at <= now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.commit_ping_rule_session(
  uuid, uuid, integer, uuid, text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.purge_expired_rule_builder_sessions() from public, anon, authenticated;
grant execute on function public.commit_ping_rule_session(
  uuid, uuid, integer, uuid, text, text, text, text, text, text, jsonb
) to service_role;
grant execute on function public.purge_expired_rule_builder_sessions() to service_role;

create extension if not exists pg_cron;

select cron.schedule(
  'cloudy-purge-expired-rule-builder-sessions',
  '17 3 * * *',
  'select public.purge_expired_rule_builder_sessions()'
)
where not exists (
  select 1 from cron.job where jobname = 'cloudy-purge-expired-rule-builder-sessions'
);
