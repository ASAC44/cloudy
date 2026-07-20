begin;

do $$
begin
  if exists (select 1 from public.connections where provider = 'google_calendar')
    or exists (select 1 from public.connection_oauth_states where provider = 'google_calendar')
    or exists (select 1 from public.agent_memories where provider = 'google_calendar')
    or exists (select 1 from public.pods where screen_layout::text like '%app:google_calendar%') then
    raise exception 'Refusing rollback while Google Calendar data or screen assignments exist';
  end if;
end;
$$;

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('github', 'gmail', 'vercel', 'telegram', 'linear', 'stripe', 'custom_mcp'));

alter table public.connection_oauth_states drop constraint connection_oauth_states_provider_check;
alter table public.connection_oauth_states add constraint connection_oauth_states_provider_check
  check (provider in ('github', 'gmail'));

alter table public.agent_memories drop constraint agent_memories_provider_check;
alter table public.agent_memories add constraint agent_memories_provider_check
  check (provider in ('', 'github', 'gmail', 'vercel', 'telegram', 'linear', 'stripe', 'custom_mcp'));

alter table public.pods drop constraint pods_valid_screen_layout;

create or replace function public.valid_pod_screen_layout(p_layout jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  direction text;
  attachment_ids text[];
begin
  if jsonb_typeof(p_layout) <> 'object'
    or (select count(*) from pg_catalog.jsonb_object_keys(p_layout)) <> 3
    or not (p_layout ?& array['left', 'right', 'down']) then
    return false;
  end if;

  foreach direction in array array['left', 'right', 'down'] loop
    if jsonb_typeof(p_layout -> direction) <> 'array'
      or jsonb_array_length(p_layout -> direction) > 1 then
      return false;
    end if;
  end loop;

  select pg_catalog.array_agg(attachment_id)
  into attachment_ids
  from (
    select jsonb_array_elements_text(p_layout -> 'left') as attachment_id
    union all select jsonb_array_elements_text(p_layout -> 'right')
    union all select jsonb_array_elements_text(p_layout -> 'down')
  ) attachments;

  return coalesce(cardinality(attachment_ids), 0) = coalesce((select count(distinct value) from unnest(attachment_ids) value), 0)
    and not exists (
      select 1 from unnest(attachment_ids) attachment_id
      where attachment_id not in (
        'app:github', 'app:gmail', 'app:codex', 'app:vercel',
        'app:telegram', 'app:linear', 'app:stripe'
      ) and attachment_id !~ '^connection:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    );
end;
$$;

alter table public.pods
  add constraint pods_valid_screen_layout check (public.valid_pod_screen_layout(screen_layout));

commit;
