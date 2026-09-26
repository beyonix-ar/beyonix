-- Fase 4: transferencias bancarias sobre la reserva única del Paso 3.
--
-- Ventana comercial: los 20 minutos de checkout_reservation_sessions.expires_at,
-- iguales para todos los medios de pago. Transferencia y saldo a favor
-- comprometen ESA reserva sin crear una nueva (antes el validador heredado
-- reemplazaba las filas y abría 30 minutos más, aun con la reserva vencida).
-- Mercado Pago ya usa su propio commit (20260925130000).
--
-- Ventana técnica: la conciliación puede detectar una transferencia después
-- del vencimiento, pero ya no hay stock garantizado. Toda confirmación de un
-- pedido por transferencia (automática o manual) revalida bajo los locks por
-- producto el stock neto de reservas activas de OTRAS sesiones. Si no alcanza,
-- CHECKOUT_STOCK_INSUFFICIENT: confirm_transfer_auto_verification ya lo
-- convierte en auto_verified_stock_conflict y reclama el payment.id.
begin;

create function public.commit_checkout_step_reservation(
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
       or coalesce(item ->> 'quantity', '') !~ '^[123]$'
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
       or r.quantity > 3 or r.product_id <= 0
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
revoke all on function public.commit_checkout_step_reservation(jsonb, text, bigint)
  from public, anon, authenticated;
grant execute on function public.commit_checkout_step_reservation(jsonb, text, bigint)
  to service_role;

comment on function public.commit_checkout_step_reservation(jsonb, text, bigint) is
  'Transferencia / saldo a favor: ata la reserva vigente del Paso 3 al pedido sin renovarla. Devuelve el expires_at original (ventana comercial de 20 minutos).';

-- Guardián de confirmación para transferencias. Se ejecuta antes que
-- validate_inventory_order_confirmation (orden alfabético de triggers BEFORE)
-- y toma los mismos advisory locks por producto en orden ascendente, así que
-- dos confirmaciones por la última unidad se serializan.
create function public.guard_transfer_reservation_confirmation()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_session_id text;
  v_expires_at timestamptz;
  v_item record;
  v_checked_at timestamptz;
  v_provider_paid_at timestamptz;
begin
  if new.payment_method_id is distinct from 'transferencia'
     or public.inventory_order_consumes_stock(old.estado, old.payment_status)
     or not public.inventory_order_consumes_stock(new.estado, new.payment_status) then
    return new;
  end if;

  select session_id, expires_at into v_session_id, v_expires_at
  from public.checkout_reservation_sessions
  where order_id = new.id
  order by expires_at desc limit 1;
  if v_session_id is null then
    select session_id into v_session_id
    from public.stock_reservations where order_id = new.id limit 1;
  end if;

  for v_item in
    select producto_id, variante_id, conditioned_stock_id,
           sum(cantidad)::integer quantity
    from public.orden_items where orden_id = new.id
    group by 1,2,3 order by 1,2 nulls first,3 nulls first
  loop
    perform pg_advisory_xact_lock(93000, v_item.producto_id::integer);
    -- Dentro del plazo la reserva propia sigue excluida y garantiza la unidad.
    -- Vencida, deja de contarse: sólo se confirma si sobra stock neto de las
    -- reservas vigentes de otras compras (nunca se toma una unidad ajena).
    if coalesce(public.available_stock_for_session(
      v_item.producto_id, v_item.variante_id,
      v_item.conditioned_stock_id, v_session_id
    ), 0) < v_item.quantity then
      raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
    end if;
  end loop;

  v_checked_at := clock_timestamp();
  if v_expires_at is null or v_expires_at <= v_checked_at then
    -- date_approved/date_created los genera Mercado Pago al ACREDITAR la
    -- transferencia: son una cota superior confiable del momento de envío.
    -- Si es <= expires_at, el cliente pagó dentro del plazo aunque se haya
    -- detectado después; se registra, pero NO cambia la regla de stock (la
    -- reserva ya se liberó y nunca se toma una unidad reservada o vendida a
    -- otra compra). Sin fecha del proveedor -> no demostrable (null).
    begin
      v_provider_paid_at := coalesce(
        nullif(new.transfer_match_snapshot ->> 'dateApproved', '')::timestamptz,
        nullif(new.transfer_match_snapshot ->> 'dateCreated', '')::timestamptz
      );
    exception when others then
      v_provider_paid_at := null;
    end;
    insert into public.order_audit_events(
      order_id, actor_type, actor_id, action, previous_status, new_status, metadata
    ) values (
      new.id, 'system', null, 'transfer_confirmed_after_reservation_expiry',
      old.payment_status, new.payment_status,
      jsonb_build_object('reservationExpiresAt', v_expires_at,
                         'stockRevalidatedAt', v_checked_at,
                         'providerPaidAt', v_provider_paid_at,
                         'paidWithinReservation',
                           case when v_provider_paid_at is null or v_expires_at is null then null
                                else v_provider_paid_at <= v_expires_at end)
    );
  end if;
  return new;
end;
$$;
revoke all on function public.guard_transfer_reservation_confirmation()
  from public, anon, authenticated;

create trigger guard_transfer_reservation_confirmation
before update of estado, payment_status on public.ordenes
for each row when (new.payment_method_id = 'transferencia')
execute function public.guard_transfer_reservation_confirmation();

comment on trigger guard_transfer_reservation_confirmation on public.ordenes is
  'Una transferencia sólo consume stock si el stock neto de reservas activas ajenas alcanza bajo lock. Pago tardío sin stock -> CHECKOUT_STOCK_INSUFFICIENT (conflicto controlado, nunca sobreventa).';

commit;
