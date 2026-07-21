begin;

select cron.unschedule(jobid)
from cron.job
where jobname in (
  'cloudy-purge-expired-rule-builder-sessions',
  'cloudy-purge-ping-runtime-data'
);

select cron.schedule(
  'podex-purge-expired-rule-builder-sessions',
  '17 3 * * *',
  'select public.purge_expired_rule_builder_sessions()'
)
where not exists (
  select 1 from cron.job where jobname = 'podex-purge-expired-rule-builder-sessions'
);

select cron.schedule(
  'podex-purge-ping-runtime-data',
  '43 3 * * *',
  'select public.purge_ping_runtime_data()'
)
where not exists (
  select 1 from cron.job where jobname = 'podex-purge-ping-runtime-data'
);

commit;
