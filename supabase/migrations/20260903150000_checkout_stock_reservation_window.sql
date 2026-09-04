-- Reserva de stock efectiva en el checkout (cierre de sobreventa).
--
-- PROBLEMA QUE CIERRA
-- El stock de BEYONIX es DERIVADO: `productos.stock` / `producto_variantes.stock`
-- son una proyección de `inventory_movements`, y una venta web sólo resta cuando
-- la orden llega a un estado que consume stock (ver inventory_order_consumes_stock).
-- Por eso, entre "creé la orden y me fui a pagar" y "el pago se confirmó", el
-- stock sigue figurando completo. Dos clientes podían validar la última unidad,
-- irse los dos a pagar y pagar los dos: el segundo quedaba con plata tomada y una
-- orden que ya no se puede confirmar (el trigger validate_inventory_order_confirmation
-- la rechaza). Nunca hubo stock negativo, pero sí sobreventa real de cara al cliente.
--
-- Las reservas ya existían (20260801095000) pero el checkout llamaba a
-- validate_checkout_inventory_reservation con p_session_id NULL, así que nunca
-- se creaba ninguna: la validación miraba stock físico y no reservas ajenas.
--
-- MODELO
-- La reserva NO decrementa stock físico (sería una segunda representación del
-- mismo saldo, justo lo que la migración 20260801104000 vino a eliminar). Es un
-- gravamen temporal: disponible = stock derivado - reservas activas de OTRAS
-- sesiones. Por lo tanto:
--   * expirar una reserva = dejar de contarla (idempotente por construcción:
--     borrar filas ya vencidas dos veces da el mismo resultado, y nunca "suma"
--     stock de vuelta porque nunca lo restó);
--   * consumir una reserva = la orden pasa a un estado que consume stock, el
--     libro derivado incorpora la venta y el trigger release_order_stock_reservation
--     borra la reserva. El descuento ocurre exactamente una vez porque sale de
--     `orden_items`, no de un decremento acumulativo: un webhook repetido, un
--     retry o dos confirmaciones simultáneas no pueden descontar dos veces.
--
-- ATOMICIDAD
-- Todo el ciclo "leer disponible -> decidir -> insertar reserva" ocurre dentro de
-- una única función plpgsql (una sola transacción) y bajo pg_advisory_xact_lock
-- por producto, tomado en orden ascendente de product_id para no poder generar
-- deadlocks. Dos pedidos simultáneos por la última unidad se serializan: sólo uno
-- obtiene la reserva, el otro recibe CHECKOUT_STOCK_INSUFFICIENT.

begin;

-- Ventana de reserva. Tiene que cubrir TODA la ventana en la que el pago
-- todavía puede aprobarse: si la reserva venciera antes que la preferencia de
-- Mercado Pago, otro cliente podría tomar la unidad y el primer pago quedaría
-- sin poder confirmarse. Por eso vale lo mismo que
-- MERCADOPAGO_PREFERENCE_LIFETIME_MINUTES (lib/mercadopago/checkout-attempt.ts):
-- si se acorta la ventana de reserva hay que acortar también la de pago, y eso
-- es una decisión comercial (menos tiempo para pagar), no técnica.
create or replace function public.checkout_reservation_ttl()
returns interval
language sql
immutable
parallel safe
as $$
  select interval '30 minutes';
$$;

comment on function public.checkout_reservation_ttl() is
  'Duración de una reserva de checkout. Debe coincidir con MERCADOPAGO_PREFERENCE_LIFETIME_MINUTES: una reserva nunca puede vencer antes que la preferencia que todavía se puede pagar.';

revoke all on function public.checkout_reservation_ttl() from public;
grant execute on function public.checkout_reservation_ttl()
  to anon, authenticated, service_role;

-- Limpieza idempotente: borrar reservas vencidas no devuelve stock (nunca lo
-- restó), sólo deja de gravarlo. Ejecutarla N veces da exactamente el mismo
-- resultado.
create or replace function public.purge_expired_stock_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.stock_reservations reservations
  where reservations.expires_at <= now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_stock_reservations()
  from public, anon, authenticated;
grant execute on function public.purge_expired_stock_reservations()
  to service_role;

