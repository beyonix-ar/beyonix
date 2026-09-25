-- Reserva previa al pago (Paso 3). No altera la ventana de 30 minutos de
-- checkout_reservation_ttl(), que protege las órdenes/preferencias existentes.
begin;

create table public.checkout_reservation_sessions (
  session_id text primary key,
  user_id uuid references auth.users(id) on delete set null,
  reservation_started_at timestamptz not null,
  expires_at timestamptz not null,
  order_id bigint,
  constraint checkout_reservation_sessions_window_check check (expires_at > reservation_started_at)
);

alter table public.checkout_reservation_sessions enable row level security;
revoke all on public.checkout_reservation_sessions from public, anon, authenticated;
grant select, insert, update on public.checkout_reservation_sessions to service_role;

-- Una sesión conserva su inicio aunque las filas vencidas se purguen.
-- Las sesiones comprometidas son tombstones permanentes: el mismo checkout
-- nunca puede reabrirlas con otra composición.
insert into public.checkout_reservation_sessions
  (session_id, user_id, reservation_started_at, expires_at, order_id)
select session_id, min(user_id::text)::uuid, min(created_at),
       greatest(min(created_at) + interval '20 minutes', min(created_at) + interval '1 second'),
       max(order_id)
from public.stock_reservations
group by session_id;

update public.stock_reservations r
set expires_at = least(r.expires_at, s.expires_at)
from public.checkout_reservation_sessions s
where r.session_id = s.session_id and r.order_id is null;

create or replace function public.checkout_step_reservation_ttl()
returns interval language sql immutable parallel safe
as $$ select interval '20 minutes' $$;
revoke all on function public.checkout_step_reservation_ttl() from public;
grant execute on function public.checkout_step_reservation_ttl() to anon, authenticated, service_role;

-- validate_checkout_inventory_reservation inserta la fila vinculada desde el
-- service role. Registrar esa transición incluso si nunca hubo Paso 3.
create or replace function public.record_checkout_reservation_commit()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.order_id is not null then
    insert into public.checkout_reservation_sessions
      (session_id, user_id, reservation_started_at, expires_at, order_id)
    values (new.session_id, new.user_id, new.created_at,
            greatest(new.expires_at, new.created_at + interval '1 second'), new.order_id)
    on conflict (session_id) do update
      set order_id = excluded.order_id
      where checkout_reservation_sessions.order_id is null
         or checkout_reservation_sessions.order_id = excluded.order_id;
    if not found then raise exception 'RESERVATION_LOCKED_TO_ORDER'; end if;
  end if;
  return new;
end;
$$;

create trigger record_checkout_reservation_commit
after insert or update of order_id on public.stock_reservations
for each row execute function public.record_checkout_reservation_commit();
revoke all on function public.record_checkout_reservation_commit() from public, anon, authenticated;

create or replace function public.reserve_cart_stock(p_session_id text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_session public.checkout_reservation_sessions%rowtype;
  v_item record;
  v_product_id bigint;
  v_available integer;
  v_count integer;
  v_now timestamptz;
begin
  if p_session_id is null or length(btrim(p_session_id)) < 8
     or length(p_session_id) > 160 then
    raise exception 'INVALID_SESSION';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_QUANTITY';
  end if;

  -- Mismo checkout, dos pestañas: serializar antes de leer/alterar su lease.
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

  -- Validar cada línea ANTES de agrupar: dos líneas de 2 no pueden eludir 3.
  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce(item ->> 'quantity', '') !~ '^[123]$'
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
    having sum((item ->> 'quantity')::integer) > 3
  ) excessive;
  if v_count > 0 then raise exception 'INVALID_QUANTITY'; end if;

  -- Bloquear todos los productos viejos y nuevos en orden fijo. La operación
  -- completa corre en la transacción implícita de una única llamada RPC.
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

  -- Revalidar con reloj fresco después de esperar los locks.
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

  -- Una falla posterior levanta excepción y revierte también este DELETE.
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
      raise exception 'INVALID_VARIANT';
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
revoke all on function public.reserve_cart_stock(text, jsonb) from public;
grant execute on function public.reserve_cart_stock(text, jsonb)
  to anon, authenticated, service_role;

-- El cierre de orden también usa el mismo lock de sesión ANTES de bloquear
-- productos. Así no puede cruzarse con un reemplazo desde otra pestaña.
alter function public.validate_checkout_inventory_reservation(jsonb, text, bigint)
  rename to validate_checkout_inventory_reservation_before_step_reservations;
revoke all on function public.validate_checkout_inventory_reservation_before_step_reservations(jsonb, text, bigint)
  from public, anon, authenticated, service_role;

create function public.validate_checkout_inventory_reservation(
  p_items jsonb, p_session_id text, p_order_id bigint
)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'INVALID_SESSION'; end if;
  if p_session_id is null or length(btrim(p_session_id)) < 8
     or length(p_session_id) > 160 then raise exception 'INVALID_SESSION'; end if;
  perform pg_advisory_xact_lock(93001, hashtext(p_session_id));
  if exists (select 1 from public.checkout_reservation_sessions
             where session_id = p_session_id and order_id is not null
               and order_id <> p_order_id) then
    raise exception 'RESERVATION_LOCKED_TO_ORDER';
  end if;
  return public.validate_checkout_inventory_reservation_before_step_reservations(
    p_items, p_session_id, p_order_id
  );
end;
$$;
revoke all on function public.validate_checkout_inventory_reservation(jsonb, text, bigint)
  from public, anon, authenticated;
grant execute on function public.validate_checkout_inventory_reservation(jsonb, text, bigint)
  to service_role;

-- Estas RPC no son usadas por los checkouts actuales. Impedir que un cliente
-- con el session_id pueda liberar o reasignar una reserva ligada a una orden.
create or replace function public.release_cart_stock_reservation(p_session_id text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if p_session_id is null or length(btrim(p_session_id)) < 8 then
    raise exception 'INVALID_SESSION';
  end if;
  perform pg_advisory_xact_lock(93001, hashtext(p_session_id));
  if exists (select 1 from public.checkout_reservation_sessions
             where session_id = p_session_id and order_id is not null)
     or exists (select 1 from public.stock_reservations
                where session_id = p_session_id and order_id is not null) then
    raise exception 'RESERVATION_LOCKED_TO_ORDER';
  end if;
  if exists (select 1 from public.checkout_reservation_sessions
             where session_id = p_session_id and user_id is not null
               and user_id is distinct from auth.uid()) then
    raise exception 'INVALID_SESSION';
  end if;
  delete from public.stock_reservations where session_id = p_session_id;
end;
$$;
revoke all on function public.release_cart_stock_reservation(text) from public;
grant execute on function public.release_cart_stock_reservation(text)
  to anon, authenticated, service_role;

-- Esta RPC antigua vincula sin revalidar el stock. Ningún rol de API debe
-- usarla: el único camino válido es validate_checkout_inventory_reservation.
revoke all on function public.complete_cart_stock_reservation(text, bigint)
  from public, anon, authenticated, service_role;

commit;
