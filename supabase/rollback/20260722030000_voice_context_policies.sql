begin;

do $$
begin
  if exists (
    select 1 from public.ping_rule_context_bindings
    where required = false or activation <> 'always' or failure_policy <> 'abort'
  ) then
    raise exception 'Refusing rollback while context policies would be lost';
  end if;
end;
$$;

drop trigger if exists apply_ping_context_policy_before_write on public.ping_rule_context_bindings;
drop function if exists public.apply_ping_context_policy();

alter table public.ping_rule_context_bindings
  drop column if exists required,
  drop column if exists activation,
  drop column if exists failure_policy;

commit;
