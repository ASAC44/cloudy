begin;

create unique index if not exists ping_rule_events_owner_id_unique
  on public.ping_rule_events(owner_id, id);

alter table public.ping_rule_events
  add column encrypted_revision_payload text;

create table public.memory_people (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'person' check (kind in ('person', 'organization')),
  encrypted_profile text not null check (char_length(encrypted_profile) between 1 and 20000),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (owner_id, id)
);

create index memory_people_owner_updated
  on public.memory_people(owner_id, updated_at desc, id)
  where deleted_at is null;

create table public.memory_identities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null,
  connection_id uuid references public.connections(id) on delete set null,
  channel text not null check (channel in ('gmail', 'telegram', 'slack', 'discord', 'custom')),
  external_id_hash text not null check (external_id_hash ~ '^[0-9a-f]{64}$'),
  encrypted_identity text not null check (char_length(encrypted_identity) between 1 and 20000),
  verification_source text not null check (verification_source in ('provider', 'user', 'import')),
  verified_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (owner_id, id),
  foreign key (owner_id, person_id)
    references public.memory_people(owner_id, id) on delete cascade
);

create unique index memory_identities_active_external
  on public.memory_identities(owner_id, connection_id, external_id_hash)
  where deleted_at is null;

create index memory_identities_person
  on public.memory_identities(owner_id, person_id, updated_at desc)
  where deleted_at is null;

create index memory_identities_connection
  on public.memory_identities(owner_id, connection_id, updated_at desc)
  where deleted_at is null;

create table public.memory_decision_cases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid references public.ping_rules(id) on delete set null,
  event_id uuid references public.ping_rule_events(id) on delete set null,
  approval_request_id uuid not null,
  approval_decision_id uuid references public.approval_decisions(id) on delete restrict,
  selected_person_id uuid,
  selected_identity_id uuid,
  action_connection_id uuid references public.connections(id) on delete set null,
  action_capability_id text check (action_capability_id is null or char_length(action_capability_id) between 1 and 300),
  encrypted_situation_payload text not null check (char_length(encrypted_situation_payload) between 1 and 100000),
  encrypted_candidate_payload text check (encrypted_candidate_payload is null or char_length(encrypted_candidate_payload) between 1 and 100000),
  approval_outcome text not null check (approval_outcome in ('approved', 'rejected', 'expired', 'cancelled')),
  delivery_outcome text not null default 'not_applicable'
    check (delivery_outcome in ('pending', 'delivered', 'failed', 'ambiguous', 'superseded', 'not_applicable')),
  occurred_at timestamptz not null,
  decided_at timestamptz not null,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  unique (approval_request_id),
  unique (event_id),
  foreign key (owner_id, approval_request_id)
    references public.approval_requests(owner_id, id) on delete restrict,
  foreign key (owner_id, selected_person_id)
    references public.memory_people(owner_id, id) on delete restrict,
  foreign key (owner_id, selected_identity_id)
    references public.memory_identities(owner_id, id) on delete restrict,
  check ((approval_outcome = 'approved' and delivery_outcome <> 'not_applicable')
    or (approval_outcome <> 'approved' and delivery_outcome = 'not_applicable'))
);

create index memory_decision_cases_owner_recent
  on public.memory_decision_cases(owner_id, occurred_at desc, id desc);

create index memory_decision_cases_rule_recent
  on public.memory_decision_cases(owner_id, rule_id, occurred_at desc, id desc);

create index memory_decision_cases_person_recent
  on public.memory_decision_cases(owner_id, selected_person_id, occurred_at desc, id desc)
  where selected_person_id is not null;

create index memory_decision_cases_identity_recent
  on public.memory_decision_cases(owner_id, selected_identity_id, occurred_at desc, id desc)
  where selected_identity_id is not null;

create index memory_decision_cases_connection_recent
  on public.memory_decision_cases(owner_id, action_connection_id, occurred_at desc, id desc)
  where action_connection_id is not null;

