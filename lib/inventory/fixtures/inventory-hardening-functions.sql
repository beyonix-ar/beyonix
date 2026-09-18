-- RPCs REALES de producción (fetchadas via pg_get_functiondef el
-- 2026-09-18, byte a byte salvo normalizar CRLF -> LF), no reimplementadas.
-- No forman parte de las migraciones nuevas de esta fase -- se cargan acá
-- para poder ejercitar contra ellas en PGlite (misma razón que
-- lib/mercadopago/fixtures/refund-without-credit-note.sql para las RPCs de
-- reintegro: aislado del resto de las 1500+ tests para no arriesgar
-- regresión sobre fixtures ya usados en producción).

create or replace function public.decrement_checkout_inventory(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item record;
  v_available integer;
  v_variant_product_id bigint;
  v_offer_product_id bigint;
  v_active boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception
      'No tenés permisos para validar el inventario del checkout.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;

  for v_item in
    select
      item.product_id,
      item.variant_id,
      item.conditioned_stock_id,
      sum(item.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as item(
      product_id bigint,
      variant_id bigint,
      conditioned_stock_id uuid,
      quantity integer
    )
    group by
      item.product_id,
      item.variant_id,
      item.conditioned_stock_id
    order by
      item.product_id,
      item.variant_id nulls first,
      item.conditioned_stock_id nulls first
  loop
    if v_item.product_id is null
       or v_item.product_id <= 0
       or v_item.quantity is null
       or v_item.quantity <= 0
       or (
         v_item.variant_id is not null
         and v_item.conditioned_stock_id is not null
       ) then
      raise exception 'CHECKOUT_ITEMS_INVALID';
    end if;

    perform pg_advisory_xact_lock(93000, v_item.product_id::integer);

    if v_item.conditioned_stock_id is not null then
      select movements.product_id, movements.conditioned_active
      into v_offer_product_id, v_active
      from public.inventory_return_movements movements
      where movements.id = v_item.conditioned_stock_id
      for update;

      if not found
         or v_offer_product_id <> v_item.product_id
         or not coalesce(v_active, false) then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;

      select offers.available_quantity
      into v_available
      from public.conditioned_inventory_offers offers
      where offers.id = v_item.conditioned_stock_id;

      if not found or v_available < v_item.quantity then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;
    elsif v_item.variant_id is not null then
      select
        variants.producto_id,
        coalesce(variants.stock, 0),
        coalesce(variants.activo, false)
      into v_variant_product_id, v_available, v_active
      from public.producto_variantes variants
      where variants.id = v_item.variant_id;

      if not found
         or v_variant_product_id <> v_item.product_id
         or not v_active
         or v_available < v_item.quantity then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;
    else
      if exists (
        select 1
        from public.producto_variantes variants
        where variants.producto_id = v_item.product_id
          and variants.activo
      ) then
        raise exception 'CHECKOUT_VARIANT_REQUIRED';
      end if;

      select coalesce(products.stock, 0), coalesce(products.activo, false)
      into v_available, v_active
      from public.productos products
      where products.id = v_item.product_id;

      if not found or not v_active or v_available < v_item.quantity then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;
    end if;
  end loop;

  return jsonb_build_object('validated', true, 'derived', true);
end;
$function$;

create or replace function public.checkout_reservation_ttl()
returns interval
language sql
immutable parallel safe
as $function$
  select interval '30 minutes';
$function$;

create or replace function public.purge_expired_stock_reservations()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_deleted integer;
begin
  delete from public.stock_reservations reservations
  where reservations.expires_at <= now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

create or replace function public.available_stock_for_session(p_product_id bigint, p_variant_id bigint, p_conditioned_stock_id uuid, p_session_id text)
returns integer
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_stock integer;
  v_reserved_other integer;
begin
  if p_conditioned_stock_id is not null then
    select offers.available_quantity into v_stock
    from public.conditioned_inventory_offers offers
    where offers.id = p_conditioned_stock_id
      and offers.product_id = p_product_id;
  elsif p_variant_id is not null then
    select coalesce(variants.stock, 0) into v_stock
    from public.producto_variantes variants
    where variants.id = p_variant_id
      and variants.producto_id = p_product_id
      and variants.activo;
  else
    select coalesce(products.stock, 0) into v_stock
    from public.productos products
    where products.id = p_product_id and products.activo;
  end if;

  if not found then return null; end if;

  select coalesce(sum(reservations.quantity), 0)::integer
  into v_reserved_other
  from public.stock_reservations reservations
  where reservations.product_id = p_product_id
    and reservations.variant_id is not distinct from p_variant_id
    and reservations.conditioned_stock_id is not distinct from p_conditioned_stock_id
    and reservations.expires_at > now()
    and (p_session_id is null or reservations.session_id is distinct from p_session_id);

  return coalesce(v_stock, 0) - coalesce(v_reserved_other, 0);
end;
$function$;

create or replace function public.validate_checkout_inventory_reservation(p_items jsonb, p_session_id text, p_order_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item record;
  v_product_id bigint;
  v_available integer;
  v_expiry timestamptz := now() + public.checkout_reservation_ttl();
  v_reserved integer := 0;
  v_order_user_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para validar el inventario.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 50
     or p_order_id is null
     or p_order_id <= 0
     or length(btrim(coalesce(p_session_id, ''))) < 8
     or length(p_session_id) > 160 then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where coalesce(nullif(item ->> 'quantity', '')::integer, 0) <= 0
  ) then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;

  select orders.usuario_id into v_order_user_id
  from public.ordenes orders
  where orders.id = p_order_id
  for update;

  if not found then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;

  if exists (
    select 1 from public.stock_reservations reservations
    where reservations.session_id = p_session_id
      and reservations.expires_at > now()
      and reservations.user_id is not null
      and reservations.user_id is distinct from v_order_user_id
  ) then
    raise exception 'RESERVATION_SESSION_MISMATCH';
  end if;

  perform public.purge_expired_stock_reservations();

  for v_product_id in
    select distinct product_id from (
      select nullif(item ->> 'product_id', '')::bigint as product_id
      from jsonb_array_elements(p_items) item
      union
      select reservations.product_id
      from public.stock_reservations reservations
      where reservations.session_id = p_session_id
    ) targets
    order by 1
  loop
    if v_product_id is null then raise exception 'CHECKOUT_ITEMS_INVALID'; end if;
    perform pg_advisory_xact_lock(93000, v_product_id::integer);
  end loop;

  delete from public.stock_reservations reservations
  where reservations.session_id = p_session_id;

  for v_item in
    select
      nullif(item ->> 'product_id', '')::bigint as product_id,
      nullif(item ->> 'variant_id', '')::bigint as variant_id,
      nullif(item ->> 'conditioned_stock_id', '')::uuid as conditioned_stock_id,
      sum(coalesce(nullif(item ->> 'quantity', '')::integer, 0))::integer
        as quantity
    from jsonb_array_elements(p_items) item
    group by 1, 2, 3
    order by 1, 2 nulls first, 3 nulls first
  loop
    if v_item.product_id is null or v_item.quantity is null or v_item.quantity <= 0
       or (v_item.variant_id is not null and v_item.conditioned_stock_id is not null) then
      raise exception 'CHECKOUT_ITEMS_INVALID';
    end if;

    v_available := public.available_stock_for_session(
      v_item.product_id,
      v_item.variant_id,
      v_item.conditioned_stock_id,
      p_session_id
    );

    if v_available is null or v_available < v_item.quantity then
      raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
    end if;

    insert into public.stock_reservations (
      session_id, user_id, product_id, variant_id,
      conditioned_stock_id, quantity, order_id, expires_at
    ) values (
      p_session_id, v_order_user_id, v_item.product_id, v_item.variant_id,
      v_item.conditioned_stock_id, v_item.quantity, p_order_id, v_expiry
    );
    v_reserved := v_reserved + 1;
  end loop;

  perform public.decrement_checkout_inventory(p_items);

  return jsonb_build_object(
    'validated', true,
    'reserved', v_reserved,
    'expires_at', v_expiry
  );
end;
$function$;

create or replace function public.process_order_item_return_inventory(p_order_id bigint, p_order_item_id bigint, p_restocked_quantity integer, p_written_off_quantity integer, p_note text, p_processed_by uuid)
returns orden_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item public.orden_items%rowtype;
begin
  if p_restocked_quantity < 0 or p_written_off_quantity < 0 then
    raise exception
      'Las cantidades de la devolución no pueden ser negativas.';
  end if;
  if p_written_off_quantity > 0
     and length(trim(coalesce(p_note, ''))) < 3 then
    raise exception 'Indicá el motivo de la baja o pérdida.';
  end if;

  select *
  into v_item
  from public.orden_items
  where id = p_order_item_id
    and orden_id = p_order_id
  for update;

  if not found then
    raise exception 'No se encontró el producto dentro del pedido.';
  end if;
  if v_item.return_inventory_processed_at is not null then
    raise exception 'La recepción de este producto ya fue registrada.';
  end if;
  if p_restocked_quantity + p_written_off_quantity > v_item.cantidad then
    raise exception
      'La cantidad recibida no puede superar la cantidad vendida.';
  end if;

  update public.orden_items
  set return_restocked_quantity = p_restocked_quantity,
      return_written_off_quantity = p_written_off_quantity,
      return_inventory_note =
        nullif(left(trim(coalesce(p_note, '')), 1000), ''),
      return_inventory_processed_at = now(),
      return_inventory_processed_by = p_processed_by
  where id = v_item.id
  returning * into v_item;

  if p_restocked_quantity > 0
     and v_item.conditioned_stock_id is null then
    insert into public.inventory_return_movements (
      source_key,
      order_id,
      order_item_id,
      product_id,
      variant_id,
      quantity,
      approved_by,
      approved_at
    )
    values (
      'order-item:' || v_item.id,
      v_item.orden_id,
      v_item.id,
      v_item.producto_id,
      v_item.variante_id,
      p_restocked_quantity,
      p_processed_by,
      v_item.return_inventory_processed_at
    )
    on conflict (source_key) do nothing;
  end if;

  insert into public.order_audit_events (
    order_id,
    actor_type,
    actor_id,
    action,
    metadata
  )
  values (
    p_order_id,
    'admin',
    p_processed_by,
    'return_inventory_processed',
    jsonb_build_object(
      'orderItemId', v_item.id,
      'productId', v_item.producto_id,
      'variantId', v_item.variante_id,
      'conditionedStockId', v_item.conditioned_stock_id,
      'restockedQuantity', p_restocked_quantity,
      'writtenOffQuantity', p_written_off_quantity,
      'sourceOfTruth', 'derived_inventory'
    )
  );

  return v_item;
end;
$function$;

create or replace function public.adjust_variant_stock_idempotent(p_variant_id bigint, p_new_quantity integer, p_reason text, p_actor_id uuid, p_idempotency_key text)
returns producto_variantes
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_variant public.producto_variantes%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_delta integer;
  v_audit_log_id bigint;
begin
  if v_key is null or length(v_key) < 8 or length(v_key) > 240 then
    raise exception 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_new_quantity is null or p_new_quantity < 0 then
    raise exception 'La cantidad no puede ser negativa.';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Indicá un motivo para el ajuste.';
  end if;

  perform pg_advisory_xact_lock(hashtext('inventory-stock-adjustment'), hashtext(v_key));

  if exists (
    select 1 from public.inventory_operation_log log
    where log.idempotency_key = v_key
  ) then
    select * into v_variant
    from public.producto_variantes
    where id = p_variant_id;
    if not found then
      raise exception 'La variante ya no existe.';
    end if;
    return v_variant;
  end if;

  select * into v_variant
  from public.producto_variantes
  where id = p_variant_id
  for update;
  if not found then
    raise exception 'La variante ya no existe.';
  end if;

  perform pg_advisory_xact_lock(93000, v_variant.producto_id::integer);

  v_delta := p_new_quantity - coalesce(v_variant.stock, 0);
  if v_delta = 0 then
    return v_variant;
  end if;

  insert into public.inventory_stock_adjustments (
    product_id, variant_id, quantity_delta, reason, created_by, idempotency_key
  ) values (
    v_variant.producto_id, p_variant_id, v_delta, v_reason, p_actor_id, v_key
  );

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  perform public.refresh_inventory_stock(v_variant.producto_id);

  select id into v_audit_log_id
  from public.audit_logs
  where table_name = 'producto_variantes'
    and record_id = p_variant_id::text
    and action = 'UPDATE'
  order by id desc
  limit 1;

  if v_audit_log_id is not null then
    update public.audit_logs
    set after_data = coalesce(after_data, '{}'::jsonb) || jsonb_build_object(
      'stock_adjustment_reason', v_reason,
      'stock_adjustment_delta', v_delta
    )
    where id = v_audit_log_id;
  end if;

  insert into public.inventory_operation_log (
    product_id, variant_id, movement_type, quantity, origin, effective_at,
    actor_user_id, actor_process, idempotency_key, source_table, source_id,
    document_reference, metadata
  ) values (
    v_variant.producto_id, p_variant_id, 'adjustment', abs(v_delta),
    'admin_stock_adjustment', now(), p_actor_id,
    'adjust_variant_stock_idempotent', v_key, 'inventory_stock_adjustments',
    v_key, v_reason,
    jsonb_build_object(
      'previousStock', coalesce(v_variant.stock, 0),
      'newStock', p_new_quantity,
      'delta', v_delta
    )
  ) on conflict (idempotency_key) do nothing;

  select * into v_variant
  from public.producto_variantes
  where id = p_variant_id;
  return v_variant;
end;
$function$;
