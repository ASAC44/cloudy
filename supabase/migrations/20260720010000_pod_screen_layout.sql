begin;

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
    or pg_catalog.jsonb_object_length(p_layout) <> 3
    or not (p_layout ?& array['left', 'right', 'down']) then
    return false;
  end if;

  foreach direction in array array['left', 'right', 'down'] loop
    if jsonb_typeof(p_layout -> direction) <> 'array'
      or jsonb_array_length(p_layout -> direction) > 6 then
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
  add column screen_layout jsonb not null default '{"left":["app:github"],"right":["app:gmail"],"down":["app:codex"]}'::jsonb,
  add column screen_layout_revision bigint not null default 0,
  add constraint pods_valid_screen_layout check (public.valid_pod_screen_layout(screen_layout)),
  add constraint pods_screen_layout_revision_nonnegative check (screen_layout_revision >= 0);

create or replace function public.update_pod_screen_layout(
  p_owner_id uuid,
  p_pod_id uuid,
  p_expected_revision bigint,
  p_layout jsonb
)
returns public.pods
language plpgsql
security definer
set search_path = ''
as $$
declare
  pod public.pods;
begin
  if not public.valid_pod_screen_layout(p_layout) then
    raise exception 'invalid_pod_layout' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from (
      select jsonb_array_elements_text(p_layout -> 'left') as attachment_id
      union all select jsonb_array_elements_text(p_layout -> 'right')
      union all select jsonb_array_elements_text(p_layout -> 'down')
    ) attachment
    where attachment_id like 'connection:%'
      and not exists (
        select 1 from public.connections connection
        where connection.id = substring(attachment_id from 12)::uuid
          and connection.owner_id = p_owner_id
          and connection.provider = 'custom_mcp'
      )
  ) then
    raise exception 'invalid_pod_layout' using errcode = 'P0001';
  end if;

  select * into pod
  from public.pods
  where id = p_pod_id and owner_id = p_owner_id and revoked_at is null
  for update;

  if pod.id is null then
    raise exception 'pod_not_found' using errcode = 'P0001';
  end if;
  if pod.screen_layout_revision <> p_expected_revision then
    raise exception 'pod_layout_conflict' using errcode = 'P0001';
  end if;

  update public.pods
  set screen_layout = p_layout,
      screen_layout_revision = screen_layout_revision + 1
  where id = pod.id
  returning * into pod;

  return pod;
end;
$$;

create or replace function public.delete_connection_with_layout_cleanup(
  p_owner_id uuid,
  p_connection_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted boolean;
  attachment_id text := 'connection:' || p_connection_id::text;
begin
  delete from public.connections
  where id = p_connection_id and owner_id = p_owner_id
  returning true into deleted;

  if coalesce(deleted, false) then
    update public.pods
    set screen_layout = jsonb_build_object(
          'left', coalesce((select jsonb_agg(value order by ordinal) from jsonb_array_elements_text(screen_layout -> 'left') with ordinality item(value, ordinal) where value <> attachment_id), '[]'::jsonb),
          'right', coalesce((select jsonb_agg(value order by ordinal) from jsonb_array_elements_text(screen_layout -> 'right') with ordinality item(value, ordinal) where value <> attachment_id), '[]'::jsonb),
          'down', coalesce((select jsonb_agg(value order by ordinal) from jsonb_array_elements_text(screen_layout -> 'down') with ordinality item(value, ordinal) where value <> attachment_id), '[]'::jsonb)
        ),
        screen_layout_revision = screen_layout_revision + 1
    where owner_id = p_owner_id and screen_layout::text like '%' || attachment_id || '%';
  end if;

  return coalesce(deleted, false);
end;
$$;

revoke all on function public.valid_pod_screen_layout(jsonb) from public, anon, authenticated;
revoke all on function public.update_pod_screen_layout(uuid, uuid, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.delete_connection_with_layout_cleanup(uuid, uuid) from public, anon, authenticated;
grant execute on function public.valid_pod_screen_layout(jsonb) to service_role;
grant execute on function public.update_pod_screen_layout(uuid, uuid, bigint, jsonb) to service_role;
grant execute on function public.delete_connection_with_layout_cleanup(uuid, uuid) to service_role;

commit;
