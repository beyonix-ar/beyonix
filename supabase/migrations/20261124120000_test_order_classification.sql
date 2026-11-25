-- Clasificación de compras de prueba (sólo super_admin, sólo pedidos autorizados).
--
-- Una compra de prueba es una venta real a nivel de pago y fiscalidad (cobro de
-- Mercado Pago, Factura C autorizada) que el negocio no quiere contar como
-- venta comercial: la hizo el propio equipo y la mercadería sigue en su poder.
-- Clasificarla:
--   * NO toca pago, factura, NC, reintegros ni saldo (no se cancela nada).
--   * La archiva (mismas columnas y auditoría que archive_order_admin): sale
--     del listado operativo, sigue en "Archivados" y ya no puede restaurarse.
--   * Opcionalmente reingresa al stock exactamente las unidades que el pedido
--     todavía tiene descontadas y no volvieron por otro camino (devolución,
--     liberación de entrega local o un reingreso anterior), como un ajuste de
--     inventario auditado. Nunca fija un stock absoluto: suma el delta.
--   * Las estadísticas comerciales excluyen el pedido (test_order_at).
--
-- Para que nunca sirva para esconder ventas legítimas:
--   * El rol del comprador NO alcanza. Sólo se clasifican pedidos autorizados
--     de antemano en test_order_authorizations, que sólo se escribe por
--     migración (ninguna ruta ni rol de la API puede insertar). Cada
--     autorización fija el comprador, el total, el pago y los ítems exactos
--     verificados; si el pedido real difiere en algo, no se clasifica.
--   * Esta migración autoriza únicamente BX-1019 y BX-1020 (confirmados por
--     el propietario y verificados en solo lectura el 2026-11-24).
--   * Además: super_admin, motivo (10-500), número público del pedido como
--     confirmación, comprador con cuenta interna y pedido cerrado (mismos
--     bloqueos que el archivo).
--   * "Ocultar al cliente" sólo se acepta para compras de prueba clasificadas
--     (antes cualquier pedido archivable podía ocultarse al cliente).
--   * Un pedido de prueba no se puede restaurar al listado operativo ni
--     desclasificar.
--
-- Concurrencia (todas las operaciones que pueden reingresar una unidad de un
-- ítem de pedido): recepción de devoluciones (record_order_item_return_
-- reception, que bloquea la fila de orden_items; process_claim_return_inventory
-- bloquea además el pedido), liberación de entrega local (bloquea el pedido)
-- y cancelación (actualiza el pedido). La clasificación toma, EN ESTE ORDEN y
-- ANTES de calcular nada: el pedido (FOR NO KEY UPDATE, compatible con el KEY
-- SHARE que toman las FK de las devoluciones, para no invertir el orden con la
-- recepción directa por ítem), los ítems (FOR UPDATE, por id) y recién
-- después el lock de inventario del producto (93000) antes de recalcular el
-- stock. Cualquier escritura de inventory_return_movements toma el mismo lock
-- del ítem y rechaza las unidades ya reingresadas. Todo en una transacción:
-- un error revierte clasificación, archivo, ajustes y auditoría.

alter table public.ordenes
  add column if not exists test_order_at timestamptz,
  add column if not exists test_order_by uuid,
  add column if not exists test_order_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ordenes_test_order_consistency_check') then
    alter table public.ordenes add constraint ordenes_test_order_consistency_check check (
      (test_order_at is null and test_order_by is null and test_order_reason is null)
      or (test_order_at is not null and test_order_by is not null
          and length(btrim(coalesce(test_order_reason, ''))) between 10 and 500)
    );
  end if;
end $$;

create index if not exists ordenes_test_order_at_idx on public.ordenes (test_order_at) where test_order_at is not null;

comment on column public.ordenes.test_order_at is
  'Compra de prueba interna clasificada por un super_admin: se excluye de las estadísticas comerciales. Pago y factura se conservan.';

