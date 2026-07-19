create table public.codex_bridge_pairing_sessions (
  id uuid primary key default gen_random_uuid(),
  bridge_id uuid not null unique,
  code_hash text not null unique,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  claimed_at timestamptz
);

create table public.codex_bridges (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  token_hash text not null unique,
  version text,
  process_instance_id uuid,
  last_error text check (char_length(last_error) <= 500),
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create index codex_bridges_owner on public.codex_bridges(owner_id) where revoked_at is null;

create table public.codex_workspaces (
  id uuid primary key default gen_random_uuid(),
  bridge_id uuid not null references public.codex_bridges(id) on delete cascade,
  local_id uuid not null,
  label text not null check (char_length(label) between 1 and 120),
  available boolean not null default true,
  updated_at timestamptz not null default now(),
  unique(bridge_id, local_id),
  unique(id, bridge_id)
);

create index codex_workspaces_bridge on public.codex_workspaces(bridge_id);

create table public.codex_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.codex_workspaces(id) on delete cascade,
  codex_thread_id text not null check (char_length(codex_thread_id) between 1 and 200),
  title text not null default 'New Codex session' check (char_length(title) between 1 and 200),
  status text not null default 'idle' check (status in ('idle', 'planning', 'waiting', 'implementing', 'testing', 'completed', 'error')),
  milestone text not null default '' check (char_length(milestone) <= 1000),
  final_summary text not null default '' check (char_length(final_summary) <= 2000),
  last_error text check (char_length(last_error) <= 500),
  updated_at timestamptz not null default now(),
  unique(workspace_id, codex_thread_id),
  unique(id, workspace_id)
);

create index codex_threads_workspace on public.codex_threads(workspace_id, updated_at desc);

create table public.codex_targets (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.codex_workspaces(id) on delete cascade,
  thread_id uuid,
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  foreign key (thread_id, workspace_id)
    references public.codex_threads(id, workspace_id) on delete set null (thread_id)
);

create index codex_targets_workspace on public.codex_targets(workspace_id);
create index codex_targets_thread on public.codex_targets(thread_id) where thread_id is not null;