-- Disponibilidad real para una sesión: stock derivado menos lo reservado por
-- OTRAS sesiones activas. La propia sesión no se descuenta a sí misma (si no,
-- renovar/ajustar la reserva propia se rechazaría contra sí misma).
create or replace function public.available_stock_for_session(
  p_product_id bigint,
  p_variant_id bigint,
  p_conditioned_stock_id uuid,
  p_session_id text
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.available_stock_for_session(bigint, bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.available_stock_for_session(bigint, bigint, uuid, text)
  to service_role;

-- Reserva previa al pago desde el carrito (sesión sin orden todavía).
-- Idempotente por sesión: reemplaza íntegramente lo reservado por esa sesión,
-- así reintentos y cambios de carrito nunca acumulan reservas fantasma.
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
  v_available integer;
  v_expiry timestamptz := now() + public.checkout_reservation_ttl();
begin
  if length(btrim(coalesce(p_session_id, ''))) < 8
     or length(p_session_id) > 160
     or p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     -- Tope defensivo: esta función la llama directo anon/authenticated: sin
     -- límite, un payload con miles de elementos es un vector de DoS barato
     -- contra la base (cada elemento dispara un advisory lock y una fila).
     or jsonb_array_length(p_items) > 50 then
    raise exception 'RESERVATION_INVALID';
  end if;

  -- Cada línea cruda tiene que ser una cantidad positiva ANTES de agrupar:
  -- agrupar por producto/variante suma cantidades, así que una línea
  -- negativa podría compensarse con otra positiva y esconderse detrás de un
  -- total agregado que parece válido (ej. -999999 + 1000000 = 1).
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where coalesce(nullif(item ->> 'quantity', '')::integer, 0) <= 0
  ) then
    raise exception 'RESERVATION_INVALID';
  end if;

  -- Secuestro de sesión: si esta sesión ya tiene una reserva activa atada a
  -- OTRO usuario autenticado, no se pisa. La sesión anónima -> mismo usuario
  -- (login a mitad de compra) sigue permitida porque el user_id previo es
  -- null. Sólo se puede llegar acá si el session_id de otra persona se
  -- adivinó/filtró -- con crypto.randomUUID() del lado del cliente es
  -- computacionalmente inviable, pero la guarda no cuesta nada tenerla.
  if exists (
    select 1 from public.stock_reservations reservations
    where reservations.session_id = p_session_id
      and reservations.expires_at > now()
      and reservations.user_id is not null
      and reservations.user_id is distinct from auth.uid()
  ) then
    raise exception 'RESERVATION_SESSION_MISMATCH';
  end if;

  perform public.purge_expired_stock_reservations();

  -- Se bloquean también los productos que esta sesión ya tenía reservados
  -- aunque hayan salido del carrito: liberarlos es parte de la misma
  -- operación atómica.
  for v_product_id in
    select distinct product_id from (
      select coalesce(
        nullif(item ->> 'productId', '')::bigint,
        nullif(item ->> 'product_id', '')::bigint
      ) as product_id
      from jsonb_array_elements(p_items) item
      union
      select reservations.product_id
      from public.stock_reservations reservations
      where reservations.session_id = p_session_id
    ) targets
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
    order by 1, 2 nulls first, 3 nulls first
  loop
    if v_item.product_id is null or v_item.quantity <= 0
       or (v_item.variant_id is not null and v_item.conditioned_stock_id is not null) then
      raise exception 'RESERVATION_INVALID';
    end if;

    if v_item.variant_id is null and v_item.conditioned_stock_id is null
       and exists (
         select 1 from public.producto_variantes variants
         where variants.producto_id = v_item.product_id and variants.activo
       ) then
      raise exception 'CHECKOUT_VARIANT_REQUIRED';
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
      conditioned_stock_id, quantity, expires_at
    ) values (
      p_session_id, auth.uid(), v_item.product_id, v_item.variant_id,
      v_item.conditioned_stock_id, v_item.quantity, v_expiry
    );
  end loop;

  return jsonb_build_object('reserved', true, 'expires_at', v_expiry);
end;
$$;

-- Validación autoritativa al crear la orden: además de revalidar catálogo y
-- stock, CREA (o renueva) la reserva de la sesión y la ata a la orden. Antes
-- exigía que la reserva ya existiera y el checkout la llamaba con
-- p_session_id NULL, por lo que en la práctica no reservaba nada.
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

  -- Mismo secuestro de sesión que en reserve_cart_stock, pero comparado
  -- contra el dueño real de la orden (acá no hay auth.uid(): esta función la
  -- llama únicamente el service role desde el servidor).
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

  -- Se reemplaza íntegramente la reserva de la sesión: si cambió cantidad,
  -- producto o variante, lo viejo se libera en la misma transacción y no
  -- quedan reservas fantasma. Nunca toca reservas de otras sesiones.
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

    -- Se conserva el dueño real de la orden (null para compra de invitado):
    -- insertar siempre user_id null acá debilitaría el chequeo de propiedad
    -- que ya usan release_cart_stock_reservation/complete_cart_stock_reservation
    -- (`user_id is null or user_id = auth.uid()`) para una orden que sí tiene
    -- usuario autenticado.
    insert into public.stock_reservations (
      session_id, user_id, product_id, variant_id,
      conditioned_stock_id, quantity, order_id, expires_at
    ) values (
      p_session_id, v_order_user_id, v_item.product_id, v_item.variant_id,
      v_item.conditioned_stock_id, v_item.quantity, p_order_id, v_expiry
    );
    v_reserved := v_reserved + 1;
  end loop;

  -- Revalida producto/variante activos y "hace falta elegir variante" con el
  -- mismo criterio de siempre. No decrementa (el stock es derivado); el nombre
  -- se conserva por compatibilidad con el resto del esquema.
  perform public.decrement_checkout_inventory(p_items);

  return jsonb_build_object(
    'validated', true,
    'reserved', v_reserved,
    'expires_at', v_expiry
  );
end;
$$;

revoke all on function public.validate_checkout_inventory_reservation(jsonb, text, bigint)
  from public, anon, authenticated;
grant execute on function public.validate_checkout_inventory_reservation(jsonb, text, bigint)
  to service_role;
revoke all on function public.reserve_cart_stock(text, jsonb) from public;
grant execute on function public.reserve_cart_stock(text, jsonb)
  to anon, authenticated, service_role;

comment on function public.validate_checkout_inventory_reservation(jsonb, text, bigint) is
  'Valida catálogo y disponibilidad real (stock derivado menos reservas ajenas activas) y deja la reserva de la sesión atada a la orden, todo en una transacción bajo advisory lock por producto.';

commit;
