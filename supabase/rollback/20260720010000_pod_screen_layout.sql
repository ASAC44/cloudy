begin;

drop function if exists public.delete_connection_with_layout_cleanup(uuid, uuid);
drop function if exists public.update_pod_screen_layout(uuid, uuid, bigint, jsonb);

alter table public.pods
  drop constraint if exists pods_screen_layout_revision_nonnegative,
  drop constraint if exists pods_valid_screen_layout,
  drop column if exists screen_layout_revision,
  drop column if exists screen_layout;

drop function if exists public.valid_pod_screen_layout(jsonb);

commit;