create table public.codex_interactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  bridge_id uuid not null references public.codex_bridges(id) on delete cascade,
  workspace_id uuid not null,
  thread_id uuid,
  approval_request_id uuid unique references public.approval_requests(id) on delete cascade,
  process_instance_id uuid not null,
  protocol_request_id text not null check (char_length(protocol_request_id) between 1 and 200),
  kind text not null check (kind in ('command_approval', 'file_change_approval', 'permission_approval', 'plan_review')),
  encrypted_payload text not null,
  payload_hash text not null check (char_length(payload_hash) = 64),
  status text not null default 'pending' check (status in ('pending', 'resolved', 'delivered', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  foreign key (workspace_id, bridge_id)
    references public.codex_workspaces(id, bridge_id) on delete cascade,
  foreign key (thread_id, workspace_id)
    references public.codex_threads(id, workspace_id) on delete set null (thread_id),
  unique(bridge_id, process_instance_id, protocol_request_id)
);

create index codex_interactions_owner_pending on public.codex_interactions(owner_id, created_at) where status = 'pending';
create index codex_interactions_bridge_pending on public.codex_interactions(bridge_id, created_at) where status = 'pending';
create index codex_interactions_workspace on public.codex_interactions(workspace_id);
create index codex_interactions_thread on public.codex_interactions(thread_id) where thread_id is not null;
create index codex_interactions_expiry on public.codex_interactions(expires_at) where status = 'pending';

create table public.codex_commands (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  owner_id uuid not null references auth.users(id) on delete cascade,
  bridge_id uuid not null references public.codex_bridges(id) on delete cascade,
  workspace_id uuid not null,
  thread_id uuid,
  interaction_id uuid references public.codex_interactions(id) on delete cascade,
  kind text not null check (kind in ('prompt', 'decision', 'new_thread')),
  payload jsonb not null,
  idempotency_key uuid not null unique,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'acknowledged', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  claimed_at timestamptz,
  acknowledged_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  foreign key (workspace_id, bridge_id)
    references public.codex_workspaces(id, bridge_id) on delete cascade,
  foreign key (thread_id, workspace_id)
    references public.codex_threads(id, workspace_id) on delete set null (thread_id)
);

create index codex_commands_bridge_pending on public.codex_commands(bridge_id, sequence) where status in ('pending', 'claimed');
create index codex_commands_owner on public.codex_commands(owner_id, created_at desc);
create index codex_commands_workspace on public.codex_commands(workspace_id);
create index codex_commands_thread on public.codex_commands(thread_id) where thread_id is not null;
create index codex_commands_interaction on public.codex_commands(interaction_id) where interaction_id is not null;
create index codex_commands_expiry on public.codex_commands(expires_at) where status in ('pending', 'claimed');

alter table public.codex_bridge_pairing_sessions enable row level security;
alter table public.codex_bridges enable row level security;
alter table public.codex_workspaces enable row level security;
alter table public.codex_threads enable row level security;
alter table public.codex_targets enable row level security;
alter table public.codex_interactions enable row level security;
alter table public.codex_commands enable row level security;

create policy "Users can read their Codex bridges" on public.codex_bridges for select to authenticated using ((select auth.uid()) = owner_id);
create policy "Users can read their Codex workspaces" on public.codex_workspaces for select to authenticated using (exists (select 1 from public.codex_bridges bridge where bridge.id = bridge_id and bridge.owner_id = (select auth.uid())));
create policy "Users can read their Codex threads" on public.codex_threads for select to authenticated using (exists (select 1 from public.codex_workspaces workspace join public.codex_bridges bridge on bridge.id = workspace.bridge_id where workspace.id = workspace_id and bridge.owner_id = (select auth.uid())));
create policy "Users can read their Codex target" on public.codex_targets for select to authenticated using ((select auth.uid()) = owner_id);
create policy "Users can read their Codex interactions" on public.codex_interactions for select to authenticated using ((select auth.uid()) = owner_id);
create policy "Users can read their Codex commands" on public.codex_commands for select to authenticated using ((select auth.uid()) = owner_id);

create or replace function public.claim_codex_bridge(p_code_hash text, p_owner_id uuid, p_name text)
returns public.codex_bridges
language plpgsql security definer set search_path = ''
as $$
declare pairing public.codex_bridge_pairing_sessions; bridge public.codex_bridges;
begin
  select * into pairing from public.codex_bridge_pairing_sessions where code_hash = p_code_hash for update;
  if pairing.id is null or pairing.claimed_at is not null or pairing.expires_at <= now() then
    raise exception 'invalid_bridge_pairing_code' using errcode = 'P0001';
  end if;
  insert into public.codex_bridges(id, owner_id, name, token_hash)
  values (pairing.bridge_id, p_owner_id, p_name, pairing.token_hash) returning * into bridge;
  update public.codex_bridge_pairing_sessions set claimed_at = now() where id = pairing.id;
  return bridge;
end;
$$;

create or replace function public.sync_codex_bridge(
  p_owner_id uuid,
  p_bridge_id uuid,
  p_version text,
  p_process_instance_id uuid,
  p_error text,
  p_workspaces jsonb,
  p_threads jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  saved_workspaces jsonb;
  saved_threads jsonb;
begin
  update public.codex_bridges
  set version = p_version,
      process_instance_id = p_process_instance_id,
      last_error = p_error,
      last_seen_at = now()
  where id = p_bridge_id and owner_id = p_owner_id and revoked_at is null;
  if not found then raise exception 'codex_bridge_not_authorized' using errcode = 'P0001'; end if;

  update public.codex_interactions interaction
  set status = 'expired'
  where interaction.bridge_id = p_bridge_id
    and interaction.status in ('pending', 'resolved')
    and interaction.process_instance_id <> p_process_instance_id;

  update public.codex_commands command
  set status = 'expired'
  from public.codex_interactions interaction
  where command.interaction_id = interaction.id
    and command.bridge_id = p_bridge_id
    and command.status in ('pending', 'claimed')
    and interaction.process_instance_id <> p_process_instance_id;

  update public.codex_workspaces set available = false, updated_at = now()
  where bridge_id = p_bridge_id;

  insert into public.codex_workspaces(bridge_id, local_id, label, available, updated_at)
  select p_bridge_id, snapshot.local_id, snapshot.label, true, now()
  from jsonb_to_recordset(p_workspaces) as snapshot(local_id uuid, label text)
  on conflict (bridge_id, local_id) do update
  set label = excluded.label, available = true, updated_at = excluded.updated_at;

  insert into public.codex_threads(workspace_id, codex_thread_id, title, status, milestone, final_summary, last_error, updated_at)
  select workspace.id, snapshot.codex_thread_id, snapshot.title, snapshot.status,
    snapshot.milestone, snapshot.final_summary, snapshot.last_error, now()
  from jsonb_to_recordset(p_threads) as snapshot(
    workspace_local_id uuid,
    codex_thread_id text,
    title text,
    status text,
    milestone text,
    final_summary text,
    last_error text
  )
  join public.codex_workspaces workspace
    on workspace.bridge_id = p_bridge_id and workspace.local_id = snapshot.workspace_local_id
  on conflict (workspace_id, codex_thread_id) do update
  set title = excluded.title,
      status = excluded.status,
      milestone = excluded.milestone,
      final_summary = excluded.final_summary,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at;

  select coalesce(jsonb_agg(to_jsonb(workspace_row)), '[]'::jsonb)
  into saved_workspaces
  from (
    select id, bridge_id, local_id, label, available, updated_at
    from public.codex_workspaces
    where bridge_id = p_bridge_id and available
    order by label
  ) workspace_row;

  select coalesce(jsonb_agg(to_jsonb(thread_row)), '[]'::jsonb)
  into saved_threads
  from (
    select thread.id, thread.workspace_id, thread.codex_thread_id, thread.title,
      thread.status, thread.milestone, thread.final_summary, thread.last_error, thread.updated_at
    from public.codex_threads thread
    join public.codex_workspaces workspace on workspace.id = thread.workspace_id
    where workspace.bridge_id = p_bridge_id and workspace.available
    order by thread.updated_at desc
  ) thread_row;

  return jsonb_build_object('workspaces', saved_workspaces, 'threads', saved_threads);
end;
$$;

create or replace function public.create_codex_interaction(
  p_owner_id uuid, p_bridge_id uuid, p_workspace_id uuid, p_thread_id uuid,
  p_process_instance_id uuid, p_protocol_request_id text, p_kind text,
  p_encrypted_payload text, p_payload_hash text, p_title text, p_summary text,
  p_risk text, p_expires_at timestamptz
)
returns public.approval_requests
language plpgsql security definer set search_path = ''
as $$
declare interaction public.codex_interactions; request public.approval_requests; bridge_instance uuid;
begin
  select process_instance_id into bridge_instance from public.codex_bridges
  where id = p_bridge_id and owner_id = p_owner_id and revoked_at is null
  for update;
  if bridge_instance is distinct from p_process_instance_id then
    raise exception 'codex_bridge_not_authorized' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.codex_workspaces where id = p_workspace_id and bridge_id = p_bridge_id and available) then
    raise exception 'codex_target_not_found' using errcode = 'P0001';
  end if;
  if p_thread_id is not null and not exists (select 1 from public.codex_threads where id = p_thread_id and workspace_id = p_workspace_id) then
    raise exception 'codex_target_not_found' using errcode = 'P0001';
  end if;
  insert into public.codex_interactions(owner_id, bridge_id, workspace_id, thread_id, process_instance_id, protocol_request_id, kind, encrypted_payload, payload_hash, expires_at)
  values (p_owner_id, p_bridge_id, p_workspace_id, p_thread_id, p_process_instance_id, p_protocol_request_id, p_kind, p_encrypted_payload, p_payload_hash, p_expires_at)
  on conflict (bridge_id, process_instance_id, protocol_request_id) do update set protocol_request_id = excluded.protocol_request_id
  returning * into interaction;
  if interaction.owner_id <> p_owner_id
    or interaction.workspace_id <> p_workspace_id
    or interaction.thread_id is distinct from p_thread_id
    or interaction.kind <> p_kind
    or interaction.payload_hash <> p_payload_hash then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if interaction.approval_request_id is not null then
    select * into request from public.approval_requests where id = interaction.approval_request_id;
    return request;
  end if;
  insert into public.approval_requests(owner_id, title, source, summary, details, affected_context, risk, warnings, priority, action_payload, payload_hash, expires_at)
  values (p_owner_id, p_title, 'Codex', p_summary, '', '', p_risk, '{}', case p_risk when 'high' then 2 when 'medium' then 1 else 0 end, jsonb_build_object('kind', 'codex_interaction', 'interaction_id', interaction.id), p_payload_hash, p_expires_at)
  returning * into request;
  update public.codex_interactions set approval_request_id = request.id where id = interaction.id;
  return request;
end;
$$;

create or replace function public.set_codex_target(
  p_owner_id uuid,
  p_workspace_id uuid,
  p_thread_id uuid,
  p_expected_revision integer
)
returns public.codex_targets
language plpgsql security definer set search_path = ''
as $$
declare target public.codex_targets;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text, 0));
  if not exists (
    select 1 from public.codex_workspaces workspace
    join public.codex_bridges bridge on bridge.id = workspace.bridge_id
    where workspace.id = p_workspace_id and workspace.available
      and bridge.owner_id = p_owner_id and bridge.revoked_at is null
  ) then
    raise exception 'codex_target_not_found' using errcode = 'P0001';
  end if;
  if p_thread_id is not null and not exists (
    select 1 from public.codex_threads where id = p_thread_id and workspace_id = p_workspace_id
  ) then
    raise exception 'codex_target_not_found' using errcode = 'P0001';
  end if;

  select * into target from public.codex_targets where owner_id = p_owner_id for update;
  if target.owner_id is null then
    if p_expected_revision is not null then return null; end if;
    insert into public.codex_targets(owner_id, workspace_id, thread_id)
    values (p_owner_id, p_workspace_id, p_thread_id) returning * into target;
    return target;
  end if;
  if p_expected_revision is null or target.revision <> p_expected_revision then return null; end if;
  update public.codex_targets
  set workspace_id = p_workspace_id, thread_id = p_thread_id,
      revision = revision + 1, updated_at = now()
  where owner_id = p_owner_id returning * into target;
  return target;
