begin;

drop function if exists public.revise_ping_rule_reply(uuid, uuid, text, text, text, text, text, jsonb);
alter table public.ai_settings drop column if exists personalization_enabled;

commit;