create index memory_decision_cases_approval_decision
  on public.memory_decision_cases(approval_decision_id)
  where approval_decision_id is not null;

create table public.memory_message_examples (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  decision_case_id uuid not null,
  connection_id uuid references public.connections(id) on delete set null,
  person_id uuid,
  identity_id uuid,
  channel text not null check (channel in ('gmail', 'telegram', 'slack', 'discord', 'custom')),
  language text check (language is null or char_length(language) between 2 and 40),
  source_kind text not null check (source_kind in ('approved_action', 'approved_correction', 'imported_sent', 'explicit')),
  eligibility text not null default 'pending_delivery'
    check (eligibility in ('pending_delivery', 'positive', 'intent_only', 'negative', 'excluded')),
  encrypted_payload text not null check (char_length(encrypted_payload) between 1 and 100000),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  style_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(style_metadata) = 'object'),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (owner_id, id),
  unique (decision_case_id),
  foreign key (owner_id, decision_case_id)
    references public.memory_decision_cases(owner_id, id) on delete cascade,
  foreign key (owner_id, person_id)
    references public.memory_people(owner_id, id) on delete restrict,
  foreign key (owner_id, identity_id)
    references public.memory_identities(owner_id, id) on delete restrict
);

create index memory_message_examples_connection_recent
  on public.memory_message_examples(owner_id, connection_id, eligibility, occurred_at desc, id desc)
  where deleted_at is null;

create index memory_message_examples_person_recent
  on public.memory_message_examples(owner_id, person_id, eligibility, occurred_at desc, id desc)
  where person_id is not null and deleted_at is null;

create index memory_message_examples_identity_recent
  on public.memory_message_examples(owner_id, identity_id, eligibility, occurred_at desc, id desc)
  where identity_id is not null and deleted_at is null;

create table public.memory_preferences (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid,
  identity_id uuid,
  connection_id uuid references public.connections(id) on delete set null,
  preference_key text not null check (char_length(preference_key) between 1 and 160),
  encrypted_value text not null check (char_length(encrypted_value) between 1 and 20000),
  source_kind text not null check (source_kind in ('explicit', 'observed', 'corrected')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (owner_id, id),
  foreign key (owner_id, person_id)
    references public.memory_people(owner_id, id) on delete restrict,
  foreign key (owner_id, identity_id)
    references public.memory_identities(owner_id, id) on delete restrict,
  check (valid_until is null or valid_until > valid_from)
);

create unique index memory_preferences_active_key
  on public.memory_preferences(
    owner_id,
    coalesce(person_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(identity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid),
    preference_key
  ) where deleted_at is null and valid_until is null;

create index memory_preferences_owner_active
  on public.memory_preferences(owner_id, updated_at desc, id)
  where deleted_at is null and valid_until is null;

create index memory_preferences_person
  on public.memory_preferences(owner_id, person_id, updated_at desc)
  where person_id is not null and deleted_at is null and valid_until is null;

create index memory_preferences_identity
  on public.memory_preferences(owner_id, identity_id, updated_at desc)
  where identity_id is not null and deleted_at is null and valid_until is null;

create index memory_preferences_connection
  on public.memory_preferences(owner_id, connection_id, updated_at desc)
  where connection_id is not null and deleted_at is null and valid_until is null;

create table public.memory_graph_refs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid,
  identity_id uuid,
  decision_case_id uuid,
  message_example_id uuid,
  preference_id uuid,
  graph_kind text not null check (graph_kind in ('node', 'edge', 'episode')),
  graph_uuid text not null check (char_length(graph_uuid) between 1 and 160),
  ontology_version smallint not null default 1 check (ontology_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, graph_uuid),
  foreign key (owner_id, person_id)
    references public.memory_people(owner_id, id) on delete cascade,
  foreign key (owner_id, identity_id)
    references public.memory_identities(owner_id, id) on delete cascade,
  foreign key (owner_id, decision_case_id)
    references public.memory_decision_cases(owner_id, id) on delete cascade,
  foreign key (owner_id, message_example_id)
    references public.memory_message_examples(owner_id, id) on delete cascade,
  foreign key (owner_id, preference_id)
    references public.memory_preferences(owner_id, id) on delete cascade,
  check (num_nonnulls(person_id, identity_id, decision_case_id, message_example_id, preference_id) = 1)
);

create unique index memory_graph_refs_person
  on public.memory_graph_refs(owner_id, person_id, graph_kind)
  where person_id is not null;

create unique index memory_graph_refs_identity
  on public.memory_graph_refs(owner_id, identity_id, graph_kind)
  where identity_id is not null;

create unique index memory_graph_refs_decision
  on public.memory_graph_refs(owner_id, decision_case_id, graph_kind)
  where decision_case_id is not null;

create unique index memory_graph_refs_example
  on public.memory_graph_refs(owner_id, message_example_id, graph_kind)
  where message_example_id is not null;

create unique index memory_graph_refs_preference
  on public.memory_graph_refs(owner_id, preference_id, graph_kind)
  where preference_id is not null;

create table public.memory_import_cursors (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  import_kind text not null check (import_kind in ('sent_messages', 'dialog_messages')),
  scope_hash text not null check (scope_hash ~ '^[0-9a-f]{64}$'),
  encrypted_scope text not null check (char_length(encrypted_scope) between 1 and 20000),
  encrypted_cursor text,
  status text not null default 'idle' check (status in ('idle', 'running', 'paused', 'failed', 'completed')),
  attempts smallint not null default 0 check (attempts between 0 and 100),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  leased_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, connection_id, import_kind, scope_hash),
  foreign key (owner_id, connection_id)
    references public.connections(owner_id, id) on delete cascade,
  check ((lease_token is null) = (leased_until is null))
);