end;
$$;

create or replace function public.revoke_codex_bridge(p_owner_id uuid, p_bridge_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.codex_bridges set revoked_at = now()
  where id = p_bridge_id and owner_id = p_owner_id and revoked_at is null;
  if not found then return false; end if;
  update public.codex_workspaces set available = false, updated_at = now()
  where bridge_id = p_bridge_id;
  update public.codex_interactions set status = 'cancelled'
  where bridge_id = p_bridge_id and status in ('pending', 'resolved');
  update public.codex_commands set status = 'expired'
  where bridge_id = p_bridge_id and status in ('pending', 'claimed');
  update public.approval_requests request set status = 'cancelled', decided_at = now()
  where request.status = 'pending' and exists (
    select 1 from public.codex_interactions interaction
    where interaction.approval_request_id = request.id and interaction.bridge_id = p_bridge_id
  );
  return true;
end;
$$;

create or replace function public.expire_approval_requests()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.approval_requests set status = 'expired', decided_at = now()
  where status = 'pending' and expires_at <= now();
  update public.codex_interactions interaction set status = 'expired'
  where interaction.status = 'pending' and interaction.expires_at <= now();
  update public.codex_commands command set status = 'expired'
  where command.status in ('pending', 'claimed') and command.expires_at <= now();
end;
$$;

create or replace function public.queue_codex_command(
  p_owner_id uuid,
  p_workspace_id uuid,
  p_thread_id uuid,
  p_kind text,
  p_payload jsonb,
  p_idempotency_key uuid,
  p_target_revision integer
)
returns public.codex_commands
language plpgsql security definer set search_path = ''
as $$
declare
  bridge public.codex_bridges;
  command public.codex_commands;
  target public.codex_targets;
begin
  if p_target_revision is not null then
    select * into target from public.codex_targets where owner_id = p_owner_id for update;
    if target.owner_id is null or target.revision <> p_target_revision
      or target.workspace_id <> p_workspace_id
      or target.thread_id is distinct from p_thread_id then
      raise exception 'codex_target_changed' using errcode = 'P0001';
    end if;
  end if;
  select bridge_row.* into bridge
  from public.codex_workspaces workspace
  join public.codex_bridges bridge_row on bridge_row.id = workspace.bridge_id
  where workspace.id = p_workspace_id
    and workspace.available
    and bridge_row.owner_id = p_owner_id
    and bridge_row.revoked_at is null
  for update of bridge_row;
  if bridge.id is null then raise exception 'codex_target_not_found' using errcode = 'P0001'; end if;

  if p_thread_id is not null and not exists (
    select 1 from public.codex_threads where id = p_thread_id and workspace_id = p_workspace_id
  ) then
    raise exception 'codex_target_not_found' using errcode = 'P0001';
  end if;

  select * into command from public.codex_commands
  where idempotency_key = p_idempotency_key for update;
  if command.id is not null then
    if command.owner_id <> p_owner_id
      or command.workspace_id <> p_workspace_id
      or command.thread_id is distinct from p_thread_id
      or command.kind <> p_kind
      or command.payload <> p_payload then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return command;
  end if;

  insert into public.codex_commands(owner_id, bridge_id, workspace_id, thread_id, kind, payload, idempotency_key)
  values (p_owner_id, bridge.id, p_workspace_id, p_thread_id, p_kind, p_payload, p_idempotency_key)
  returning * into command;
  return command;
end;
$$;

create or replace function public.claim_codex_command(p_bridge_id uuid, p_process_instance_id uuid)
returns setof public.codex_commands
language plpgsql security definer set search_path = ''
as $$
declare command public.codex_commands;
begin
  if not exists (
    select 1 from public.codex_bridges
    where id = p_bridge_id and process_instance_id = p_process_instance_id and revoked_at is null
  ) then raise exception 'codex_bridge_not_authorized' using errcode = 'P0001'; end if;
  update public.codex_commands set status = 'expired' where bridge_id = p_bridge_id and status in ('pending', 'claimed') and expires_at <= now();
  update public.codex_commands set status = 'pending', claimed_at = null
  where bridge_id = p_bridge_id and status = 'claimed'
    and claimed_at < now() - interval '30 seconds' and expires_at > now();
  select command_row.* into command from public.codex_commands command_row
  where command_row.bridge_id = p_bridge_id and command_row.status = 'pending' and command_row.expires_at > now()
    and (
      command_row.interaction_id is null
      or exists (
        select 1 from public.codex_interactions interaction
        where interaction.id = command_row.interaction_id
          and interaction.process_instance_id = p_process_instance_id
      )
    )
  order by sequence for update skip locked limit 1;
  if command.id is null then return; end if;
  update public.codex_commands set status = 'claimed', claimed_at = now() where id = command.id returning * into command;
  return next command;
end;
$$;

create or replace function public.revise_codex_plan(
  p_owner_id uuid,
  p_pod_id uuid,
  p_request_id uuid,
  p_payload_hash text,
  p_decision_idempotency_key uuid,
  p_prompt_idempotency_key uuid,
  p_target_revision integer,
  p_prompt text
)
returns public.codex_commands
language plpgsql security definer set search_path = ''
as $$
declare
  interaction public.codex_interactions;
  target public.codex_targets;
  command public.codex_commands;
  decision public.approval_decisions;
begin
  select interaction_row.* into interaction
  from public.codex_interactions interaction_row
  where interaction_row.approval_request_id = p_request_id
    and interaction_row.owner_id = p_owner_id
    and interaction_row.kind = 'plan_review'
  for update;
  if interaction.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;

  select * into target from public.codex_targets
  where owner_id = p_owner_id for update;
  if target.owner_id is null or target.revision <> p_target_revision
    or target.workspace_id <> interaction.workspace_id
    or target.thread_id is distinct from interaction.thread_id then
    raise exception 'codex_target_changed' using errcode = 'P0001';
  end if;

  select * into decision from public.decide_approval(
    p_owner_id, p_pod_id, p_request_id, 'rejected', p_payload_hash,
    p_decision_idempotency_key
  );
  if decision.id is null then return null; end if;
  select * into command from public.queue_codex_command(
    p_owner_id, target.workspace_id, target.thread_id, 'prompt',
    jsonb_build_object('prompt', p_prompt), p_prompt_idempotency_key,
    p_target_revision
  );
  return command;
end;
$$;

create or replace function public.acknowledge_codex_command(
  p_bridge_id uuid,
  p_process_instance_id uuid,
  p_command_id uuid,
  p_ok boolean,
  p_error text
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare command public.codex_commands;
begin
  if not exists (
    select 1 from public.codex_bridges
    where id = p_bridge_id and process_instance_id = p_process_instance_id and revoked_at is null
  ) then raise exception 'codex_bridge_not_authorized' using errcode = 'P0001'; end if;
  select command_row.* into command from public.codex_commands command_row
  where command_row.id = p_command_id and command_row.bridge_id = p_bridge_id and command_row.status = 'claimed'
    and (
      command_row.interaction_id is null
      or exists (
        select 1 from public.codex_interactions interaction
        where interaction.id = command_row.interaction_id
          and interaction.process_instance_id = p_process_instance_id
      )
    )
  for update;
  if command.id is null then return false; end if;

  update public.codex_commands
  set status = case when p_ok then 'acknowledged' else 'failed' end,
      acknowledged_at = now(),
      last_error = left(p_error, 500)
  where id = command.id;

  if command.interaction_id is not null and p_ok then
    update public.codex_interactions set status = 'delivered'
    where id = command.interaction_id and bridge_id = p_bridge_id;
  end if;
  return true;
end;
$$;

create or replace function public.decide_approval(
  p_owner_id uuid, p_pod_id uuid, p_request_id uuid, p_outcome text,
  p_payload_hash text, p_idempotency_key uuid
)
returns public.approval_decisions
language plpgsql security definer set search_path = ''
as $$
declare request public.approval_requests; decision public.approval_decisions; interaction public.codex_interactions;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key::text, 0));
  select * into decision from public.approval_decisions where idempotency_key = p_idempotency_key;
  if decision.id is not null then
    if decision.request_id <> p_request_id or decision.pod_id <> p_pod_id or decision.outcome <> p_outcome or decision.payload_hash <> p_payload_hash then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return decision;
  end if;
  if p_outcome not in ('approved', 'rejected') then raise exception 'invalid_outcome' using errcode = 'P0001'; end if;
  select * into request from public.approval_requests where id = p_request_id and owner_id = p_owner_id for update;
  if request.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.pods where id = p_pod_id and owner_id = p_owner_id and revoked_at is null) then raise exception 'pod_not_authorized' using errcode = 'P0001'; end if;
  if request.status <> 'pending' then raise exception 'request_already_resolved' using errcode = 'P0001'; end if;
  if request.expires_at <= now() then
    update public.approval_requests set status = 'expired', decided_at = now() where id = request.id;
    update public.codex_interactions set status = 'expired' where approval_request_id = request.id;
    return null;
  end if;
  if request.payload_hash <> p_payload_hash then raise exception 'payload_changed' using errcode = 'P0001'; end if;
  insert into public.approval_decisions(request_id, pod_id, outcome, payload_hash, idempotency_key)
  values (request.id, p_pod_id, p_outcome, p_payload_hash, p_idempotency_key) returning * into decision;
  update public.approval_requests set status = p_outcome, decided_at = decision.decided_at where id = request.id;
  select * into interaction from public.codex_interactions where approval_request_id = request.id for update;
  if interaction.id is not null then
    update public.codex_interactions set status = 'resolved', resolved_at = decision.decided_at where id = interaction.id;
    insert into public.codex_commands(owner_id, bridge_id, workspace_id, thread_id, interaction_id, kind, payload, idempotency_key)
    values (p_owner_id, interaction.bridge_id, interaction.workspace_id, interaction.thread_id, interaction.id, 'decision', jsonb_build_object('outcome', p_outcome, 'kind', interaction.kind, 'protocol_request_id', interaction.protocol_request_id), decision.id);
  end if;
  return decision;