-- Autorizaciones previas y verificables (sólo por migración).
create table if not exists public.test_order_authorizations (
  order_id bigint primary key references public.ordenes(id) on delete restrict,
  buyer_id uuid not null,
  expected_total numeric(14, 2) not null,
  expected_payment_id text,
  -- [{orderItemId, productId, variantId, quantity}] ordenado por orderItemId.
  expected_items jsonb not null check (jsonb_typeof(expected_items) = 'array' and jsonb_array_length(expected_items) > 0),
  evidence text not null check (length(btrim(evidence)) between 10 and 1000),
  created_at timestamptz not null default now()
);

alter table public.test_order_authorizations enable row level security;
revoke all on table public.test_order_authorizations from public, anon, authenticated, service_role;

comment on table public.test_order_authorizations is
  'Compras de prueba autorizadas de antemano (sólo por migración). Fijan comprador, total, pago e ítems exactos: si el pedido difiere, no se puede clasificar.';

insert into public.test_order_authorizations (order_id, buyer_id, expected_total, expected_payment_id, expected_items, evidence)
select o.id, v.buyer_id, v.expected_total, v.expected_payment_id, v.expected_items, v.evidence
from (values
  (19::bigint, '6ebd099d-2fd4-418b-b3b2-2ff212afad53'::uuid, 20::numeric, '188037020242',
    '[{"orderItemId": 26, "productId": 22, "variantId": 22, "quantity": 1}]'::jsonb,
    'BX-1019: compra de prueba del propietario confirmada por él (2026-11-24); conserva el producto. Verificado en solo lectura: comprador, ítem 26 variante 22 x1, pago MP aprobado por $20, Factura C autorizada, reclamo #8 cerrado, sin reingresos.'),
  (20::bigint, '6ebd099d-2fd4-418b-b3b2-2ff212afad53'::uuid, 100::numeric, '190138021303',
    '[{"orderItemId": 27, "productId": 22, "variantId": 22, "quantity": 1}]'::jsonb,
    'BX-1020: compra de prueba del propietario confirmada por él (2026-11-24); conserva el producto. Verificado en solo lectura: comprador, ítem 27 variante 22 x1, pago MP aprobado por $100, Factura C autorizada, sin reclamos ni reingresos.')
) as v(order_id, buyer_id, expected_total, expected_payment_id, expected_items, evidence)
join public.ordenes o on o.id = v.order_id
on conflict (order_id) do nothing;

-- Las columnas de clasificación sólo cambian desde la RPC (flag local).
create or replace function public.guard_order_test_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('beyonix.order_test_classification', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.test_order_at is not null or new.test_order_by is not null or new.test_order_reason is not null then
      raise exception 'ORDER_TEST_COLUMNS_PROTECTED';
    end if;
  elsif (new.test_order_at, new.test_order_by, new.test_order_reason)
        is distinct from (old.test_order_at, old.test_order_by, old.test_order_reason) then
    raise exception 'ORDER_TEST_COLUMNS_PROTECTED';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_order_test_columns on public.ordenes;

create trigger guard_order_test_columns
  before insert or update on public.ordenes
  for each row execute function public.guard_order_test_columns();

create or replace function public.order_test_restock_key(p_order_item_id bigint)
returns text
language sql
immutable
set search_path = public
as $$
  select 'test-order-restock:item:' || p_order_item_id::text;
$$;

-- Unidades ya reingresadas por clasificación de prueba para un ítem.
create or replace function public.order_test_restocked_quantity(p_order_item_id bigint)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(a.quantity_delta), 0)::integer
  from public.inventory_stock_adjustments a
  where a.idempotency_key = public.order_test_restock_key(p_order_item_id);
$$;

