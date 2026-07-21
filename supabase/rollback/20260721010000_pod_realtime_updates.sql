begin;

drop trigger if exists notify_pod_codex_bridge_change on public.codex_bridges;
drop trigger if exists notify_pod_codex_target_change on public.codex_targets;
drop trigger if exists notify_pod_connection_change on public.connections;
drop trigger if exists notify_pod_revocation on public.pods;
drop trigger if exists notify_pod_layout_change on public.pods;
drop trigger if exists notify_pod_request_change on public.approval_requests;
drop function if exists public.notify_pod_state_change();

commit;
