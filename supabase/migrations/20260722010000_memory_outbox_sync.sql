begin;

drop index public.memory_graph_refs_person;
drop index public.memory_graph_refs_identity;
drop index public.memory_graph_refs_decision;
drop index public.memory_graph_refs_example;
drop index public.memory_graph_refs_preference;

create unique index memory_graph_refs_person_node
  on public.memory_graph_refs(owner_id, person_id)
  where person_id is not null and graph_kind = 'node';
create index memory_graph_refs_person_history
  on public.memory_graph_refs(owner_id, person_id, graph_kind, created_at desc)
  where person_id is not null;

create unique index memory_graph_refs_identity_node
  on public.memory_graph_refs(owner_id, identity_id)
  where identity_id is not null and graph_kind = 'node';
create index memory_graph_refs_identity_history
  on public.memory_graph_refs(owner_id, identity_id, graph_kind, created_at desc)
  where identity_id is not null;

create unique index memory_graph_refs_decision_node
  on public.memory_graph_refs(owner_id, decision_case_id)
  where decision_case_id is not null and graph_kind = 'node';
create index memory_graph_refs_decision_history
  on public.memory_graph_refs(owner_id, decision_case_id, graph_kind, created_at desc)
  where decision_case_id is not null;

create unique index memory_graph_refs_example_node
  on public.memory_graph_refs(owner_id, message_example_id)
  where message_example_id is not null and graph_kind = 'node';
create index memory_graph_refs_example_history
  on public.memory_graph_refs(owner_id, message_example_id, graph_kind, created_at desc)
  where message_example_id is not null;

create unique index memory_graph_refs_preference_node
  on public.memory_graph_refs(owner_id, preference_id)
  where preference_id is not null and graph_kind = 'node';
create index memory_graph_refs_preference_history
  on public.memory_graph_refs(owner_id, preference_id, graph_kind, created_at desc)
  where preference_id is not null;

create or replace function public.claim_memory_outbox(p_lease_seconds integer default 120)
returns table(
  outbox_id uuid,
  owner_id uuid,
  aggregate_type text,
  aggregate_id uuid,
  event_type text,
  ontology_version smallint,
  payload jsonb,
  attempts smallint,
  created_at timestamptz,
  lease_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.memory_outbox;
  token uuid := gen_random_uuid();
begin
  select events.* into claimed
  from public.memory_outbox events
  where events.next_attempt_at <= now()
    and (
      events.status = 'pending'
      or (events.status = 'processing' and events.leased_until < now())
    )
    and not exists (
      select 1
      from public.memory_outbox earlier
      where earlier.owner_id = events.owner_id
        and (earlier.created_at, earlier.id) < (events.created_at, events.id)
        and earlier.status <> 'completed'
    )
  order by events.created_at, events.id
  for update of events skip locked
  limit 1;

  if claimed.id is null then return; end if;

  update public.memory_outbox as claimed_event
  set status = 'processing',
      attempts = claimed_event.attempts + 1,
      lease_token = token,
      leased_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 300))),
      updated_at = now()
  where claimed_event.id = claimed.id;

  return query select claimed.id, claimed.owner_id, claimed.aggregate_type,
    claimed.aggregate_id, claimed.event_type, claimed.ontology_version,
    claimed.payload, (claimed.attempts + 1)::smallint, claimed.created_at, token;
end;
$$;

create or replace function public.complete_memory_outbox(
  p_outbox_id uuid,
  p_lease_token uuid,
  p_graph_uuid text default null,
  p_graph_kind text default 'episode'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  event public.memory_outbox;
begin
  if p_graph_uuid is not null and (
    char_length(p_graph_uuid) not between 1 and 160
    or p_graph_kind not in ('node', 'edge', 'episode')
  ) then
    raise exception 'invalid_graph_reference' using errcode = 'P0001';
  end if;

  select * into event
  from public.memory_outbox
  where id = p_outbox_id and status = 'processing' and lease_token = p_lease_token
  for update;
  if event.id is null then return false; end if;

  if p_graph_uuid is not null and event.aggregate_type <> 'user' then
    insert into public.memory_graph_refs(
      owner_id, person_id, identity_id, decision_case_id, message_example_id,
      preference_id, graph_kind, graph_uuid, ontology_version
    ) values (
      event.owner_id,
      case when event.aggregate_type = 'person' then event.aggregate_id end,
      case when event.aggregate_type = 'identity' then event.aggregate_id end,
      case when event.aggregate_type = 'decision' then event.aggregate_id end,
      case when event.aggregate_type = 'message' then event.aggregate_id end,
      case when event.aggregate_type = 'preference' then event.aggregate_id end,
      p_graph_kind, p_graph_uuid, event.ontology_version
    );
  end if;

  update public.memory_outbox
  set status = 'completed', processed_at = now(), lease_token = null,
      leased_until = null, last_error = null, updated_at = now()
  where id = event.id;
  return true;
end;
$$;

create or replace function public.fail_memory_outbox(
  p_outbox_id uuid,
  p_lease_token uuid,
  p_error text,
  p_retryable boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.memory_outbox
  set status = case when p_retryable and attempts < 8 then 'pending' else 'dead_letter' end,
      next_attempt_at = case
        when p_retryable and attempts < 8
          then now() + make_interval(secs => least(900, (5 * power(2, attempts - 1))::integer))
        else next_attempt_at
      end,
      lease_token = null,
      leased_until = null,
      last_error = left(coalesce(nullif(p_error, ''), 'Graph memory sync failed'), 500),
      updated_at = now()
  where id = p_outbox_id and status = 'processing' and lease_token = p_lease_token;
  return found;
end;
$$;

revoke all on function public.claim_memory_outbox(integer) from public, anon, authenticated;
revoke all on function public.complete_memory_outbox(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.fail_memory_outbox(uuid, uuid, text, boolean) from public, anon, authenticated;

grant execute on function public.claim_memory_outbox(integer) to service_role;
grant execute on function public.complete_memory_outbox(uuid, uuid, text, text) to service_role;
grant execute on function public.fail_memory_outbox(uuid, uuid, text, boolean) to service_role;

commit;