create index memory_import_cursors_due
  on public.memory_import_cursors(next_attempt_at, id)
  where status in ('idle', 'running', 'failed');

create index memory_import_cursors_owner
  on public.memory_import_cursors(owner_id, connection_id, updated_at desc);

create table public.memory_outbox (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  aggregate_type text not null check (aggregate_type in ('decision', 'person', 'identity', 'message', 'preference', 'user')),
  aggregate_id uuid not null,
  event_type text not null check (char_length(event_type) between 1 and 120),
  ontology_version smallint not null default 1 check (ontology_version > 0),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 300),
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'dead_letter')),
  attempts smallint not null default 0 check (attempts between 0 and 100),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  leased_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, dedupe_key),
  check ((lease_token is null) = (leased_until is null)),
  check ((status = 'completed') = (processed_at is not null))
);

create index memory_outbox_claim_queue
  on public.memory_outbox(next_attempt_at, created_at, id)
  where status in ('pending', 'processing');

create index memory_outbox_owner_history
  on public.memory_outbox(owner_id, created_at desc, id desc);

alter table public.memory_people enable row level security;
alter table public.memory_identities enable row level security;
alter table public.memory_decision_cases enable row level security;
alter table public.memory_message_examples enable row level security;
alter table public.memory_preferences enable row level security;
alter table public.memory_graph_refs enable row level security;
alter table public.memory_import_cursors enable row level security;
alter table public.memory_outbox enable row level security;

revoke all on public.memory_people, public.memory_identities, public.memory_decision_cases,
  public.memory_message_examples, public.memory_preferences, public.memory_graph_refs,
  public.memory_import_cursors, public.memory_outbox from anon, authenticated;

