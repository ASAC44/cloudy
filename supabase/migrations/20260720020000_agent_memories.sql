begin;

create table public.agent_memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('user', 'workspace', 'provider')),
  scope_id text not null default '',
  provider text not null default '' check (provider in ('', 'github', 'gmail', 'vercel', 'telegram', 'linear', 'stripe', 'custom_mcp')),
  memory_key text not null check (char_length(memory_key) between 1 and 120),
  content text not null check (char_length(content) between 1 and 2000),
  source jsonb not null default '{}'::jsonb check (jsonb_typeof(source) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((scope = 'user' and scope_id = '') or (scope <> 'user' and scope_id <> '')),
  check ((scope = 'provider' and provider <> '') or scope <> 'provider'),
  unique(owner_id, scope, scope_id, provider, memory_key)
);

create index agent_memories_owner_scope on public.agent_memories(owner_id, scope, scope_id, updated_at desc) where deleted_at is null;
create index agent_memories_owner_provider on public.agent_memories(owner_id, provider, updated_at desc) where deleted_at is null;

alter table public.agent_memories enable row level security;
create policy "Users can read their agent memories" on public.agent_memories for select to authenticated using ((select auth.uid()) = owner_id and deleted_at is null);

commit;
