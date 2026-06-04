drop function if exists public.undo_audit_log(integer);
drop function if exists public.undo_audit_log(bigint);

create or replace function public.undo_audit_log(p_log_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log public.audit_logs%rowtype;
  v_table_oid oid;
  v_table_schema text := 'public';
  v_table_name text;
  v_pk_column text;
  v_set_clause text;
  v_insert_columns text;
  v_insert_values text;
  v_actor_email text;
begin
  if not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and rol = 'super_admin'
  ) then
    raise exception 'Solo un super admin puede deshacer movimientos de auditoria.';
  end if;

  select *
  into v_log
  from public.audit_logs
  where id = p_log_id
  for update;

  if not found then
    raise exception 'No se encontro el movimiento de auditoria %.', p_log_id;
  end if;

  if v_log.undone_at is not null then
    raise exception 'Este movimiento ya fue deshecho.';
  end if;

  v_table_name := v_log.table_name;
  v_table_oid := to_regclass(format('%I.%I', v_table_schema, v_table_name));

  if v_table_oid is null then
    raise exception 'No se encontro la tabla %.%.', v_table_schema, v_table_name;
  end if;

  select a.attname
  into v_pk_column
  from pg_index i
  join pg_attribute a
    on a.attrelid = i.indrelid
   and a.attnum = any(i.indkey)
  where i.indrelid = v_table_oid
    and i.indisprimary
  order by array_position(i.indkey, a.attnum)
  limit 1;

  if v_pk_column is null then
    select a.attname
    into v_pk_column
    from pg_attribute a
    where a.attrelid = v_table_oid
      and a.attname = 'id'
      and not a.attisdropped
    limit 1;
  end if;

  if v_pk_column is null or v_log.record_id is null then
    raise exception 'No se pudo identificar el registro a deshacer.';
  end if;

  select email
  into v_actor_email
  from auth.users
  where id = auth.uid();

  if v_log.action = 'UPDATE' then
    if v_log.before_data is null then
      raise exception 'El movimiento no tiene datos anteriores para restaurar.';
    end if;

    select string_agg(format('%1$I = source.%1$I', a.attname), ', ')
    into v_set_clause
    from pg_attribute a
    where a.attrelid = v_table_oid
      and a.attnum > 0
      and not a.attisdropped
      and a.attname <> v_pk_column
      and a.attgenerated = ''
      and a.attidentity = ''
      and v_log.before_data ? a.attname;

    if v_set_clause is null then
      raise exception 'No hay columnas editables para restaurar en %.%.', v_table_schema, v_table_name;
    end if;

    execute format(
      'update %I.%I as target
       set %s
       from jsonb_populate_record(null::%I.%I, $1) as source
       where target.%I::text = $2',
      v_table_schema,
      v_table_name,
      v_set_clause,
      v_table_schema,
      v_table_name,
      v_pk_column
    )
    using v_log.before_data, v_log.record_id;

  elsif v_log.action = 'INSERT' then
    execute format(
      'delete from %I.%I where %I::text = $1',
      v_table_schema,
      v_table_name,
      v_pk_column
    )
    using v_log.record_id;

  elsif v_log.action = 'DELETE' then
    if v_log.before_data is null then
      raise exception 'El movimiento no tiene datos eliminados para recuperar.';
    end if;

    select
      string_agg(format('%I', a.attname), ', '),
      string_agg(format('source.%I', a.attname), ', ')
    into v_insert_columns, v_insert_values
    from pg_attribute a
    where a.attrelid = v_table_oid
      and a.attnum > 0
      and not a.attisdropped
      and a.attgenerated = ''
      and v_log.before_data ? a.attname;

    if v_insert_columns is null then
      raise exception 'No hay columnas para recuperar en %.%.', v_table_schema, v_table_name;
    end if;

    execute format(
      'insert into %I.%I (%s)
       overriding system value
       select %s
       from jsonb_populate_record(null::%I.%I, $1) as source',
      v_table_schema,
      v_table_name,
      v_insert_columns,
      v_insert_values,
      v_table_schema,
      v_table_name
    )
    using v_log.before_data;

  else
    raise exception 'Accion de auditoria no soportada: %.', v_log.action;
  end if;

  update public.audit_logs
  set undone_at = now(),
      undone_by = auth.uid()
  where id = p_log_id;

  insert into public.audit_logs (
    table_name,
    action,
    record_id,
    actor_user_id,
    actor_email,
    before_data,
    after_data
  )
  values (
    'admin_events',
    'INSERT',
    p_log_id::text,
    auth.uid(),
    coalesce(v_actor_email, auth.uid()::text),
    null,
    jsonb_build_object(
      'event_type', 'undo_audit_log',
      'undone_log_id', v_log.id,
      'original_actor_email', v_log.actor_email,
      'original_action', v_log.action,
      'original_table_name', v_log.table_name,
      'original_record_id', v_log.record_id,
      'original_before_data', v_log.before_data,
      'original_after_data', v_log.after_data
    )
  );
end;
$$;
