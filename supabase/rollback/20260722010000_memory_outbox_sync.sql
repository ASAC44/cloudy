begin;

drop function if exists public.fail_memory_outbox(uuid, uuid, text, boolean);
drop function if exists public.complete_memory_outbox(uuid, uuid, text, text);
drop function if exists public.claim_memory_outbox(integer);

do $$
begin
  if exists (
    select 1
    from public.memory_graph_refs
    group by owner_id, person_id, identity_id, decision_case_id,
      message_example_id, preference_id, graph_kind
    having count(*) > 1
  ) then
    raise exception 'memory_graph_refs contain multiple references that the previous schema cannot represent';
  end if;
end;
$$;

drop index public.memory_graph_refs_person_node;
drop index public.memory_graph_refs_person_history;
drop index public.memory_graph_refs_identity_node;
drop index public.memory_graph_refs_identity_history;
drop index public.memory_graph_refs_decision_node;
drop index public.memory_graph_refs_decision_history;
drop index public.memory_graph_refs_example_node;
drop index public.memory_graph_refs_example_history;
drop index public.memory_graph_refs_preference_node;
drop index public.memory_graph_refs_preference_history;

create unique index memory_graph_refs_person
  on public.memory_graph_refs(owner_id, person_id, graph_kind)
  where person_id is not null;
create unique index memory_graph_refs_identity
  on public.memory_graph_refs(owner_id, identity_id, graph_kind)
  where identity_id is not null;
create unique index memory_graph_refs_decision
  on public.memory_graph_refs(owner_id, decision_case_id, graph_kind)
  where decision_case_id is not null;
create unique index memory_graph_refs_example
  on public.memory_graph_refs(owner_id, message_example_id, graph_kind)
  where message_example_id is not null;
create unique index memory_graph_refs_preference
  on public.memory_graph_refs(owner_id, preference_id, graph_kind)
  where preference_id is not null;

commit;
