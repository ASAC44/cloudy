select cron.unschedule(jobid)
from cron.job
where jobname = 'cloudy-purge-expired-rule-builder-sessions';

drop function if exists public.purge_expired_rule_builder_sessions();
drop function if exists public.commit_ping_rule_session(
  uuid, uuid, integer, uuid, text, text, text, text, text, text, jsonb
);
drop table if exists public.rule_builder_sessions;
drop table if exists public.ping_rules;
drop index if exists public.connections_owner_id_unique;
drop index if exists public.pods_owner_id_unique;