-- Qué se reingresaría por ítem: lo que el pedido descuenta hoy del stock
-- (inventory_movements, fuente única), menos lo que ya volvió físicamente
-- (devoluciones recibidas, liberaciones de entrega local) y lo ya reingresado.
-- Para decidir, la RPC lo llama DESPUÉS de bloquear pedido e ítems.
create or replace function public.order_test_restock_plan(p_order_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with items as (
    select
      i.id, i.producto_id, i.variante_id, i.cantidad, i.conditioned_stock_id,
      coalesce((
        select -sum(m.quantity_delta)
        from public.inventory_movements m
        where m.source = 'web_sale' and m.source_id = i.id::text
      ), 0)::integer as consumed,
      coalesce((
        select sum(greatest(
          coalesce(r.received_quantity, 0),
          coalesce(r.sellable_quantity, 0) + coalesce(r.discounted_quantity, 0) + coalesce(r.non_sellable_quantity, 0)))
        from public.inventory_return_movements r
        where r.order_item_id = i.id
      ), 0)::integer as returned,
      public.local_delivery_released_quantity(i.id) as released,
      public.order_test_restocked_quantity(i.id) as compensated
    from public.orden_items i
    where i.orden_id = p_order_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'orderItemId', items.id,
    'productId', items.producto_id,
    'variantId', items.variante_id,
    'productName', coalesce(p.nombre, 'Producto #' || items.producto_id::text),
    'variantName', v.nombre,
    'quantity', items.cantidad,
    'consumed', items.consumed,
    'returned', items.returned,
    'released', items.released,
    'compensated', items.compensated,
    'pending', greatest(items.consumed - items.returned - items.released - items.compensated, 0),
    'supported', items.conditioned_stock_id is null and items.variante_id is not null
  ) order by items.id), '[]'::jsonb)
  from items
  left join public.productos p on p.id = items.producto_id
  left join public.producto_variantes v on v.id = items.variante_id;
$$;

-- Lo que impide clasificar como prueba (vacío = se puede).
create or replace function public.order_test_classification_blockers(p_order_id bigint)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_authorization public.test_order_authorizations%rowtype;
  v_items jsonb;
  v_blockers text[] := array[]::text[];
  v_archive text[];
begin
  select * into v_order from public.ordenes where id = p_order_id;
  if not found then
    return array['not_found'];
  end if;
  if v_order.test_order_at is not null then
    v_blockers := array_append(v_blockers, 'already_classified');
  end if;

  -- Autorización previa y verificable: el rol del comprador no alcanza.
  select * into v_authorization from public.test_order_authorizations where order_id = p_order_id;
  if not found then
    v_blockers := array_append(v_blockers, 'not_authorized_test_order');
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'orderItemId', i.id, 'productId', i.producto_id, 'variantId', i.variante_id, 'quantity', i.cantidad
    ) order by i.id), '[]'::jsonb) into v_items
    from public.orden_items i where i.orden_id = p_order_id;
    if v_order.usuario_id is distinct from v_authorization.buyer_id
       or coalesce(v_order.total, -1) <> v_authorization.expected_total
       or (v_authorization.expected_payment_id is not null
           and v_order.payment_id is distinct from v_authorization.expected_payment_id)
       or v_items <> v_authorization.expected_items then
      v_blockers := array_append(v_blockers, 'test_authorization_mismatch');
    end if;
  end if;

  -- Además el comprador tiene que seguir siendo una cuenta interna.
  if v_order.usuario_id is null or not exists (
    select 1 from public.profiles pr
    where pr.id = v_order.usuario_id and pr.rol in ('operador', 'admin', 'super_admin')
  ) then
    v_blockers := array_append(v_blockers, 'buyer_not_internal');
  end if;

  if exists (
    select 1 from public.local_delivery_return_reservations r
    where r.order_id = p_order_id and r.status = 'active'
  ) then
    v_blockers := array_append(v_blockers, 'local_delivery_return_pending');
  end if;

  -- Mismas condiciones que el archivo (pedido cerrado, nada pendiente).
  v_archive := public.order_archive_blockers(p_order_id);
  select coalesce(array_agg(code), array[]::text[]) into v_archive
  from unnest(v_archive) code
  where code not in ('already_archived', 'not_found');
  return v_blockers || v_archive;
end;
$$;

-- Una vez reingresado el stock, el pedido ya no puede liberarlo otra vez.
create or replace function public.guard_test_order_stock_release()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.test_order_at is not null
     and public.inventory_order_consumes_stock(old.estado, old.payment_status)
     and not public.inventory_order_consumes_stock(new.estado, new.payment_status)
     and new.super_admin_stock_retained_at is null
     and exists (
       select 1 from public.orden_items i
       where i.orden_id = old.id and public.order_test_restocked_quantity(i.id) > 0
     ) then
    raise exception 'ORDER_TEST_STOCK_ALREADY_RESTORED';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_test_order_stock_release on public.ordenes;

