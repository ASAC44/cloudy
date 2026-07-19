create table public.connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  provider text not null check (provider in ('github', 'gmail', 'vercel', 'telegram', 'custom_mcp')),
  protocol text not null check (protocol in ('mcp', 'rest')),
  endpoint_url text not null check (char_length(endpoint_url) between 1 and 2000),
  auth_type text not null check (auth_type in ('oauth', 'bearer', 'none')),
  status text not null default 'untested' check (status in ('untested', 'connected', 'failed')),
  account_label text check (account_label is null or char_length(account_label) <= 160),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_tested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index connections_owner_name
  on public.connections(owner_id, lower(name));

create index connections_owner_created
  on public.connections(owner_id, created_at desc);

create table public.connection_secrets (
  connection_id uuid primary key references public.connections(id) on delete cascade,
  encrypted_payload text not null,
  key_version smallint not null default 1 check (key_version > 0),
  updated_at timestamptz not null default now()
);

create table public.connection_oauth_states (
  state_hash text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('github', 'gmail')),
  connection_name text not null check (char_length(connection_name) between 1 and 80),
  connection_id uuid references public.connections(id) on delete cascade,
  code_verifier text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  used_at timestamptz
);

create index connection_oauth_states_expiry
  on public.connection_oauth_states(expires_at)
  where used_at is null;

alter table public.connections enable row level security;
alter table public.connection_secrets enable row level security;
alter table public.connection_oauth_states enable row level security;

create policy "Users can read their connections"
  on public.connections for select to authenticated
  using ((select auth.uid()) = owner_id);

revoke insert, update, delete on public.connections from anon, authenticated;
revoke all on public.connection_secrets from anon, authenticated;
revoke all on public.connection_oauth_states from anon, authenticated;
