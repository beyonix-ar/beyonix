-- Artefacto temporal de sólo lectura para planificar un reset controlado de
-- datos comerciales de prueba. Se elimina en una migración de seguimiento
-- inmediatamente después de usarse; no debe quedar de forma permanente.

create or replace function public.__beyonix_temp_fk_graph()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'constraint_name', constraint_name,
    'source_table', source_table,
    'source_column', source_column,
    'target_table', target_table,
    'target_column', target_column,
    'delete_rule', delete_rule
  ) order by target_table, source_table), '[]'::jsonb)
  from (
    select
      tc.constraint_name,
      tc.table_name as source_table,
      kcu.column_name as source_column,
      ccu.table_name as target_table,
      ccu.column_name as target_column,
      rc.delete_rule
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.constraint_schema = tc.constraint_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.constraint_schema = tc.constraint_schema
    join information_schema.referential_constraints rc
      on rc.constraint_name = tc.constraint_name
     and rc.constraint_schema = tc.constraint_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = 'public'
  ) fks;
$$;

revoke all on function public.__beyonix_temp_fk_graph() from public, anon, authenticated;
grant execute on function public.__beyonix_temp_fk_graph() to service_role;

create or replace function public.__beyonix_temp_table_counts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table text;
  v_count bigint;
  v_result jsonb := '{}'::jsonb;
begin
  for v_table in
    select tablename
    from pg_tables
    where schemaname = 'public'
    order by tablename
  loop
    execute format('select count(*) from public.%I', v_table) into v_count;
    v_result := v_result || jsonb_build_object(v_table, v_count);
  end loop;
  return v_result;
end;
$$;

revoke all on function public.__beyonix_temp_table_counts() from public, anon, authenticated;
grant execute on function public.__beyonix_temp_table_counts() to service_role;
