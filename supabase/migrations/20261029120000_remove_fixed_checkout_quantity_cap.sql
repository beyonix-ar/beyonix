-- Quita el tope FIJO de 3 unidades por línea (producto/variante/unidad con
-- descuento) de la reserva del Paso 3 y de sus dos commits (Mercado Pago;
-- transferencia y saldo). Manda el stock real: available_stock_for_session
-- bajo pg_advisory_xact_lock(93000, producto) sigue siendo la única autoridad
-- contra la sobreventa, igual que antes.
--
-- Cada función es copia literal de su última definición
-- (reserve_cart_stock: 20261008120000; commit_mercadopago_checkout_reservation:
-- 20260925130000; commit_checkout_step_reservation: 20260926100000). Sólo
-- cambia el tope: 1..999 por línea, el mismo techo de sanidad que ya exige la
-- creación de la orden (MAX_CHECKOUT_ITEM_QUANTITY) y que mantiene seguro el
-- cast a integer. create or replace conserva owner y grants.
begin;

create or replace function public.reserve_cart_stock(p_session_id text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_session public.checkout_reservation_sessions%rowtype;
  v_item record;
  v_variant record;
  v_product_id bigint;
  v_available integer;
  v_count integer;
  v_now timestamptz;
  v_remaining integer;
  v_take integer;
begin
  if p_session_id is null or length(btrim(p_session_id)) < 8
     or length(p_session_id) > 160 then
    raise exception 'INVALID_SESSION';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_QUANTITY';
  end if;

  perform pg_advisory_xact_lock(93001, hashtext(p_session_id));
  v_now := clock_timestamp();
  select * into v_session from public.checkout_reservation_sessions
  where session_id = p_session_id;

  if found then
    if v_session.order_id is not null then raise exception 'RESERVATION_LOCKED_TO_ORDER'; end if;
    if v_session.user_id is not null and v_session.user_id is distinct from auth.uid() then
      raise exception 'INVALID_SESSION';
    end if;
    if v_session.expires_at <= v_now then raise exception 'RESERVATION_EXPIRED'; end if;
  elsif jsonb_array_length(p_items) = 0 then
    raise exception 'INVALID_SESSION';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce(item ->> 'quantity', '') !~ '^[1-9][0-9]{0,2}$'
  ) then raise exception 'INVALID_QUANTITY'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce(item ->> 'productId', item ->> 'product_id', '') !~ '^[0-9]{1,18}$'
       or (coalesce(item ->> 'variantId', item ->> 'variant_id') is not null
           and coalesce(item ->> 'variantId', item ->> 'variant_id') !~ '^[0-9]{1,18}$')
       or (coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id') is not null
           and coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id')
               !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) then raise exception 'INVALID_VARIANT'; end if;

  select count(*) into v_count from (
    select 1 from jsonb_array_elements(p_items) item
    group by coalesce(item ->> 'productId', item ->> 'product_id'),
             coalesce(item ->> 'variantId', item ->> 'variant_id'),
             coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id')
    having sum((item ->> 'quantity')::integer) > 999
  ) excessive;
  if v_count > 0 then raise exception 'INVALID_QUANTITY'; end if;

  for v_product_id in
    select distinct product_id from (
      select coalesce(item ->> 'productId', item ->> 'product_id')::bigint as product_id
      from jsonb_array_elements(p_items) item
      union
      select product_id from public.stock_reservations where session_id = p_session_id
    ) targets order by 1
  loop
    perform pg_advisory_xact_lock(93000, v_product_id::integer);
  end loop;

  v_now := clock_timestamp();
  select * into v_session from public.checkout_reservation_sessions
  where session_id = p_session_id;
  if found and v_session.order_id is not null then
    raise exception 'RESERVATION_LOCKED_TO_ORDER';
  end if;
  if found and v_session.expires_at <= v_now then
    raise exception 'RESERVATION_EXPIRED';
  end if;
  if exists (select 1 from public.stock_reservations
             where session_id = p_session_id and order_id is not null) then
    raise exception 'RESERVATION_LOCKED_TO_ORDER';
  end if;

  if not exists (select 1 from public.checkout_reservation_sessions where session_id = p_session_id) then
    insert into public.checkout_reservation_sessions
      (session_id, user_id, reservation_started_at, expires_at)
    values (p_session_id, auth.uid(), v_now, v_now + public.checkout_step_reservation_ttl())
    returning * into v_session;
  elsif v_session.user_id is null and auth.uid() is not null then
    update public.checkout_reservation_sessions set user_id = auth.uid()
    where session_id = p_session_id;
  end if;

  delete from public.stock_reservations where session_id = p_session_id;
  for v_item in
    select coalesce(item ->> 'productId', item ->> 'product_id')::bigint as product_id,
           coalesce(item ->> 'variantId', item ->> 'variant_id')::bigint as variant_id,
           coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id')::uuid as conditioned_stock_id,
           sum((item ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) item
    group by 1, 2, 3 order by 1, 2 nulls first, 3 nulls first
  loop
    if v_item.product_id <= 0 or v_item.variant_id <= 0
       or (v_item.variant_id is not null and v_item.conditioned_stock_id is not null)
       or not exists (select 1 from public.productos
                      where id = v_item.product_id and activo) then
      raise exception 'INVALID_VARIANT';
    end if;

    if v_item.variant_id is null and v_item.conditioned_stock_id is null
       and exists (select 1 from public.producto_variantes
                   where producto_id = v_item.product_id and activo) then
      if not exists (select 1 from public.productos
                     where id = v_item.product_id and venta_aleatoria) then
        raise exception 'INVALID_VARIANT';
      end if;
      -- Venta aleatoria: unidades reales del pool, nunca un color inexistente.
      v_remaining := v_item.quantity;
      for v_variant in
        select variants.id,
               public.available_stock_for_session(v_item.product_id, variants.id, null, p_session_id)
                 - coalesce((select sum(own.quantity) from public.stock_reservations own
                             where own.session_id = p_session_id and own.product_id = v_item.product_id
                               and own.variant_id = variants.id), 0) as available
        from public.producto_variantes variants
        where variants.producto_id = v_item.product_id and variants.activo
        order by 2 desc, variants.id
      loop
        exit when v_remaining = 0;
        v_take := least(v_remaining, greatest(v_variant.available, 0));
        continue when v_take = 0;
        if exists (select 1 from public.stock_reservations
                   where session_id = p_session_id and product_id = v_item.product_id
                     and variant_id = v_variant.id and conditioned_stock_id is null) then
          update public.stock_reservations set quantity = quantity + v_take
          where session_id = p_session_id and product_id = v_item.product_id
            and variant_id = v_variant.id and conditioned_stock_id is null;
        else
          insert into public.stock_reservations
            (session_id, user_id, product_id, variant_id, conditioned_stock_id, quantity, expires_at)
          values (p_session_id, coalesce(v_session.user_id, auth.uid()),
                  v_item.product_id, v_variant.id, null, v_take, v_session.expires_at);
        end if;
        v_remaining := v_remaining - v_take;
      end loop;
      if v_remaining > 0 then raise exception 'OUT_OF_STOCK'; end if;
      continue;
    end if;

    v_available := public.available_stock_for_session(
      v_item.product_id, v_item.variant_id, v_item.conditioned_stock_id, p_session_id
    );
    if v_available is null then raise exception 'INVALID_VARIANT'; end if;
    if v_available < v_item.quantity then raise exception 'OUT_OF_STOCK'; end if;
    insert into public.stock_reservations
      (session_id, user_id, product_id, variant_id, conditioned_stock_id,
       quantity, expires_at)
    values (p_session_id, coalesce(v_session.user_id, auth.uid()),
            v_item.product_id, v_item.variant_id, v_item.conditioned_stock_id,
            v_item.quantity, v_session.expires_at);
  end loop;

  return jsonb_build_object('reserved', jsonb_array_length(p_items) > 0,
                            'reservation_started_at', v_session.reservation_started_at,
                            'expires_at', v_session.expires_at);
end;
$$;

create or replace function public.commit_mercadopago_checkout_reservation(
  p_items jsonb, p_session_id text, p_order_id bigint
)
returns timestamptz language plpgsql security definer set search_path = public
as $$
declare
  v_session public.checkout_reservation_sessions%rowtype;
  v_order public.ordenes%rowtype;
  v_product_id bigint;
  v_now timestamptz;
begin
  if auth.role() <> 'service_role' then raise exception 'INVALID_SESSION'; end if;
  if p_session_id is null or length(btrim(p_session_id)) < 8
     or length(p_session_id) > 160 or p_order_id is null or p_order_id <= 0
     or p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce(item ->> 'product_id', '') !~ '^[0-9]{1,18}$'
       or coalesce(item ->> 'quantity', '') !~ '^[1-9][0-9]{0,2}$'
       or (item ->> 'variant_id' is not null and item ->> 'variant_id' !~ '^[0-9]{1,18}$')
       or (item ->> 'conditioned_stock_id' is not null
           and item ->> 'conditioned_stock_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) then raise exception 'CHECKOUT_ITEMS_INVALID'; end if;

  perform pg_advisory_xact_lock(93001, hashtext(p_session_id));
  select * into v_session from public.checkout_reservation_sessions
  where session_id = p_session_id for update;
  if not found then raise exception 'RESERVATION_EXPIRED'; end if;
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found or v_order.estado <> 'pendiente'
     or v_order.payment_method_id <> 'mercadopago'
     or v_order.mercadopago_reservation_session_id is distinct from p_session_id
     or v_order.usuario_id is distinct from v_session.user_id then
    raise exception 'INVALID_SESSION';
  end if;
  if v_session.order_id is not null and v_session.order_id <> p_order_id then
    raise exception 'RESERVATION_LOCKED_TO_ORDER';
  end if;

  for v_product_id in
    select distinct product_id from (
      select (item ->> 'product_id')::bigint as product_id
      from jsonb_array_elements(p_items) item
      union
      select product_id from public.stock_reservations where session_id = p_session_id
    ) targets order by 1
  loop
    perform pg_advisory_xact_lock(93000, v_product_id::integer);
  end loop;
  v_now := clock_timestamp();
  if v_session.expires_at <= v_now + interval '60 seconds' then
    raise exception 'RESERVATION_EXPIRED';
  end if;
  if exists (select 1 from public.stock_reservations
             where session_id = p_session_id
               and (expires_at <> v_session.expires_at
                    or user_id is distinct from v_session.user_id
                    or (order_id is not null and order_id <> p_order_id))) then
    raise exception 'RESERVATION_INVALID';
  end if;
  if exists (
    with requested as (
      select (item ->> 'product_id')::bigint product_id,
             nullif(item ->> 'variant_id', '')::bigint variant_id,
             nullif(item ->> 'conditioned_stock_id', '')::uuid conditioned_stock_id,
             sum((item ->> 'quantity')::integer)::integer quantity
      from jsonb_array_elements(p_items) item group by 1,2,3
    ), reserved as (
      select product_id, variant_id, conditioned_stock_id, sum(quantity)::integer quantity
      from public.stock_reservations where session_id = p_session_id group by 1,2,3
    )
    select 1 from requested r full join reserved s
      on r.product_id = s.product_id and r.variant_id is not distinct from s.variant_id
      and r.conditioned_stock_id is not distinct from s.conditioned_stock_id
    where r.product_id is null or s.product_id is null or r.quantity <> s.quantity
       or r.quantity > 999 or r.product_id <= 0
       or (r.variant_id is not null and r.variant_id <= 0)
       or (r.variant_id is not null and r.conditioned_stock_id is not null)
  ) then raise exception 'RESERVATION_INVALID'; end if;
  if not exists (select 1 from public.stock_reservations where session_id = p_session_id) then
    raise exception 'RESERVATION_EXPIRED';
  end if;
  if exists (
    with requested as (
      select (item ->> 'product_id')::bigint product_id,
             nullif(item ->> 'variant_id', '')::bigint variant_id,
             nullif(item ->> 'conditioned_stock_id', '')::uuid conditioned_stock_id,
             sum((item ->> 'quantity')::integer)::integer quantity
      from jsonb_array_elements(p_items) item group by 1,2,3
    ), ordered as (
      select producto_id product_id, variante_id variant_id,
             conditioned_stock_id, sum(cantidad)::integer quantity
      from public.orden_items where orden_id = p_order_id group by 1,2,3
    )
    select 1 from requested r full join ordered o
      on r.product_id = o.product_id and r.variant_id is not distinct from o.variant_id
      and r.conditioned_stock_id is not distinct from o.conditioned_stock_id
    where r.product_id is null or o.product_id is null or r.quantity <> o.quantity
  ) then raise exception 'RESERVATION_INVALID'; end if;
  if not exists (select 1 from public.orden_items where orden_id = p_order_id) then
    raise exception 'RESERVATION_INVALID';
  end if;
  if exists (
    select 1 from public.stock_reservations r
    where r.session_id = p_session_id and
      (r.expires_at <= v_now or public.available_stock_for_session(
        r.product_id, r.variant_id, r.conditioned_stock_id, p_session_id
      ) < r.quantity)
  ) then raise exception 'CHECKOUT_STOCK_INSUFFICIENT'; end if;

  -- Existing catalog/variant validation is retained. Any exception rolls back
  -- the entire RPC, including every row in a multi-item reservation.
  perform public.decrement_checkout_inventory(p_items);
  update public.stock_reservations set order_id = p_order_id
  where session_id = p_session_id and order_id is null;
  return v_session.expires_at;
end;
$$;

create or replace function public.commit_checkout_step_reservation(
  p_items jsonb, p_session_id text, p_order_id bigint
)
returns timestamptz language plpgsql security definer set search_path = public
as $$
declare
  v_session public.checkout_reservation_sessions%rowtype;
  v_order public.ordenes%rowtype;
  v_product_id bigint;
  v_now timestamptz;
begin
  if auth.role() <> 'service_role' then raise exception 'INVALID_SESSION'; end if;
  if p_session_id is null or length(btrim(p_session_id)) < 8
     or length(p_session_id) > 160 or p_order_id is null or p_order_id <= 0
     or p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce(item ->> 'product_id', '') !~ '^[0-9]{1,18}$'
       or coalesce(item ->> 'quantity', '') !~ '^[1-9][0-9]{0,2}$'
       or (item ->> 'variant_id' is not null and item ->> 'variant_id' !~ '^[0-9]{1,18}$')
       or (item ->> 'conditioned_stock_id' is not null
           and item ->> 'conditioned_stock_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) then raise exception 'CHECKOUT_ITEMS_INVALID'; end if;

  perform pg_advisory_xact_lock(93001, hashtext(p_session_id));
  select * into v_session from public.checkout_reservation_sessions
  where session_id = p_session_id for update;
  if not found then raise exception 'RESERVATION_EXPIRED'; end if;
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found or v_order.estado <> 'pendiente'
     or coalesce(v_order.payment_method_id, '') not in ('transferencia', 'customer_credit')
     or v_order.checkout_idempotency_key is distinct from 'checkout:' || p_session_id
     or v_order.usuario_id is distinct from v_session.user_id then
    raise exception 'INVALID_SESSION';
  end if;
  if v_session.order_id is not null and v_session.order_id <> p_order_id then
    raise exception 'RESERVATION_LOCKED_TO_ORDER';
  end if;

  for v_product_id in
    select distinct product_id from (
      select (item ->> 'product_id')::bigint as product_id
      from jsonb_array_elements(p_items) item
      union
      select product_id from public.stock_reservations where session_id = p_session_id
    ) targets order by 1
  loop
    perform pg_advisory_xact_lock(93000, v_product_id::integer);
  end loop;
  v_now := clock_timestamp();
  -- Mismo margen que Mercado Pago: con menos de un minuto no hay tiempo real
  -- para transferir, y nunca se abre una ventana nueva.
  if v_session.expires_at <= v_now + interval '60 seconds' then
    raise exception 'RESERVATION_EXPIRED';
  end if;
  if exists (select 1 from public.stock_reservations
             where session_id = p_session_id
               and (expires_at <> v_session.expires_at
                    or user_id is distinct from v_session.user_id
                    or (order_id is not null and order_id <> p_order_id))) then
    raise exception 'RESERVATION_INVALID';
  end if;
  if not exists (select 1 from public.stock_reservations where session_id = p_session_id) then
    raise exception 'RESERVATION_EXPIRED';
  end if;
  -- La reserva, el pedido y el request tienen que describir exactamente la
  -- misma compra: all-or-nothing, nunca un compromiso parcial.
  if exists (
    with requested as (
      select (item ->> 'product_id')::bigint product_id,
             nullif(item ->> 'variant_id', '')::bigint variant_id,
             nullif(item ->> 'conditioned_stock_id', '')::uuid conditioned_stock_id,
             sum((item ->> 'quantity')::integer)::integer quantity
      from jsonb_array_elements(p_items) item group by 1,2,3
    ), reserved as (
      select product_id, variant_id, conditioned_stock_id, sum(quantity)::integer quantity
      from public.stock_reservations where session_id = p_session_id group by 1,2,3
    )
    select 1 from requested r full join reserved s
      on r.product_id = s.product_id and r.variant_id is not distinct from s.variant_id
      and r.conditioned_stock_id is not distinct from s.conditioned_stock_id
    where r.product_id is null or s.product_id is null or r.quantity <> s.quantity
       or r.quantity > 999 or r.product_id <= 0
       or (r.variant_id is not null and r.variant_id <= 0)
       or (r.variant_id is not null and r.conditioned_stock_id is not null)
  ) then raise exception 'RESERVATION_INVALID'; end if;
  if exists (
    with requested as (
      select (item ->> 'product_id')::bigint product_id,
             nullif(item ->> 'variant_id', '')::bigint variant_id,
             nullif(item ->> 'conditioned_stock_id', '')::uuid conditioned_stock_id,
             sum((item ->> 'quantity')::integer)::integer quantity
      from jsonb_array_elements(p_items) item group by 1,2,3
    ), ordered as (
      select producto_id product_id, variante_id variant_id,
             conditioned_stock_id, sum(cantidad)::integer quantity
      from public.orden_items where orden_id = p_order_id group by 1,2,3
    )
    select 1 from requested r full join ordered o
      on r.product_id = o.product_id and r.variant_id is not distinct from o.variant_id
      and r.conditioned_stock_id is not distinct from o.conditioned_stock_id
    where r.product_id is null or o.product_id is null or r.quantity <> o.quantity
  ) then raise exception 'RESERVATION_INVALID'; end if;
  if exists (
    select 1 from public.stock_reservations r
    where r.session_id = p_session_id and
      (r.expires_at <= v_now or public.available_stock_for_session(
        r.product_id, r.variant_id, r.conditioned_stock_id, p_session_id
      ) < r.quantity)
  ) then raise exception 'CHECKOUT_STOCK_INSUFFICIENT'; end if;

  perform public.decrement_checkout_inventory(p_items);
  update public.stock_reservations set order_id = p_order_id
  where session_id = p_session_id and order_id is null;
  return v_session.expires_at;
end;
$$;

commit;