create trigger guard_test_order_stock_release
  before update of estado, payment_status, super_admin_stock_retained_at on public.ordenes
  for each row execute function public.guard_test_order_stock_release();

-- Toda escritura de devoluciones de un ítem toma el lock del ítem (el mismo
-- que la recepción y la clasificación) y rechaza unidades ya reingresadas.
-- En UPDATE sólo actúa si cambia algo que mueve stock o el vínculo con el
-- ítem/pedido; notas y revisiones siguen permitidas.
create or replace function public.guard_test_order_return_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_ids bigint[];
begin
  if tg_op = 'UPDATE' and (
    new.order_item_id, new.order_id, new.product_id, new.variant_id, new.quantity,
    new.received_quantity, new.sellable_quantity, new.discounted_quantity, new.non_sellable_quantity
  ) is not distinct from (
    old.order_item_id, old.order_id, old.product_id, old.variant_id, old.quantity,
    old.received_quantity, old.sellable_quantity, old.discounted_quantity, old.non_sellable_quantity
  ) then
    return new;
  end if;

  select array_agg(distinct item_id order by item_id) into v_item_ids
  from unnest(array[new.order_item_id, case when tg_op = 'UPDATE' then old.order_item_id end]) item_id
  where item_id is not null;
  if v_item_ids is null then
    return new;
  end if;

  perform 1 from public.orden_items where id = any(v_item_ids) order by id for update;
  if exists (select 1 from unnest(v_item_ids) item_id where public.order_test_restocked_quantity(item_id) > 0) then
    raise exception 'ORDER_TEST_STOCK_ALREADY_RESTORED';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_test_order_return_movement on public.inventory_return_movements;

create trigger guard_test_order_return_movement
  before insert or update on public.inventory_return_movements
  for each row execute function public.guard_test_order_return_movement();

