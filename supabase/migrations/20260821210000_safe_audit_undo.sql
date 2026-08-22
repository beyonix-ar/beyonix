-- Endurece undo_audit_log en tres frentes, sin cambiar su firma ni el
-- contrato que ya usa el frontend (RPC undo_audit_log(p_log_id)):
--
-- 1. Lista blanca de tablas/campos reversibles server-side. Hasta ahora la
--    única barrera contra deshacer pagos, tracking o perfiles vivía en el
--    frontend (audit-helpers.ts); un super_admin que llamara al RPC
--    directamente no tenía ningún freno del lado del servidor.
-- 2. Detección de conflicto: antes de restaurar un UPDATE, verifica que la
--    fila no haya cambiado de nuevo después del evento que se quiere
--    deshacer. Si cambió, aborta en vez de pisar el cambio posterior.
-- 3. Ajustes manuales de stock (producto_variantes.stock, siempre marcados
--    con stock_adjustment_delta por adjust_variant_stock_idempotent) dejan
--    de estar bloqueados por completo: en vez de reescribir la columna
--    derivada directamente (prohibido por guard_derived_inventory_stock),
--    la reversión aplica el delta inverso sobre el stock ACTUAL llamando a
--    la misma función idempotente que usa un ajuste manual normal. Esto
--    compone correctamente con ventas o compras posteriores en vez de
--    pisarlas con una foto vieja.

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
  v_conflict_clause text;
  v_conflict_ok boolean;
  v_insert_columns text;
  v_insert_values text;
  v_actor_email text;
  v_actor_id uuid := auth.uid();
  v_child_log public.audit_logs%rowtype;
  v_child_table_oid oid;
  v_child_insert_columns text;
  v_child_insert_values text;
  v_variant public.producto_variantes%rowtype;
  v_original_delta integer;
  v_new_quantity integer;
  v_echo_log_id bigint;
