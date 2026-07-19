create table public.ai_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  base_url text not null check (
    char_length(base_url) between 8 and 2048
    and base_url ~ '^https://[^[:space:]]+$'
  ),
  model text not null check (char_length(model) between 1 and 200),
  encrypted_api_key text not null check (char_length(encrypted_api_key) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_settings enable row level security;

revoke all on public.ai_settings from anon, authenticated;