-- Archivo: "ocultar al cliente" sólo para compras de prueba clasificadas.
-- Idéntica a 20261015150000 salvo esa validación.
create or replace function public.archive_order_admin(
  p_order_id bigint,
  p_actor uuid,
  p_reason text,
  p_hide_from_customer boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_order public.ordenes%rowtype;
  v_blockers text[];
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN';
  end if;
  select rol into v_role from public.profiles where id = p_actor;
  if coalesce(v_role, '') <> 'super_admin' then
    raise exception 'ORDER_ARCHIVE_FORBIDDEN';
  end if;
  if length(v_reason) not between 5 and 500 then
    raise exception 'ORDER_ARCHIVE_REASON_REQUIRED';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if coalesce(p_hide_from_customer, false) and v_order.test_order_at is null then
    raise exception 'ORDER_ARCHIVE_HIDE_REQUIRES_TEST';
  end if;

  v_blockers := public.order_archive_blockers(p_order_id);
  if cardinality(v_blockers) > 0 then
    raise exception 'ORDER_ARCHIVE_BLOCKED:%', array_to_string(v_blockers, ',');
  end if;

  perform set_config('beyonix.order_archive', 'on', true);
  update public.ordenes
  set archived_at = now(),
      archived_by = p_actor,
      archive_reason = v_reason,
      customer_hidden_at = case when p_hide_from_customer then now() else null end
  where id = p_order_id
  returning * into v_order;
  perform set_config('beyonix.order_archive', '', true);

  insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (p_order_id, 'admin', p_actor, 'order_archived', v_order.estado, v_order.estado,
    jsonb_build_object('reason', v_reason, 'hideFromCustomer', coalesce(p_hide_from_customer, false)));

  return jsonb_build_object(
    'id', v_order.id,
    'archived_at', v_order.archived_at,
    'archived_by', v_order.archived_by,
    'archive_reason', v_order.archive_reason,
    'customer_hidden_at', v_order.customer_hidden_at
  );
end;
$$;

-- Restaurar: una compra de prueba queda archivada (no vuelve a la operación).
-- Idéntica a 20261015150000 salvo esa validación.
create or replace function public.unarchive_order_admin(
  p_order_id bigint,
  p_actor uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_order public.ordenes%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN';
  end if;
  select rol into v_role from public.profiles where id = p_actor;
  if coalesce(v_role, '') <> 'super_admin' then
    raise exception 'ORDER_ARCHIVE_FORBIDDEN';
  end if;
  if length(v_reason) not between 5 and 500 then
    raise exception 'ORDER_ARCHIVE_REASON_REQUIRED';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if v_order.archived_at is null then
    raise exception 'ORDER_NOT_ARCHIVED';
  end if;
  if v_order.test_order_at is not null then
    raise exception 'ORDER_TEST_ARCHIVE_LOCKED';
  end if;

  perform set_config('beyonix.order_archive', 'on', true);
  update public.ordenes
  set archived_at = null, archived_by = null, archive_reason = null, customer_hidden_at = null
  where id = p_order_id
  returning * into v_order;
  perform set_config('beyonix.order_archive', '', true);

  insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (p_order_id, 'admin', p_actor, 'order_unarchived', v_order.estado, v_order.estado,
    jsonb_build_object('reason', v_reason));

  return jsonb_build_object('id', v_order.id, 'archived_at', null);
end;
$$;

create or replace function public.classify_test_order_admin(
  p_order_id bigint,
  p_actor uuid,
  p_reason text,
  p_confirmation text,
  p_restock boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_order public.ordenes%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_public_id text := 'BX-' || (1000 + p_order_id)::text;
  v_archive_reason text;
  v_blockers text[];
  v_plan jsonb;
  v_item jsonb;
  v_restocked jsonb := '[]'::jsonb;
  v_was_archived boolean;
  v_key text;
  v_adjustment_id uuid;
  v_quantity integer;
  v_product_id bigint;
  v_variant_id bigint;
  v_previous_stock integer;
  v_new_stock integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN';
  end if;
  select rol into v_role from public.profiles where id = p_actor;
  if coalesce(v_role, '') <> 'super_admin' then
    raise exception 'ORDER_TEST_FORBIDDEN';
  end if;
  if length(v_reason) not between 10 and 500 then
    raise exception 'ORDER_TEST_REASON_REQUIRED';
  end if;
  if p_restock is null then
    raise exception 'ORDER_TEST_RESTOCK_CHOICE_REQUIRED';
  end if;

  -- 1) Pedido (NO KEY UPDATE: compatible con el KEY SHARE de las FK de una
  --    recepción en curso, que ya tiene el ítem) y 2) sus ítems, por id.
  select * into v_order from public.ordenes where id = p_order_id for no key update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  perform 1 from public.orden_items where orden_id = p_order_id order by id for update;

  -- Reintento o carrera: ya clasificado por otro llamado, no se repite nada.
  if v_order.test_order_at is not null then
    return jsonb_build_object(
      'id', v_order.id,
      'alreadyClassified', true,
      'test_order_at', v_order.test_order_at,
      'test_order_by', v_order.test_order_by,
      'test_order_reason', v_order.test_order_reason,
      'archived_at', v_order.archived_at,
      'archived_by', v_order.archived_by,
      'archive_reason', v_order.archive_reason,
      'customer_hidden_at', v_order.customer_hidden_at,
      'restocked', '[]'::jsonb
    );
  end if;

  if upper(btrim(coalesce(p_confirmation, ''))) <> v_public_id then
    raise exception 'ORDER_TEST_CONFIRMATION_MISMATCH';
  end if;

  -- Todo se evalúa ya con pedido e ítems bloqueados.
  v_blockers := public.order_test_classification_blockers(p_order_id);
  if cardinality(v_blockers) > 0 then
    raise exception 'ORDER_TEST_BLOCKED:%', array_to_string(v_blockers, ',');
  end if;

  v_plan := public.order_test_restock_plan(p_order_id);
  if p_restock and exists (
    select 1 from jsonb_array_elements(v_plan) e
    where (e->>'pending')::integer > 0 and not (e->>'supported')::boolean
  ) then
    raise exception 'ORDER_TEST_RESTOCK_UNSUPPORTED';
  end if;

  perform set_config('beyonix.order_test_classification', 'on', true);
  update public.ordenes
  set test_order_at = now(), test_order_by = p_actor, test_order_reason = v_reason
  where id = p_order_id;
  perform set_config('beyonix.order_test_classification', '', true);

  -- Archivo en la misma fila ya bloqueada (mismas columnas y evento que
  -- archive_order_admin, sin pedir un FOR UPDATE que choque con el KEY SHARE
  -- de una recepción en espera).
  v_was_archived := v_order.archived_at is not null;
  if not v_was_archived then
    v_archive_reason := left('Pedido de prueba: ' || v_reason, 500);
    perform set_config('beyonix.order_archive', 'on', true);
    update public.ordenes
    set archived_at = now(), archived_by = p_actor, archive_reason = v_archive_reason, customer_hidden_at = null
    where id = p_order_id;
    perform set_config('beyonix.order_archive', '', true);
    insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
    values (p_order_id, 'admin', p_actor, 'order_archived', v_order.estado, v_order.estado,
      jsonb_build_object('reason', v_archive_reason, 'hideFromCustomer', false));
  end if;

  if p_restock then
    perform set_config('beyonix.actor_id', p_actor::text, true);
    for v_item in
      select e from jsonb_array_elements(v_plan) e
      where (e->>'pending')::integer > 0
      order by (e->>'productId')::bigint, (e->>'orderItemId')::bigint
    loop
      v_quantity := (v_item->>'pending')::integer;
      v_product_id := (v_item->>'productId')::bigint;
      v_variant_id := (v_item->>'variantId')::bigint;
      v_key := public.order_test_restock_key((v_item->>'orderItemId')::bigint);

      -- Mismo orden que checkout y recálculo: lock de producto, luego filas.
      perform pg_advisory_xact_lock(93000, v_product_id::integer);
      select coalesce(stock, 0) into v_previous_stock from public.producto_variantes where id = v_variant_id;

      v_adjustment_id := null;
      insert into public.inventory_stock_adjustments (
        product_id, variant_id, quantity_delta, reason, created_by, idempotency_key
      ) values (
        v_product_id, v_variant_id, v_quantity,
        left('Compra de prueba ' || v_public_id || ': ' || v_reason, 300),
        p_actor, v_key
      )
      on conflict (idempotency_key) do nothing
      returning id into v_adjustment_id;

      if v_adjustment_id is null then
        continue;
      end if;

      perform public.refresh_inventory_stock(v_product_id);
      select coalesce(stock, 0) into v_new_stock from public.producto_variantes where id = v_variant_id;

      insert into public.inventory_operation_log (
        product_id, variant_id, movement_type, quantity, origin, effective_at,
        actor_user_id, actor_process, idempotency_key, source_table, source_id,
        document_reference, metadata
      ) values (
        v_product_id, v_variant_id, 'adjustment', v_quantity, 'test_order_restock', now(),
        p_actor, 'classify_test_order_admin', v_key, 'inventory_stock_adjustments',
        v_adjustment_id::text, 'order:' || p_order_id::text,
        jsonb_build_object(
          'orderId', p_order_id,
          'orderItemId', (v_item->>'orderItemId')::bigint,
          'previousStock', v_previous_stock,
          'newStock', v_new_stock,
          'delta', v_quantity
        )
      ) on conflict (idempotency_key) do nothing;

      v_restocked := v_restocked || jsonb_build_array(jsonb_build_object(
        'orderItemId', (v_item->>'orderItemId')::bigint,
        'productId', v_product_id,
        'variantId', v_variant_id,
        'quantity', v_quantity,
        'previousStock', v_previous_stock,
        'newStock', v_new_stock
      ));
    end loop;
  end if;

  insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (p_order_id, 'admin', p_actor, 'order_classified_as_test', v_order.estado, v_order.estado,
    jsonb_build_object(
      'reason', v_reason,
      'restockRequested', p_restock,
      'restocked', v_restocked,
      'archivedNow', not v_was_archived,
      'plan', v_plan
    ));

  select * into v_order from public.ordenes where id = p_order_id;
  return jsonb_build_object(
    'id', v_order.id,
    'alreadyClassified', false,
    'test_order_at', v_order.test_order_at,
    'test_order_by', v_order.test_order_by,
    'test_order_reason', v_order.test_order_reason,
    'archived_at', v_order.archived_at,
    'archived_by', v_order.archived_by,
    'archive_reason', v_order.archive_reason,
    'customer_hidden_at', v_order.customer_hidden_at,
    'restocked', v_restocked
  );
end;
$$;

-- Ajuste manual de stock: idéntica a 20260821200000 salvo el orden de locks
-- (lock de inventario del producto antes que la fila de la variante).
create or replace function public.adjust_variant_stock_idempotent(
  p_variant_id bigint,
  p_new_quantity integer,
  p_reason text,
  p_actor_id uuid,
  p_idempotency_key text
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_delta integer;
  v_product_id bigint;
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

  -- Mismo orden que checkout y refresh_inventory_stock: primero el lock de
  -- inventario del producto, después la fila de la variante (antes era al
  -- revés y podía cruzarse en deadlock con cualquier recálculo concurrente).
  select producto_id into v_product_id
  from public.producto_variantes
  where id = p_variant_id;
  if not found then
    raise exception 'La variante ya no existe.';
  end if;

  perform pg_advisory_xact_lock(93000, v_product_id::integer);

  select * into v_variant
  from public.producto_variantes
  where id = p_variant_id
  for update;
  if not found or v_variant.producto_id <> v_product_id then
    raise exception 'La variante ya no existe.';
  end if;

  v_delta := p_new_quantity - coalesce(v_variant.stock, 0);
  if v_delta = 0 then
    return v_variant;
  end if;

  insert into public.inventory_stock_adjustments (
    product_id, variant_id, quantity_delta, reason, created_by, idempotency_key
  ) values (
    v_variant.producto_id, p_variant_id, v_delta, v_reason, p_actor_id, v_key
  );

  -- Identifica al actor de la operación para el trigger genérico de
  -- auditoría (mismo patrón que el resto de las funciones RPC atómicas de
  -- Productos, ver update_product_variant_metadata_atomic y afines).
  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  perform public.refresh_inventory_stock(v_variant.producto_id);

  -- Adjunta motivo y delta a la fila de auditoría que el trigger genérico
  -- acaba de insertar para esta variante (misma transacción, mismo lock),
  -- sin tocar antes/después originales.
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
$$;

revoke all on function public.adjust_variant_stock_idempotent(bigint, integer, text, uuid, text) from public, anon, authenticated;
grant execute on function public.adjust_variant_stock_idempotent(bigint, integer, text, uuid, text) to service_role;

revoke all on function public.guard_order_test_columns() from public, anon, authenticated;
revoke all on function public.guard_test_order_stock_release() from public, anon, authenticated;
revoke all on function public.guard_test_order_return_movement() from public, anon, authenticated;
revoke all on function public.order_test_restock_key(bigint) from public, anon, authenticated;
revoke all on function public.order_test_restocked_quantity(bigint) from public, anon, authenticated;
revoke all on function public.order_test_restock_plan(bigint) from public, anon, authenticated;
revoke all on function public.order_test_classification_blockers(bigint) from public, anon, authenticated;
revoke all on function public.classify_test_order_admin(bigint, uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.archive_order_admin(bigint, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.unarchive_order_admin(bigint, uuid, text) from public, anon, authenticated;

grant execute on function public.order_test_restock_plan(bigint) to service_role;
grant execute on function public.order_test_classification_blockers(bigint) to service_role;
grant execute on function public.classify_test_order_admin(bigint, uuid, text, text, boolean) to service_role;
grant execute on function public.archive_order_admin(bigint, uuid, text, boolean) to service_role;
grant execute on function public.unarchive_order_admin(bigint, uuid, text) to service_role;

comment on function public.classify_test_order_admin(bigint, uuid, text, text, boolean) is
  'Super admin: clasifica una compra autorizada en test_order_authorizations como prueba (fuera de estadísticas), la archiva y opcionalmente reingresa las unidades pendientes. No toca pago ni factura.';