create or replace function public.record_ping_memory_decision(
  p_request_id uuid,
  p_outcome text,
  p_decided_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  event public.ping_rule_events;
  rule public.ping_rules;
  decision_id uuid;
  approval_decision uuid;
  message_id uuid;
  action_provider text;
  personalization_enabled boolean;
begin
  if p_outcome not in ('approved', 'rejected', 'expired', 'cancelled') then
    raise exception 'invalid_memory_outcome' using errcode = 'P0001';
  end if;

  select * into event
  from public.ping_rule_events
  where approval_request_id = p_request_id
  for update;
  if event.id is null or event.encrypted_source_payload is null then return null; end if;

  select * into rule from public.ping_rules
  where id = event.rule_id and owner_id = event.owner_id;
  if rule.id is null then return null; end if;

  select id into approval_decision from public.approval_decisions
  where request_id = p_request_id;

  insert into public.memory_decision_cases(
    owner_id, rule_id, event_id, approval_request_id, approval_decision_id,
    action_connection_id, action_capability_id, encrypted_situation_payload,
    approval_outcome, delivery_outcome, occurred_at, decided_at
  ) values (
    event.owner_id, event.rule_id, event.id, p_request_id, approval_decision,
    rule.action_connection_id, rule.action_capability_id, event.encrypted_source_payload,
    p_outcome, case when p_outcome = 'approved' then 'pending' else 'not_applicable' end,
    event.occurred_at, p_decided_at
  )
  on conflict (approval_request_id) do nothing
  returning id into decision_id;

  if decision_id is null then
    select id into decision_id from public.memory_decision_cases
    where approval_request_id = p_request_id;
  end if;

  if p_outcome in ('approved', 'rejected') then
    insert into public.memory_outbox(
      owner_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key
    ) values (
      event.owner_id, 'decision', decision_id, 'decision.' || p_outcome,
      jsonb_build_object('decision_case_id', decision_id, 'outcome', p_outcome),
      'decision:' || decision_id::text || ':' || p_outcome
    ) on conflict (owner_id, dedupe_key) do nothing;
  end if;

  if p_outcome = 'approved'
    and rule.action_connection_id is not null
    and rule.action_capability_id is not null
    and event.encrypted_action_payload is not null
    and (
      rule.action_capability_id like '%:rest:gmail.send_reply'
      or rule.action_capability_id like '%:rest:gmail.send_message'
      or rule.action_capability_id like '%:rest:telegram.send_text'
      or rule.action_capability_id like '%:rest:telegram.bot_send_text'
    ) then
    select provider into action_provider from public.connections
    where id = rule.action_connection_id and owner_id = event.owner_id;
    select coalesce(settings.personalization_enabled, true) into personalization_enabled
    from public.ai_settings settings where settings.owner_id = event.owner_id;

    if coalesce(personalization_enabled, true) then
      insert into public.memory_message_examples(
        owner_id, decision_case_id, connection_id, channel, source_kind,
        encrypted_payload, payload_hash, occurred_at
      ) values (
        event.owner_id, decision_id, rule.action_connection_id,
        case action_provider when 'gmail' then 'gmail' when 'telegram' then 'telegram' else 'custom' end,
        case when event.encrypted_revision_payload is null then 'approved_action' else 'approved_correction' end,
        coalesce(event.encrypted_revision_payload, event.encrypted_action_payload),
        event.action_payload_hash, event.occurred_at
      )
      on conflict (decision_case_id) do nothing
      returning id into message_id;
    end if;
  end if;

  if p_outcome = 'cancelled' then
    update public.memory_decision_cases
    set delivery_outcome = 'superseded', updated_at = now()
    where id = decision_id and approval_outcome = 'approved' and delivery_outcome = 'pending';
    update public.memory_message_examples
    set eligibility = 'intent_only', updated_at = now()
    where decision_case_id = decision_id and eligibility = 'pending_delivery';
  end if;

  return decision_id;
end;
$$;

create or replace function public.sync_ping_event_approval_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'approved' then
    update public.ping_rule_events set status = 'approved', updated_at = now()
    where approval_request_id = new.id and status = 'pending_approval';
  elsif new.status in ('rejected', 'expired', 'cancelled') then
    update public.ping_rule_events
    set status = case new.status when 'rejected' then 'rejected' when 'expired' then 'expired' else 'superseded' end,
        resolved_at = now(), lease_token = null, leased_until = null, updated_at = now()
    where approval_request_id = new.id and status in ('pending_approval', 'approved');
  end if;

  if new.status in ('approved', 'rejected', 'expired', 'cancelled') then
    perform public.record_ping_memory_decision(new.id, new.status, coalesce(new.decided_at, now()));
  end if;
  return new;
end;
$$;

create or replace function public.complete_ping_action(
  p_event_id uuid,
  p_lease_token uuid,
  p_delivered boolean,
  p_retryable boolean,
  p_ambiguous boolean,
  p_superseded boolean,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_rule uuid;
  event_owner uuid;
  final_status text;
  decision_id uuid;
begin
  update public.ping_rule_events
  set status = case
        when p_delivered then 'delivered'
        when p_superseded then 'superseded'
        when p_ambiguous then 'ambiguous'
        when p_retryable and attempts < 3 then 'approved'
        else 'failed'
      end,
      resolved_at = case when p_delivered or p_superseded or p_ambiguous or attempts >= 3 or not p_retryable then now() else null end,
      next_attempt_at = case attempts when 1 then now() + interval '5 seconds' else now() + interval '30 seconds' end,
      last_error = case when p_delivered then null else left(coalesce(p_error, 'Delivery failed'), 500) end,
      lease_token = null, leased_until = null, updated_at = now()
  where id = p_event_id and status = 'delivering' and lease_token = p_lease_token
  returning rule_id, owner_id, status into event_rule, event_owner, final_status;
  if not found then return false; end if;

  if final_status in ('delivered', 'failed', 'ambiguous', 'superseded') then
    update public.memory_decision_cases
    set delivery_outcome = final_status,
        delivered_at = case when final_status = 'delivered' then now() else null end,
        updated_at = now()
    where event_id = p_event_id and owner_id = event_owner and approval_outcome = 'approved'
    returning id into decision_id;

    if decision_id is not null then
      update public.memory_message_examples
      set eligibility = case when final_status = 'delivered' then 'positive' else 'intent_only' end,
          updated_at = now()
      where decision_case_id = decision_id and eligibility = 'pending_delivery';

      insert into public.memory_outbox(
        owner_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key
      ) values (
        event_owner, 'decision', decision_id, 'delivery.' || final_status,
        jsonb_build_object('decision_case_id', decision_id, 'outcome', final_status),
        'delivery:' || decision_id::text || ':' || final_status
      ) on conflict (owner_id, dedupe_key) do nothing;
    end if;
  end if;

  if p_ambiguous or (not p_delivered and not p_superseded and (
    not p_retryable or (select attempts >= 3 from public.ping_rule_events where id = p_event_id)
  )) then
    update public.ping_rules set status = 'needs_attention', revision = revision + 1, updated_at = now()
    where id = event_rule and status = 'active';
  end if;
  return true;
end;
$$;

create or replace function public.revise_ping_rule_reply(
  p_owner_id uuid,
  p_request_id uuid,
  p_expected_hash text,
  p_new_hash text,
  p_encrypted_draft_payload text,
  p_encrypted_action_payload text,
  p_memory_content text,
  p_memory_source jsonb
)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.approval_requests;
  event public.ping_rule_events;
begin
  if p_expected_hash !~ '^[0-9a-f]{64}$'
    or p_new_hash !~ '^[0-9a-f]{64}$'
    or p_encrypted_draft_payload = ''
    or p_encrypted_action_payload = ''
    or char_length(p_memory_content) not between 1 and 12000
    or jsonb_typeof(p_memory_source) <> 'object' then
    raise exception 'invalid_reply_revision' using errcode = 'P0001';
  end if;

  select * into request from public.approval_requests
  where id = p_request_id and owner_id = p_owner_id for update;
  if request.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if request.status <> 'pending' then raise exception 'request_already_resolved' using errcode = 'P0001'; end if;
  if request.expires_at <= now() then raise exception 'request_expired' using errcode = 'P0001'; end if;

  select * into event from public.ping_rule_events
  where owner_id = p_owner_id and approval_request_id = request.id for update;
  if event.id is null or event.status <> 'pending_approval' then raise exception 'reply_not_editable' using errcode = 'P0001'; end if;
  if request.payload_hash = p_new_hash and event.action_payload_hash = p_new_hash then return request; end if;
  if request.payload_hash <> p_expected_hash or event.action_payload_hash <> p_expected_hash then
    raise exception 'payload_changed' using errcode = 'P0001';
  end if;

  update public.approval_requests
  set payload_hash = p_new_hash,
      action_payload = jsonb_set(action_payload, '{action_hash}', to_jsonb(p_new_hash), true)
  where id = request.id returning * into request;

  update public.ping_rule_events
  set encrypted_draft_payload = p_encrypted_draft_payload,
      encrypted_action_payload = p_encrypted_action_payload,
      encrypted_revision_payload = p_memory_content,
      action_payload_hash = p_new_hash,
      updated_at = now()
  where id = event.id;
  return request;
end;
$$;

do $$
declare
  existing record;
begin
  for existing in
    select requests.id,
      coalesce(decisions.outcome, requests.status) as outcome,
      coalesce(requests.decided_at, decisions.decided_at, requests.created_at) as decided_at
    from public.approval_requests requests
    join public.ping_rule_events events on events.approval_request_id = requests.id
    left join public.approval_decisions decisions on decisions.request_id = requests.id
    where requests.status in ('approved', 'rejected', 'expired', 'cancelled')
      and events.encrypted_source_payload is not null
  loop
    perform public.record_ping_memory_decision(existing.id, existing.outcome, existing.decided_at);
  end loop;
end;
$$;

update public.memory_decision_cases cases
set delivery_outcome = events.status,
    delivered_at = case when events.status = 'delivered' then events.resolved_at else null end,
    updated_at = now()
from public.ping_rule_events events
where cases.event_id = events.id
  and cases.approval_outcome = 'approved'
  and events.status in ('delivered', 'failed', 'ambiguous', 'superseded');

update public.memory_message_examples examples
set eligibility = case when cases.delivery_outcome = 'delivered' then 'positive' else 'intent_only' end,
    updated_at = now()
from public.memory_decision_cases cases
where examples.decision_case_id = cases.id
  and cases.delivery_outcome in ('delivered', 'failed', 'ambiguous', 'superseded');

insert into public.memory_outbox(
  owner_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key
)
select cases.owner_id, 'decision', cases.id, 'delivery.' || cases.delivery_outcome,
  jsonb_build_object('decision_case_id', cases.id, 'outcome', cases.delivery_outcome),
  'delivery:' || cases.id::text || ':' || cases.delivery_outcome
from public.memory_decision_cases cases
where cases.approval_outcome = 'approved'
  and cases.delivery_outcome in ('delivered', 'failed', 'ambiguous', 'superseded')
on conflict (owner_id, dedupe_key) do nothing;

revoke all on function public.record_ping_memory_decision(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.sync_ping_event_approval_status() from public, anon, authenticated;
revoke all on function public.complete_ping_action(uuid, uuid, boolean, boolean, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.revise_ping_rule_reply(uuid, uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.record_ping_memory_decision(uuid, text, timestamptz) to service_role;
grant execute on function public.complete_ping_action(uuid, uuid, boolean, boolean, boolean, boolean, text) to service_role;
grant execute on function public.revise_ping_rule_reply(uuid, uuid, text, text, text, text, text, jsonb) to service_role;

commit;