begin
  if not exists (
    select 1
    from public.profiles
    where id = v_actor_id
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

  if v_log.table_name = 'admin_events' then
    raise exception 'Este evento no representa un cambio de datos y no se puede deshacer.';
  end if;

  -- Lista blanca server-side: espejo de reversibleTables en audit-helpers.ts.
  -- Nunca confiar solamente en el frontend para esta decisión.
  if v_log.table_name not in (
    'banners', 'categorias', 'configuracion_visual', 'hero_banners',
    'imagenes_producto', 'metodos_envio', 'metodos_pago', 'payment_methods',
    'producto_especificaciones', 'producto_variantes', 'productos',
    'shipping_methods', 'site_settings', 'store_settings'
  ) then
    raise exception 'Esta accion no tiene una reversion automatica segura.';
  end if;

  -- Ningun campo de pago, tracking o MercadoPago se revierte
  -- automaticamente, sin importar en que tabla haya quedado registrado.
  if exists (
    select 1
    from jsonb_object_keys(coalesce(v_log.after_data, '{}'::jsonb) || coalesce(v_log.before_data, '{}'::jsonb)) as k
    where k ilike '%payment%' or k ilike '%tracking%' or k ilike '%mercadopago%'
  ) then
    raise exception 'Este cambio incluye datos de pago o envio y no se revierte automaticamente.';
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
  where id = v_actor_id;

  -- Ajuste manual de stock: nunca se reescribe producto_variantes.stock
  -- directamente (columna derivada). Se aplica el delta inverso sobre el
  -- stock actual con la misma función idempotente que un ajuste manual
  -- normal, lo que preserva ventas/compras/devoluciones ocurridas después.
  if v_table_name = 'producto_variantes'
     and v_log.action = 'UPDATE'
     and v_log.after_data ? 'stock_adjustment_delta' then

    select *
    into v_variant
    from public.producto_variantes
    where id = (v_log.record_id)::bigint
    for update;

    if not found then
      raise exception 'La variante ya no existe.';
    end if;

    v_original_delta := (v_log.after_data->>'stock_adjustment_delta')::integer;
    v_new_quantity := coalesce(v_variant.stock, 0) - v_original_delta;

    if v_new_quantity < 0 then
      raise exception 'No se puede deshacer: el stock actual ya no alcanza para revertir este ajuste (se movieron unidades después).';
    end if;

    perform public.adjust_variant_stock_idempotent(
      v_variant.id,
      v_new_quantity,
      left('Revertido: ' || coalesce(nullif(btrim(v_log.after_data->>'stock_adjustment_reason'), ''), 'ajuste de stock'), 300),
      v_actor_id,
      'undo:' || p_log_id::text
    );

    -- El "eco" de recalculo agregado (productos.stock) de este mismo ajuste
    -- ya se regenero solo dentro de la llamada anterior; sólo se marca el
    -- registro viejo como deshecho para que no vuelva a ofrecerse.
    select id
    into v_echo_log_id
    from public.audit_logs
    where table_name = 'productos'
      and action = 'UPDATE'
      and record_id = v_variant.producto_id::text
      and actor_email is not distinct from v_log.actor_email
      and undone_at is null
      and created_at >= v_log.created_at
      and created_at <= v_log.created_at + interval '5 seconds'
    order by created_at asc
    limit 1;

    if v_echo_log_id is not null then
      update public.audit_logs
      set undone_at = now(), undone_by = v_actor_id
      where id = v_echo_log_id;
    end if;

  elsif v_log.action = 'UPDATE' then
    if v_log.before_data is null then
      raise exception 'El movimiento no tiene datos anteriores para restaurar.';
    end if;

    -- before_data/after_data son la foto COMPLETA de la fila en cada evento
    -- (no un diff), así que sólo se restauran y verifican las columnas que
    -- realmente cambiaron en ESTE evento (before <> after). Restaurar toda
    -- la fila a ciegas pisaría columnas que un evento posterior modificó
    -- sin que este evento las haya tocado nunca.
    --
    -- Ningún ajuste de stock "crudo" (sin stock_adjustment_delta, es decir
    -- un recalculo automático por venta/compra/devolución) es reversible:
    -- no hay un "motivo" que invertir y guard_derived_inventory_stock
    -- rechazaría de todos modos una escritura directa sobre la columna.
    if v_table_name in ('productos', 'producto_variantes')
       and (v_log.before_data->>'stock') is distinct from (v_log.after_data->>'stock') then
      raise exception 'Este cambio de stock fue generado automáticamente (venta, compra o devolución) y no se puede deshacer desde acá.';
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
      and v_log.before_data ? a.attname
      and (v_log.before_data->>a.attname) is distinct from (v_log.after_data->>a.attname);

    if v_set_clause is null then
      raise exception 'No hay columnas que hayan cambiado para restaurar en %.%.', v_table_schema, v_table_name;
    end if;

    -- Detección de conflicto: si alguna de las columnas que cambiaron en
    -- este evento ya no coincide con lo que quedó registrado como su valor
    -- "después", algo la modificó de nuevo más tarde. Se aborta en vez de
    -- pisar ese cambio posterior con una foto vieja.
    select string_agg(format('target.%1$I is not distinct from expected.%1$I', a.attname), ' and ')
    into v_conflict_clause
    from pg_attribute a
    where a.attrelid = v_table_oid
      and a.attnum > 0
      and not a.attisdropped
      and a.attname <> v_pk_column
      and a.attgenerated = ''
      and a.attidentity = ''
      and v_log.before_data ? a.attname
      and (v_log.before_data->>a.attname) is distinct from (v_log.after_data->>a.attname);

    execute format(
      'select exists (
         select 1
         from %I.%I as target
         join jsonb_populate_record(null::%I.%I, $2) as expected on true
         where target.%I::text = $1
           and (%s)
       )',
      v_table_schema,
      v_table_name,
      v_table_schema,
      v_table_name,
      v_pk_column,
      v_conflict_clause
    )
    using v_log.record_id, coalesce(v_log.after_data, '{}'::jsonb)
    into v_conflict_ok;

    if not coalesce(v_conflict_ok, false) then
      raise exception 'No se puede deshacer: este registro fue modificado de nuevo después de este cambio.';
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

    if v_table_name = 'productos' then
      for v_child_log in
        select *
        from public.audit_logs
        where action = 'DELETE'
          and table_name in (
            'imagenes_producto',
            'producto_especificaciones',
            'producto_variantes'
          )
          and before_data ->> 'producto_id' = v_log.record_id
          and undone_at is null
          and created_at <= v_log.created_at
          and created_at >= v_log.created_at - interval '10 minutes'
        order by
          case table_name
            when 'producto_variantes' then 1
            when 'imagenes_producto' then 2
            when 'producto_especificaciones' then 3
            else 4
          end,
          id
      loop
        v_child_table_oid := to_regclass(format('%I.%I', v_table_schema, v_child_log.table_name));

        if v_child_table_oid is null then
          continue;
        end if;

        select
          string_agg(format('%I', a.attname), ', '),
          string_agg(format('source.%I', a.attname), ', ')
        into v_child_insert_columns, v_child_insert_values
        from pg_attribute a
        where a.attrelid = v_child_table_oid
          and a.attnum > 0
          and not a.attisdropped
          and a.attgenerated = ''
          and v_child_log.before_data ? a.attname;

        if v_child_insert_columns is null then
          continue;
        end if;

        execute format(
          'insert into %I.%I (%s)
           overriding system value
           select %s
           from jsonb_populate_record(null::%I.%I, $1) as source
           on conflict do nothing',
          v_table_schema,
          v_child_log.table_name,
          v_child_insert_columns,
          v_child_insert_values,
          v_table_schema,
          v_child_log.table_name
        )
        using v_child_log.before_data;

        update public.audit_logs
        set undone_at = now(),
            undone_by = v_actor_id
        where id = v_child_log.id;
      end loop;
    end if;

  else
    raise exception 'Accion de auditoria no soportada: %.', v_log.action;
  end if;

  update public.audit_logs
  set undone_at = now(),
      undone_by = v_actor_id
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
    v_actor_id,
    coalesce(v_actor_email, v_actor_id::text),
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
exception
  when foreign_key_violation then
    raise exception 'No se puede deshacer: otros registros dependen de este dato ahora.';
  when unique_violation then
    raise exception 'No se puede deshacer: el valor anterior ya está en uso por otro registro.';
end;
$$;
