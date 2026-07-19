begin;

create or replace function public.claim_due_ping_rule(p_worker_id text, p_lease_seconds integer default 45)
returns table(rule_id uuid, owner_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.ping_rule_runtime_states;
  token uuid := gen_random_uuid();
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception 'invalid_worker_id' using errcode = 'P0001';
  end if;
  select states.* into claimed
  from public.ping_rule_runtime_states states
  join public.ping_rules rules on rules.id = states.rule_id
  where rules.status = 'active' and rules.schema_version = 2
    and coalesce(rules.definition->'source'->>'delivery', 'poll') = 'poll'
    and states.schema_drift = false and states.next_run_at <= now()
    and (states.leased_until is null or states.leased_until < now())
  order by states.next_run_at, states.rule_id
  for update of states skip locked
  limit 1;
  if claimed.rule_id is null then return; end if;
  update public.ping_rule_runtime_states
  set lease_token = token,
      leased_until = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300))),
      updated_at = now()
  where ping_rule_runtime_states.rule_id = claimed.rule_id;
  return query select claimed.rule_id, claimed.owner_id, token;
end;
$$;

revoke all on function public.claim_due_ping_rule(text, integer) from public, anon, authenticated;

commit;
