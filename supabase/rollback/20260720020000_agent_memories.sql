begin;

drop policy if exists "Users can read their agent memories" on public.agent_memories;
drop table if exists public.agent_memories;

commit;
