begin;

do $$
begin
  if exists (select 1 from public.memory_message_examples where source_kind = 'imported_sent')
    or exists (select 1 from public.memory_import_cursors where imported_count > 0) then
    raise exception 'Refusing rollback while imported message history exists';
  end if;
end;
$$;

drop function if exists public.fail_memory_import(uuid, uuid, text, boolean);
drop function if exists public.forget_memory_scope(uuid, text, uuid);
drop function if exists public.complete_memory_import(uuid, uuid, text, integer, boolean);
drop function if exists public.record_imported_message(uuid, uuid, text, text, text, text, jsonb, timestamptz);
drop function if exists public.claim_memory_import(integer);
drop function if exists public.configure_memory_import(uuid, uuid, text, text, text, integer);

alter table public.memory_import_cursors
  drop constraint if exists memory_import_cursor_completion,
  drop column if exists completed_at,
  drop column if exists excluded_count,
  drop column if exists imported_count,
  drop column if exists estimated_count,
  drop column if exists consented_at;

drop index if exists public.memory_message_examples_conversation_recent;
drop index if exists public.memory_message_examples_import_source;
alter table public.memory_message_examples
  drop constraint if exists memory_message_examples_source_shape,
  drop constraint if exists memory_message_examples_conversation_hash_format,
  drop constraint if exists memory_message_examples_provider_hash_format,
  drop column if exists conversation_id_hash,
  drop column if exists provider_message_id_hash,
  alter column decision_case_id set not null;

alter table public.ai_settings drop column if exists learned_actions_enabled;

commit;
