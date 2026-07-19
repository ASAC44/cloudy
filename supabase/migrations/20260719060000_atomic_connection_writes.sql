create or replace function public.create_connection_with_secret(
  p_owner_id uuid,
  p_name text,
  p_provider text,
  p_protocol text,
  p_endpoint_url text,
  p_auth_type text,
  p_encrypted_payload text
)
returns public.connections
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.connections;
begin
  insert into public.connections(owner_id, name, provider, protocol, endpoint_url, auth_type)
  values (p_owner_id, p_name, p_provider, p_protocol, p_endpoint_url, p_auth_type)
  returning * into saved;

  insert into public.connection_secrets(connection_id, encrypted_payload)
  values (saved.id, p_encrypted_payload);

  return saved;
end;
$$;

create or replace function public.update_connection_with_secret(
  p_owner_id uuid,
  p_connection_id uuid,
  p_name text,
  p_endpoint_url text,
  p_auth_type text,
  p_encrypted_payload text
)
returns setof public.connections
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.connections;
begin
  select * into saved
  from public.connections
  where id = p_connection_id and owner_id = p_owner_id
  for update;

  if saved.id is null then return; end if;

  if p_encrypted_payload is not null then
    update public.connection_secrets
    set encrypted_payload = p_encrypted_payload, updated_at = now()
    where connection_id = saved.id;
    if not found then raise exception 'connection_secret_not_found' using errcode = 'P0001'; end if;
  end if;

  update public.connections
  set name = coalesce(p_name, name),
      endpoint_url = coalesce(p_endpoint_url, endpoint_url),
      auth_type = coalesce(p_auth_type, auth_type),
      status = 'untested',
      account_label = null,
      last_error = null,
      updated_at = now()
  where id = saved.id
  returning * into saved;

  return next saved;
  return;
end;
$$;

create or replace function public.set_connection_test_result(
  p_owner_id uuid,
  p_connection_id uuid,
  p_status text,
  p_account_label text,
  p_last_error text,
  p_encrypted_payload text
)
returns setof public.connections
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.connections;
begin
  select * into saved
  from public.connections
  where id = p_connection_id and owner_id = p_owner_id
  for update;

  if saved.id is null then return; end if;

  if p_encrypted_payload is not null then
    update public.connection_secrets
    set encrypted_payload = p_encrypted_payload, updated_at = now()
    where connection_id = saved.id;
    if not found then raise exception 'connection_secret_not_found' using errcode = 'P0001'; end if;
  end if;

  update public.connections
  set status = p_status,
      account_label = p_account_label,
      last_error = p_last_error,
      last_tested_at = now(),
      updated_at = now()
  where id = saved.id
  returning * into saved;

  return next saved;
  return;
end;
$$;

revoke all on function public.create_connection_with_secret(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.update_connection_with_secret(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.set_connection_test_result(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_connection_with_secret(uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.update_connection_with_secret(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.set_connection_test_result(uuid, uuid, text, text, text, text) to service_role;
