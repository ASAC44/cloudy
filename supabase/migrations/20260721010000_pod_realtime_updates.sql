begin;

create or replace function public.notify_pod_state_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  owner_id uuid := (changed ->> 'owner_id')::uuid;
  pod_id uuid := case when tg_table_name = 'pods' then (changed ->> 'id')::uuid else null end;
begin
  perform realtime.send(
    jsonb_build_object(
      'owner_id', owner_id,
      'pod_id', pod_id,
      'scope', tg_argv[0]
    ),
    'invalidate',
    'cloudy:pod-events',
    true
  );
  return null;
end;
$$;

revoke all on function public.notify_pod_state_change() from public, anon, authenticated;

create trigger notify_pod_request_change
after insert or update or delete on public.approval_requests
for each row execute function public.notify_pod_state_change('request');

create trigger notify_pod_layout_change
after update of screen_layout, screen_layout_revision on public.pods
for each row execute function public.notify_pod_state_change('layout');

create trigger notify_pod_revocation
after update of revoked_at on public.pods
for each row
when (old.revoked_at is distinct from new.revoked_at)
execute function public.notify_pod_state_change('revoked');

create trigger notify_pod_connection_change
after insert or update or delete on public.connections
for each row execute function public.notify_pod_state_change('connections');

create trigger notify_pod_codex_target_change
after insert or update or delete on public.codex_targets
for each row execute function public.notify_pod_state_change('codex');

create trigger notify_pod_codex_bridge_change
after insert or delete or update of last_seen_at, last_error, revoked_at on public.codex_bridges
for each row execute function public.notify_pod_state_change('codex');

commit;