end;
$$;

revoke all on public.codex_bridge_pairing_sessions, public.codex_bridges, public.codex_workspaces, public.codex_threads, public.codex_targets, public.codex_interactions, public.codex_commands from anon, authenticated;
grant select on public.codex_bridges, public.codex_workspaces, public.codex_threads, public.codex_targets, public.codex_interactions, public.codex_commands to authenticated;
revoke all on function public.claim_codex_bridge(text, uuid, text), public.sync_codex_bridge(uuid, uuid, text, uuid, text, jsonb, jsonb), public.create_codex_interaction(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, timestamptz), public.set_codex_target(uuid, uuid, uuid, integer), public.revoke_codex_bridge(uuid, uuid), public.expire_approval_requests(), public.queue_codex_command(uuid, uuid, uuid, text, jsonb, uuid, integer), public.claim_codex_command(uuid, uuid), public.revise_codex_plan(uuid, uuid, uuid, text, uuid, uuid, integer, text), public.acknowledge_codex_command(uuid, uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_codex_bridge(text, uuid, text), public.sync_codex_bridge(uuid, uuid, text, uuid, text, jsonb, jsonb), public.create_codex_interaction(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, timestamptz), public.set_codex_target(uuid, uuid, uuid, integer), public.revoke_codex_bridge(uuid, uuid), public.expire_approval_requests(), public.queue_codex_command(uuid, uuid, uuid, text, jsonb, uuid, integer), public.claim_codex_command(uuid, uuid), public.revise_codex_plan(uuid, uuid, uuid, text, uuid, uuid, integer, text), public.acknowledge_codex_command(uuid, uuid, uuid, boolean, text) to service_role;
