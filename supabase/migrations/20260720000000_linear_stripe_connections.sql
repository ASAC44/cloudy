begin;

alter table public.connections
  drop constraint connections_provider_check;

alter table public.connections
  add constraint connections_provider_check
  check (provider in ('github', 'gmail', 'vercel', 'telegram', 'linear', 'stripe', 'custom_mcp'));

commit;
