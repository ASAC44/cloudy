begin;

create index memory_message_examples_owner_eligible_recent
  on public.memory_message_examples(owner_id, eligibility, occurred_at desc, id desc)
  where deleted_at is null;

commit;
