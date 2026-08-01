-- Reservas de carrito trazables e idempotentes para evitar sobreventa.

create table if not exists public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  user_id uuid references auth.users(id) on delete cascade,
  product_id bigint not null references public.productos(id) on delete cascade,
  variant_id bigint references public.producto_variantes(id) on delete cascade,
  conditioned_stock_id uuid references public.inventory_return_movements(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  order_id bigint references public.ordenes(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_reservations_target_check check (
    not (variant_id is not null and conditioned_stock_id is not null)
  ),
  constraint stock_reservations_session_target_unique unique nulls not distinct (
    session_id, product_id, variant_id, conditioned_stock_id
  )
);

create index if not exists stock_reservations_active_target_idx
  on public.stock_reservations (
    product_id, variant_id, conditioned_stock_id, expires_at
  );
create index if not exists stock_reservations_order_idx
  on public.stock_reservations (order_id)
  where order_id is not null;

alter table public.stock_reservations enable row level security;
revoke all on public.stock_reservations from public, anon, authenticated;
grant select, insert, update, delete on public.stock_reservations to service_role;

create or replace function public.reserve_cart_stock(
  p_session_id text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_product_id bigint;
  v_variant_id bigint;
  v_conditioned_id uuid;
  v_quantity integer;
  v_stock integer;
  v_reserved integer;
  v_expiry timestamptz := now() + interval '15 minutes';
begin
  if length(btrim(coalesce(p_session_id, ''))) < 8
     or length(p_session_id) > 160
     or p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'RESERVATION_INVALID';
  end if;

  delete from public.stock_reservations reservations
  where reservations.expires_at <= now();

  for v_product_id in
    select distinct coalesce(
      nullif(item ->> 'productId', '')::bigint,
      nullif(item ->> 'product_id', '')::bigint
    )
    from jsonb_array_elements(p_items) item
    order by 1
  loop
    if v_product_id is null then raise exception 'RESERVATION_INVALID'; end if;
    perform pg_advisory_xact_lock(93000, v_product_id::integer);
  end loop;

  delete from public.stock_reservations reservations
  where reservations.session_id = p_session_id;

  for v_item in
    select
      coalesce(
        nullif(item ->> 'productId', '')::bigint,
        nullif(item ->> 'product_id', '')::bigint
      ) as product_id,
      coalesce(
        nullif(item ->> 'variantId', '')::bigint,
        nullif(item ->> 'variant_id', '')::bigint
      ) as variant_id,
      coalesce(
        nullif(item ->> 'conditionedStockId', '')::uuid,
        nullif(item ->> 'conditioned_stock_id', '')::uuid
      ) as conditioned_stock_id,
      sum(coalesce(nullif(item ->> 'quantity', '')::integer, 0))::integer
        as quantity
    from jsonb_array_elements(p_items) item
    group by 1, 2, 3
  loop
    v_product_id := v_item.product_id;
    v_variant_id := v_item.variant_id;
    v_conditioned_id := v_item.conditioned_stock_id;
    v_quantity := v_item.quantity;
    if v_product_id is null or v_quantity <= 0
       or (v_variant_id is not null and v_conditioned_id is not null) then
      raise exception 'RESERVATION_INVALID';
    end if;

    if v_conditioned_id is not null then
      select offers.available_quantity into v_stock
      from public.conditioned_inventory_offers offers
      where offers.id = v_conditioned_id
        and offers.product_id = v_product_id;
    elsif v_variant_id is not null then
      select variants.stock into v_stock
      from public.producto_variantes variants
      where variants.id = v_variant_id
        and variants.producto_id = v_product_id
        and variants.activo;
    else
      if exists (
        select 1 from public.producto_variantes variants
        where variants.producto_id = v_product_id and variants.activo
      ) then
        raise exception 'CHECKOUT_VARIANT_REQUIRED';
      end if;
      select products.stock into v_stock
      from public.productos products
      where products.id = v_product_id and products.activo;
    end if;

    if not found then raise exception 'CHECKOUT_STOCK_INSUFFICIENT'; end if;

    select coalesce(sum(reservations.quantity), 0)::integer
    into v_reserved
    from public.stock_reservations reservations
    where reservations.product_id = v_product_id
      and reservations.variant_id is not distinct from v_variant_id
      and reservations.conditioned_stock_id is not distinct from v_conditioned_id
      and reservations.expires_at > now();

    if coalesce(v_stock, 0) - v_reserved < v_quantity then
      raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
    end if;

    insert into public.stock_reservations (
      session_id, user_id, product_id, variant_id,
      conditioned_stock_id, quantity, expires_at
    ) values (
      p_session_id, auth.uid(), v_product_id, v_variant_id,
      v_conditioned_id, v_quantity, v_expiry
    );
  end loop;

  return jsonb_build_object('reserved', true, 'expires_at', v_expiry);
end;
$$;

create or replace function public.validate_checkout_inventory_reservation(
  p_items jsonb,
  p_session_id text,
  p_order_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_stock integer;
  v_reserved_other integer;
  v_reserved_self integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para validar el inventario.';
  end if;
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or p_order_id is null
     or p_order_id <= 0
     or (
       p_session_id is not null
       and (
         length(btrim(p_session_id)) < 8
         or length(p_session_id) > 160
       )
     ) then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;

  delete from public.stock_reservations reservations
  where reservations.expires_at <= now();

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
    perform pg_advisory_xact_lock(93000, v_item.product_id::integer);

    if v_item.conditioned_stock_id is not null then
      select offers.available_quantity into v_stock
      from public.conditioned_inventory_offers offers
      where offers.id = v_item.conditioned_stock_id
        and offers.product_id = v_item.product_id;
    elsif v_item.variant_id is not null then
      select variants.stock into v_stock
      from public.producto_variantes variants
      where variants.id = v_item.variant_id
        and variants.producto_id = v_item.product_id
        and variants.activo;
    else
      select products.stock into v_stock
      from public.productos products
      where products.id = v_item.product_id and products.activo;
    end if;
    if not found then raise exception 'CHECKOUT_STOCK_INSUFFICIENT'; end if;

    select
      coalesce(sum(reservations.quantity) filter (
        where reservations.session_id is distinct from p_session_id
      ), 0)::integer,
      coalesce(sum(reservations.quantity) filter (
        where reservations.session_id = p_session_id
      ), 0)::integer
    into v_reserved_other, v_reserved_self
    from public.stock_reservations reservations
    where reservations.product_id = v_item.product_id
      and reservations.variant_id is not distinct from v_item.variant_id
      and reservations.conditioned_stock_id is not distinct from v_item.conditioned_stock_id
      and reservations.expires_at > now();

    if coalesce(v_stock, 0) - v_reserved_other < v_item.quantity
       or (p_session_id is not null and v_reserved_self < v_item.quantity) then
      raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
    end if;
  end loop;

  perform public.decrement_checkout_inventory(p_items);

  if p_session_id is not null then
    update public.stock_reservations reservations
    set order_id = p_order_id,
        expires_at = now() + interval '30 minutes',
        updated_at = now()
    where reservations.session_id = p_session_id;
  end if;

  return jsonb_build_object('validated', true, 'reserved', p_session_id is not null);
end;
$$;

create or replace function public.complete_cart_stock_reservation(
  p_session_id text,
  p_order_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.stock_reservations reservations
  set order_id = p_order_id,
      expires_at = greatest(expires_at, now() + interval '30 minutes'),
      updated_at = now()
  where reservations.session_id = p_session_id
    and (reservations.user_id is null or reservations.user_id = auth.uid());
end;
$$;

create or replace function public.release_cart_stock_reservation(
  p_session_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.stock_reservations reservations
  where reservations.session_id = p_session_id
    and (reservations.user_id is null or reservations.user_id = auth.uid());
end;
$$;

create or replace function public.release_order_stock_reservation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.stock_reservations reservations
    where reservations.order_id = old.id;
    return old;
  end if;

  if public.inventory_order_consumes_stock(new.estado, new.payment_status)
     or lower(coalesce(new.estado, '')) in ('cancelado', 'cancelada', 'anulado', 'anulada') then
    delete from public.stock_reservations reservations
    where reservations.order_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists release_order_stock_reservation on public.ordenes;
create trigger release_order_stock_reservation
after update of estado, payment_status or delete on public.ordenes
for each row execute function public.release_order_stock_reservation();

revoke all on function public.reserve_cart_stock(text, jsonb)
  from public;
grant execute on function public.reserve_cart_stock(text, jsonb)
  to anon, authenticated, service_role;
revoke all on function public.validate_checkout_inventory_reservation(jsonb, text, bigint)
  from public, anon, authenticated;
grant execute on function public.validate_checkout_inventory_reservation(jsonb, text, bigint)
  to service_role;
revoke all on function public.complete_cart_stock_reservation(text, bigint)
  from public;
grant execute on function public.complete_cart_stock_reservation(text, bigint)
  to anon, authenticated, service_role;
revoke all on function public.release_cart_stock_reservation(text)
  from public;
grant execute on function public.release_cart_stock_reservation(text)
  to anon, authenticated, service_role;
