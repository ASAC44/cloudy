begin;

do $$
begin
  if exists (select 1 from public.ping_rules where schema_version = 2) then
    raise exception 'Refusing rollback while V2 Ping rules exist; pause/export them first.';
  end if;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'podex-purge-ping-runtime-data';

drop trigger if exists sync_ping_event_after_approval on public.approval_requests;
drop function if exists public.sync_ping_event_approval_status();
drop function if exists public.purge_ping_runtime_data();
drop function if exists public.complete_telegram_auth_session(uuid, uuid, text, text);
drop function if exists public.claim_telegram_auth_session(text, integer);
drop function if exists public.cancel_telegram_auth_session(uuid, uuid);
drop function if exists public.submit_telegram_auth_password(uuid, uuid, text);
drop function if exists public.create_telegram_auth_session(uuid, text);
drop function if exists public.claim_connection_runtime_lease(uuid, uuid, text, integer);
drop function if exists public.record_ping_connection_health(uuid, uuid, boolean, text);
drop function if exists public.complete_ping_action(uuid, uuid, boolean, boolean, boolean, boolean, text);
drop function if exists public.claim_approved_ping_action(integer);
drop function if exists public.prepare_ping_rule_approval(uuid, uuid, text, text, text, text, text, text, text, text, text, text[], timestamptz);
drop function if exists public.fail_ping_rule_event(uuid, uuid, text, boolean);
drop function if exists public.ignore_ping_rule_event(uuid, uuid, text);
drop function if exists public.claim_ping_rule_event(integer);
drop function if exists public.enqueue_ping_rule_event(uuid, uuid, text, text, text, timestamptz, text, text);
drop function if exists public.complete_ping_rule_run(uuid, uuid, boolean, timestamptz, jsonb, boolean, boolean, text, timestamptz);
drop function if exists public.claim_due_ping_rule(text, integer);
drop function if exists public.delete_ping_rule(uuid, uuid);
drop function if exists public.set_ping_rule_status(uuid, uuid, integer, text);
drop function if exists public.commit_ping_rule_session_v2(uuid, uuid, integer, uuid, text, text, text, text, text, jsonb, jsonb, uuid, text, text, text);

drop table if exists public.connection_runtime_leases;
drop table if exists public.telegram_auth_sessions;
drop table if exists public.ping_rule_runs;
drop table if exists public.ping_rule_events;
drop table if exists public.ping_rule_context_bindings;
drop table if exists public.ping_rule_runtime_states;

drop index if exists public.ping_rules_action_connection;
drop index if exists public.ping_rules_active_source;

alter table public.ping_rules
  drop constraint if exists ping_rules_owner_action_connection_fkey,
  drop constraint if exists ping_rules_action_complete,
  drop constraint if exists ping_rules_schema_version_check,
  drop column if exists activated_at,
  drop column if exists action_capability_safety,
  drop column if exists action_capability_schema_hash,
  drop column if exists action_capability_name,
  drop column if exists action_capability_id,
  drop column if exists action_connection_id,
  drop column if exists status,
  alter column schema_version set default 1,
  add constraint ping_rules_schema_version_check check (schema_version = 1);

drop index if exists public.approval_requests_owner_id_unique;

commit;
