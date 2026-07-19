begin;

do $$
begin
  if exists (
    select 1 from public.connections where provider in ('linear', 'stripe')
  ) then
    raise exception 'Refusing rollback while Linear or Stripe connections exist';
  end if;
end;
$$;

alter table public.connections
  drop constraint connections_provider_check;

alter table public.connections
  add constraint connections_provider_check
  check (provider in ('github', 'gmail', 'vercel', 'telegram', 'custom_mcp'));

commit;
