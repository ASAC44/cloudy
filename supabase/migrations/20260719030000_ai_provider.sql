alter table public.ai_settings
  add column if not exists provider text not null default 'custom'
  check (provider in ('openai', 'cerebras', 'openrouter', 'anthropic', 'custom'));
