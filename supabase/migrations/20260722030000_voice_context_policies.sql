begin;

alter table public.ping_rule_context_bindings
  add column required boolean not null default true,
  add column activation text not null default 'always'
    check (activation in ('always', 'scheduling_intent', 'selected_recipient', 'selected_thread')),
  add column failure_policy text not null default 'abort'
    check (failure_policy in ('abort', 'continue_with_warning')),
  add check ((required and failure_policy = 'abort') or (not required and failure_policy = 'continue_with_warning'));

create or replace function public.apply_ping_context_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy jsonb;
begin
  select rules.definition->'context'->new.position->'policy' into policy
  from public.ping_rules rules
  where rules.id = new.rule_id and rules.owner_id = new.owner_id;

  if jsonb_typeof(policy) = 'object' then
    new.required := coalesce((policy->>'required')::boolean, true);
    new.activation := coalesce(policy->>'activation', 'always');
    new.failure_policy := coalesce(policy->>'failure_policy', case when new.required then 'abort' else 'continue_with_warning' end);
  else
    new.required := true;
    new.activation := 'always';
    new.failure_policy := 'abort';
  end if;
  return new;
end;
$$;

create trigger apply_ping_context_policy_before_write
before insert or update of rule_id, owner_id, position
on public.ping_rule_context_bindings
for each row execute function public.apply_ping_context_policy();

revoke all on function public.apply_ping_context_policy() from public, anon, authenticated;

commit;
