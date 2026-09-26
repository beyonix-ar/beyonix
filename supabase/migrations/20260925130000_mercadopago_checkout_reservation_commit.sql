-- Mercado Pago only: commit the exact Step 3 reservation before issuing a
-- payable preference. The previous checkout validator replaces rows and starts
-- a new 30 minute lease, so MP must use this separate atomic transition.
begin;

alter table public.checkout_reservation_sessions
  add column mercadopago_pending_held_at timestamptz;
alter table public.ordenes
  add column mercadopago_reservation_session_id text;
create index checkout_reservation_sessions_order_id_idx
  on public.checkout_reservation_sessions (order_id)
  where order_id is not null;

create function public.commit_mercadopago_checkout_reservation(
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
       or r.quantity > 3 or r.product_id <= 0
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
revoke all on function public.commit_mercadopago_checkout_reservation(jsonb,text,bigint)
  from public, anon, authenticated;
grant execute on function public.commit_mercadopago_checkout_reservation(jsonb,text,bigint)
  to service_role;

-- A provider approval is dated by date_approved. If absent, the webhook uses
-- its server receipt time. The stock confirmation guard still checks physical
-- availability under product locks; a late approval cannot consume stock.
create function public.hold_mercadopago_pending_reservation()
returns trigger language plpgsql set search_path = public as $$
declare
  v_session public.checkout_reservation_sessions%rowtype;
  v_item record;
  v_can_hold boolean := true;
begin
  if new.payment_method_id <> 'mercadopago' or new.estado <> 'pendiente'
     or new.payment_status is not distinct from old.payment_status then return new; end if;
  select * into v_session from public.checkout_reservation_sessions
  where order_id = new.id for update;
  if not found then return new; end if;

  if new.payment_status in ('pending', 'in_process', 'in_mediation', 'authorized')
     and v_session.mercadopago_pending_held_at is null then
    -- Preserve a real provider payment, but only if its original lease still
    -- holds every item. Product locks serialize this with another checkout.
    for v_item in select * from public.stock_reservations
      where order_id = new.id order by product_id, variant_id nulls first,
                                 conditioned_stock_id nulls first
    loop
      perform pg_advisory_xact_lock(93000, v_item.product_id::integer);
      if v_item.expires_at <= clock_timestamp()
         or public.available_stock_for_session(v_item.product_id, v_item.variant_id,
              v_item.conditioned_stock_id, v_item.session_id) < v_item.quantity then
        v_can_hold := false;
      end if;
    end loop;
    if v_can_hold and v_session.expires_at > clock_timestamp()
       and exists (select 1 from public.stock_reservations where order_id = new.id) then
      update public.stock_reservations set expires_at = 'infinity'::timestamptz
      where order_id = new.id;
      update public.checkout_reservation_sessions
      set mercadopago_pending_held_at = clock_timestamp()
      where session_id = v_session.session_id;
    end if;
  elsif new.payment_status in ('rejected', 'cancelled')
        and v_session.mercadopago_pending_held_at is not null then
    update public.stock_reservations set expires_at = v_session.expires_at
    where order_id = new.id;
    update public.checkout_reservation_sessions
    set mercadopago_pending_held_at = null
    where session_id = v_session.session_id;
  end if;
  return new;
end;
$$;
create trigger hold_mercadopago_pending_reservation
after update of payment_status on public.ordenes
for each row execute function public.hold_mercadopago_pending_reservation();
revoke all on function public.hold_mercadopago_pending_reservation()
  from public, anon, authenticated;

create function public.guard_mercadopago_reservation_approval()
returns trigger language plpgsql set search_path = public as $$
declare v_session public.checkout_reservation_sessions%rowtype;
        v_item record;
begin
  if old.estado = 'pendiente' and new.estado = 'pagado'
     and new.payment_method_id = 'mercadopago' then
    select * into v_session from public.checkout_reservation_sessions
    where order_id = new.id;
    if new.mercadopago_reservation_session_id is not null
       and (not found or v_session.session_id is distinct from new.mercadopago_reservation_session_id) then
      raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
    end if;
    if found and (new.payment_confirmed_at is null
                  or (new.payment_confirmed_at > v_session.expires_at
                      and v_session.mercadopago_pending_held_at is null)) then
      raise exception 'RESERVATION_APPROVAL_EXPIRED';
    end if;
    if found then
      -- Even an on-time provider approval can arrive after the lease expired.
      -- Recheck stock net of OTHER active reservations under their product
      -- locks before the existing physical-stock confirmation trigger runs.
      for v_item in
        select producto_id, variante_id, conditioned_stock_id,
               sum(cantidad)::integer quantity
        from public.orden_items where orden_id = new.id
        group by 1,2,3 order by 1,2 nulls first,3 nulls first
      loop
        perform pg_advisory_xact_lock(93000, v_item.producto_id::integer);
        if public.available_stock_for_session(
          v_item.producto_id, v_item.variante_id,
          v_item.conditioned_stock_id, v_session.session_id
        ) < v_item.quantity then
          raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
        end if;
      end loop;
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_mercadopago_reservation_approval
before update of estado on public.ordenes
for each row execute function public.guard_mercadopago_reservation_approval();
revoke all on function public.guard_mercadopago_reservation_approval()
  from public, anon, authenticated;

commit;
