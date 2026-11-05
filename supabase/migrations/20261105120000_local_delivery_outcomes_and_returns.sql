-- Envío BEYONIX: resultado de la entrega por QR, retorno local y reserva ----------
-- Módulo nuevo, separado del rollout de etiquetas/aislamiento de proveedor
-- (A 20261103120000, B 20261103130000, C 20261104120000). REQUIERE C aplicada
-- (public.order_is_local_delivery normalizado).
--
-- Orden de despliegue: ESTA migración primero, después el código. Es
-- compatible con el código ya desplegado:
--   * agrega tablas y RPC nuevas que el código anterior no usa;
--   * la guarda nueva sobre ordenes.estado sólo rechaza "Entregado" cuando el
--     pedido local está Regresando/Devuelto a BEYONIX, estado al que sólo se
--     llega con el código nuevo (sin filas en local_delivery_shipments, el
--     código anterior se comporta exactamente igual);
--   * el libro de inventario suma una rama que sólo tiene filas con reservas
--     vencidas (no existen hasta que el código nuevo las cree).
--
-- Modelo:
-- 1. local_delivery_shipments: una fila por entrega local de un pedido (hoy
--    una; shipment_number deja lugar a un nuevo envío). Lleva el token del QR
--    (aleatorio, 128 bits, nunca derivado del id) y el resultado operativo:
--      pending              → sin resultado del cadete (Preparando/En camino
--                             salen de ordenes.estado, que NO cambia);
--      first_attempt_failed → 1.er intento fallido (cliente ausente);
--      incident             → problema reportado, a revisar por Admin;
--      returning            → 2.º ausente (o decisión de Admin): vuelve a BEYONIX;
--      returned             → recibido físicamente (todos los bultos);
--      delivered            → entregado (cadete o Admin, misma lógica canónica).
--    ordenes.estado sigue en 'en_camino' durante intentos, incidencia y
--    retorno: no se usan estados Andreani (visita_fallida, en_devolucion,
--    devuelto_beyonix) ni la lista fija de ordenes_estado_check cambia.
-- 2. Guardas sobre ordenes: "Entregado" imposible con el pedido Regresando o
--    Devuelto (cualquier camino de escritura), y sincronización del resultado
--    'delivered' en la misma transacción. Cancelar el pedido cancela su reserva.
-- 3. Recepción física (picking inverso): cada BX-PKG del intento vigente se
--    escanea una vez; recién con TODOS se marca Devuelto y empieza la reserva.
-- 4. Reserva: los artículos de un pedido pagado YA están descontados del
--    stock (rama web_sale del libro); la reserva no crea un segundo inventario
--    ni usa stock_reservations (que se purga y se libera al pagar). Es el
--    registro de ciclo de vida (active/consumed/expired/cancelled) con la
--    cantidad de días y el vencimiento congelados al empezar. Al vencer, la
--    rama local_delivery_return_release del libro devuelve las unidades al
--    stock vendible, sólo mientras el pedido siga consumiendo stock (si después
--    se cancela, la venta y la liberación desaparecen juntas: nunca dos veces).
-- 5. Vencimiento: días calendario en America/Argentina/Buenos_Aires, a las
--    00:00 del día siguiente al último día cubierto.

begin;

-- 1. Entregas locales y token del QR ---------------------------------------------
create table if not exists public.local_delivery_shipments (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.ordenes(id) on delete cascade,
  shipment_number integer not null default 1 check (shipment_number >= 1),
  access_token text not null unique check (access_token ~ '^[A-Za-z0-9_-]{22,64}$'),
  token_revoked_at timestamptz,
  outcome_status text not null default 'pending' check (outcome_status in
    ('pending', 'first_attempt_failed', 'incident', 'returning', 'returned', 'delivered')),
  failed_attempts smallint not null default 0 check (failed_attempts between 0 and 2),
  first_attempt_failed_at timestamptz,
  second_attempt_failed_at timestamptz,
  incident_reason text check (incident_reason in ('wrong_address', 'no_access', 'rejected', 'other')),
  incident_comment text check (char_length(incident_comment) <= 280),
  incident_at timestamptz,
  delivered_at timestamptz,
  returning_at timestamptz,
  returned_at timestamptz,
  returned_by uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint local_delivery_shipments_number_unique unique (order_id, shipment_number),
  constraint local_delivery_shipments_attempts_check check (
    (failed_attempts >= 1) = (first_attempt_failed_at is not null)
    and (failed_attempts = 2) = (second_attempt_failed_at is not null)),
  constraint local_delivery_shipments_incident_check check (
    (outcome_status <> 'incident' or (incident_reason is not null and incident_at is not null))
    and (incident_reason is distinct from 'other' or nullif(btrim(incident_comment), '') is not null)),
  constraint local_delivery_shipments_return_check check (
    (outcome_status not in ('returning', 'returned') or returning_at is not null)
    and (outcome_status <> 'returned' or (returned_at is not null and returned_by is not null))
    and (failed_attempts < 2 or outcome_status in ('returning', 'returned'))),
  constraint local_delivery_shipments_delivered_check check (
    outcome_status <> 'delivered' or delivered_at is not null)
);
create index if not exists local_delivery_shipments_outcome_idx
  on public.local_delivery_shipments (outcome_status) where outcome_status <> 'delivered';

-- 3. Recepción física de cada bulto que vuelve -----------------------------------
create table if not exists public.local_delivery_return_receipts (
  id bigint generated always as identity primary key,
  shipment_id bigint not null references public.local_delivery_shipments(id) on delete cascade,
  parcel_id bigint not null references public.order_package_parcels(id),
  barcode text not null,
  received_at timestamptz not null default now(),
  received_by uuid not null,
  constraint local_delivery_return_receipts_unique unique (shipment_id, parcel_id)
);

-- 4. Reserva por retorno ---------------------------------------------------------
create table if not exists public.local_delivery_return_reservations (
  id bigint generated always as identity primary key,
  shipment_id bigint not null unique references public.local_delivery_shipments(id) on delete cascade,
  order_id bigint not null references public.ordenes(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'consumed', 'expired', 'cancelled')),
  reservation_days integer not null check (reservation_days between 1 and 30),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid,
  expired_at timestamptz,
  cancelled_at timestamptz,
  cancelled_reason text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint local_delivery_return_reservations_window_check check (expires_at > starts_at),
  constraint local_delivery_return_reservations_state_check check (
    (status = 'consumed') = (consumed_at is not null)
    and (status = 'expired') = (expired_at is not null)
    and (status = 'cancelled') = (cancelled_at is not null))
);
create unique index if not exists local_delivery_return_reservations_one_active
  on public.local_delivery_return_reservations (order_id) where status = 'active';
create index if not exists local_delivery_return_reservations_due_idx
  on public.local_delivery_return_reservations (expires_at) where status = 'active';

create table if not exists public.local_delivery_return_reservation_items (
  id bigint generated always as identity primary key,
  reservation_id bigint not null references public.local_delivery_return_reservations(id) on delete cascade,
  order_item_id bigint not null references public.orden_items(id) on delete cascade,
  product_id bigint not null,
  variant_id bigint,
  conditioned_stock_id uuid,
  quantity integer not null check (quantity > 0),
  constraint local_delivery_return_reservation_items_unique unique (reservation_id, order_item_id)
);
create index if not exists local_delivery_return_reservation_items_item_idx
  on public.local_delivery_return_reservation_items (order_item_id);

alter table public.local_delivery_shipments enable row level security;
alter table public.local_delivery_return_receipts enable row level security;
alter table public.local_delivery_return_reservations enable row level security;
alter table public.local_delivery_return_reservation_items enable row level security;
revoke all on public.local_delivery_shipments, public.local_delivery_return_receipts,
  public.local_delivery_return_reservations, public.local_delivery_return_reservation_items
  from public, anon, authenticated;
grant select, insert, update on public.local_delivery_shipments, public.local_delivery_return_receipts,
  public.local_delivery_return_reservations, public.local_delivery_return_reservation_items
  to service_role;

-- Utilidades ---------------------------------------------------------------------
/** Vencimiento: N días calendario completos después del día de recepción, a las 00:00 (hora de BEYONIX). */
create or replace function public.local_delivery_reservation_expiry(p_received_at timestamptz, p_days integer)
returns timestamptz language sql immutable
set search_path = pg_catalog, public, pg_temp as $$
  select (((p_received_at at time zone 'America/Argentina/Buenos_Aires')::date + p_days + 1)::timestamp)
    at time zone 'America/Argentina/Buenos_Aires'
$$;

/** Entrega local vigente (la de mayor número) de un pedido. */
create or replace function public.local_delivery_current_shipment_id(p_order_id bigint)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select s.id from public.local_delivery_shipments s
  where s.order_id = p_order_id order by s.shipment_number desc limit 1
$$;

/** Unidades del ítem liberadas al stock por una reserva de retorno vencida. */
create or replace function public.local_delivery_released_quantity(p_order_item_id bigint)
returns integer language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(sum(i.quantity), 0)::integer
  from public.local_delivery_return_reservation_items i
  join public.local_delivery_return_reservations r on r.id = i.reservation_id
  where i.order_item_id = p_order_item_id and r.status = 'expired'
$$;

create or replace function public.local_delivery_audit(
  p_order_id bigint, p_actor_type text, p_actor_id uuid, p_action text, p_metadata jsonb)
returns void language sql security definer
set search_path = pg_catalog, public, pg_temp as $$
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
  values (p_order_id, p_actor_type, p_actor_id, p_action,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('shippingProvider', 'beyonix'))
$$;

-- Token del QR: lo crea (o devuelve el vigente) la generación de etiquetas.
-- El token lo genera el servidor (crypto aleatorio); acá sólo se valida y se
-- persiste. Reimprimir devuelve el mismo token: todas las etiquetas del pedido
-- (un QR por pedido, un BX-PKG por bulto) siguen funcionando.
create or replace function public.ensure_local_delivery_shipment(
  p_order_id bigint, p_actor_id uuid, p_token text)
returns text language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order public.ordenes%rowtype;
  v_shipment public.local_delivery_shipments%rowtype;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  if not public.order_is_local_delivery(v_order) then raise exception 'DISPATCH_LOCAL_DELIVERY_ONLY'; end if;
  if v_order.estado = 'cancelado' or v_order.cancelled_at is not null then
    raise exception 'LOCAL_DELIVERY_LABEL_ORDER_CANCELLED';
  end if;
  select * into v_shipment from public.local_delivery_shipments
    where id = public.local_delivery_current_shipment_id(p_order_id) for update;
  if found and v_shipment.token_revoked_at is null then return v_shipment.access_token; end if;
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{22,64}$' then raise exception 'LOCAL_DELIVERY_TOKEN_INVALID'; end if;
  if found then
    -- Token revocado: se rota sobre la misma entrega (mismo resultado e intentos).
    update public.local_delivery_shipments set access_token = p_token, token_revoked_at = null, updated_at = now()
      where id = v_shipment.id;
  else
    insert into public.local_delivery_shipments(order_id, access_token, created_by)
      values (p_order_id, p_token, p_actor_id);
  end if;
  return p_token;
end $$;

-- Resultado del cadete (sin login: el token ES la autorización, limitada a
-- este pedido y a estas transiciones). Ausente/Problema. Entregado usa la RPC
-- de abajo + los efectos canónicos del servicio.
-- p_expected_attempts = intentos fallidos que el cadete VIO en pantalla: un
-- doble toque o dos escaneos simultáneos nunca cuentan como dos intentos (el
-- segundo encuentra otro valor y no cambia nada).
create or replace function public.record_local_delivery_courier_outcome(
  p_token text, p_outcome text, p_expected_attempts integer,
  p_reason text default null, p_comment text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order_id bigint;
  v_order public.ordenes%rowtype;
  v_shipment public.local_delivery_shipments%rowtype;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_result text;
begin
  if p_outcome not in ('absent', 'incident') then raise exception 'LOCAL_DELIVERY_OUTCOME_INVALID'; end if;
  if p_outcome = 'incident' and (p_reason is null or p_reason not in ('wrong_address', 'no_access', 'rejected', 'other')) then
    raise exception 'LOCAL_DELIVERY_OUTCOME_INVALID';
  end if;
  if p_outcome = 'incident' and p_reason = 'other' and v_comment is null then raise exception 'LOCAL_DELIVERY_COMMENT_REQUIRED'; end if;
  if v_comment is not null and char_length(v_comment) > 280 then raise exception 'LOCAL_DELIVERY_OUTCOME_INVALID'; end if;
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{22,64}$' then raise exception 'LOCAL_DELIVERY_TOKEN_INVALID'; end if;

  select order_id into v_order_id from public.local_delivery_shipments
    where access_token = p_token and token_revoked_at is null;
  if not found then raise exception 'LOCAL_DELIVERY_TOKEN_INVALID'; end if;
  -- Mismo orden de locks que el resto del circuito: pedido → entrega.
  select * into v_order from public.ordenes where id = v_order_id for update;
  select * into v_shipment from public.local_delivery_shipments
    where access_token = p_token and token_revoked_at is null for update;
  if not found or v_shipment.id is distinct from public.local_delivery_current_shipment_id(v_order_id) then
    raise exception 'LOCAL_DELIVERY_TOKEN_INVALID';
  end if;

  if not public.order_is_local_delivery(v_order) then raise exception 'LOCAL_DELIVERY_TOKEN_INVALID'; end if;
  if v_order.estado = 'cancelado' or v_order.cancelled_at is not null
     or coalesce(v_order.financial_status, '') in ('cancellation_requested', 'refund_pending', 'refunded', 'cancelled') then
    v_result := 'cancelled';
  elsif v_order.estado = 'entregado' or v_shipment.outcome_status = 'delivered' then
    v_result := 'already_delivered';
  elsif v_order.estado is distinct from 'en_camino' then
    v_result := 'not_in_transit';
  elsif p_outcome = 'absent' and (v_shipment.failed_attempts >= 2 or v_shipment.outcome_status in ('returning', 'returned')) then
    -- No existe un tercer intento: después del segundo ausente se rechaza (la app responde 409).
    v_result := 'max_attempts';
  elsif v_shipment.failed_attempts <> coalesce(p_expected_attempts, -1)
        or v_shipment.outcome_status not in ('pending', 'first_attempt_failed') then
    -- Ya registrado por otro toque/escaneo, o estado terminal para el cadete.
    v_result := 'unchanged';
  elsif p_outcome = 'incident' then
    update public.local_delivery_shipments set outcome_status = 'incident', incident_reason = p_reason,
      incident_comment = v_comment, incident_at = now(), updated_at = now()
      where id = v_shipment.id returning * into v_shipment;
    perform public.local_delivery_audit(v_order.id, 'courier', null, 'local_delivery_incident_reported',
      jsonb_build_object('shipmentId', v_shipment.id, 'reason', p_reason, 'comment', v_comment,
        'failedAttempts', v_shipment.failed_attempts, 'via', 'qr'));
    v_result := 'incident';
  elsif v_shipment.failed_attempts = 0 then
    update public.local_delivery_shipments set outcome_status = 'first_attempt_failed', failed_attempts = 1,
      first_attempt_failed_at = now(), updated_at = now()
      where id = v_shipment.id returning * into v_shipment;
    perform public.local_delivery_audit(v_order.id, 'courier', null, 'local_delivery_attempt_failed',
      jsonb_build_object('shipmentId', v_shipment.id, 'attempt', 1, 'reason', 'customer_absent', 'via', 'qr'));
    v_result := 'first_attempt_failed';
  else
    -- Segundo ausente: no hay tercer intento, vuelve a BEYONIX.
    update public.local_delivery_shipments set outcome_status = 'returning', failed_attempts = 2,
      second_attempt_failed_at = now(), returning_at = now(), updated_at = now()
      where id = v_shipment.id returning * into v_shipment;
    perform public.local_delivery_audit(v_order.id, 'courier', null, 'local_delivery_attempt_failed',
      jsonb_build_object('shipmentId', v_shipment.id, 'attempt', 2, 'reason', 'customer_absent', 'via', 'qr'));
    perform public.local_delivery_audit(v_order.id, 'courier', null, 'local_delivery_return_started',
      jsonb_build_object('shipmentId', v_shipment.id, 'reason', 'second_attempt_failed'));
    v_result := 'returning';
  end if;

  return jsonb_build_object('orderId', v_order.id, 'result', v_result,
    'changed', v_result in ('incident', 'first_attempt_failed', 'returning'),
    'outcomeStatus', v_shipment.outcome_status, 'failedAttempts', v_shipment.failed_attempts,
    'estado', v_order.estado);
end $$;

-- Entregado por el cadete: misma transición que Admin (En camino → Entregado,
-- pago confirmado, sin cancelación ni cambio pendiente), bajo el lock del
-- pedido y de la entrega, y sólo si el cadete todavía puede informar un
-- resultado (pendiente o tras el 1.er intento fallido). Sin fila => conflicto.
-- Los efectos (garantía, costo logístico, historial, email) los ejecuta el
-- servicio canónico de la aplicación sobre la fila devuelta.
create or replace function public.mark_local_delivery_delivered_by_courier(p_token text)
returns setof public.ordenes language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order_id bigint;
  v_order public.ordenes%rowtype;
  v_shipment public.local_delivery_shipments%rowtype;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{22,64}$' then return; end if;
  select order_id into v_order_id from public.local_delivery_shipments
    where access_token = p_token and token_revoked_at is null;
  if not found then return; end if;
  select * into v_order from public.ordenes where id = v_order_id for update;
  select * into v_shipment from public.local_delivery_shipments
    where access_token = p_token and token_revoked_at is null for update;
  if not found or v_shipment.id is distinct from public.local_delivery_current_shipment_id(v_order_id)
     or v_shipment.outcome_status not in ('pending', 'first_attempt_failed')
     or not public.order_is_local_delivery(v_order)
     or v_order.estado is distinct from 'en_camino'
     or v_order.cancelled_at is not null
     or v_order.financial_status is distinct from 'payment_confirmed'
     or v_order.paid_at is null
     or coalesce(v_order.payment_confirmed_amount, 0) <= 0
     or coalesce(v_order.payment_status, '') not in ('confirmado', 'approved', 'confirmed')
     or coalesce(v_order.order_change_status, '') in ('change_requested', 'extra_payment_pending') then
    return;
  end if;
  return query update public.ordenes set estado = 'entregado', delivered_at = now()
    where id = v_order_id returning *;
end $$;

-- 2. Guardas sobre ordenes -------------------------------------------------------
create or replace function public.guard_local_delivery_outcome()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_outcome text;
begin
  if new.estado = 'entregado' and old.estado is distinct from 'entregado'
     and public.order_is_local_delivery(new) then
    select outcome_status into v_outcome from public.local_delivery_shipments
      where id = public.local_delivery_current_shipment_id(new.id);
    if v_outcome in ('returning', 'returned') then
      raise exception 'LOCAL_DELIVERY_RETURN_IN_PROGRESS';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_local_delivery_outcome on public.ordenes;
create trigger guard_local_delivery_outcome before update of estado on public.ordenes
  for each row execute function public.guard_local_delivery_outcome();

-- Pedido cancelado que YA volvió físicamente a BEYONIX: la cancelación abre la
-- retención física de Despachos (capture_prepared_order_stock_hold), que
-- normalmente se resuelve escaneando otra vez el pedido. Si TODOS los bultos
-- del intento retenido ya figuran en local_delivery_return_receipts, esa
-- recepción es la evidencia física: se resuelve la retención con los mismos
-- efectos que resolve_cancelled_order_preparation (stock, bloqueos, historial),
-- sin pedir un segundo escaneo ni crear otra recepción. Idempotente: sin
-- retención activa, sin entrega 'returned' o con bultos faltantes no hace nada.
create or replace function public.local_delivery_resolve_return_hold(p_order_id bigint)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_shipment public.local_delivery_shipments%rowtype;
  v_hold public.order_cancellation_holds%rowtype;
  v_expected integer;
  v_received integer;
  v_product_id bigint;
begin
  select * into v_shipment from public.local_delivery_shipments
    where id = public.local_delivery_current_shipment_id(p_order_id);
  if not found or v_shipment.outcome_status <> 'returned' then return false; end if;
  select * into v_hold from public.order_cancellation_holds
    where order_id = p_order_id and resolved_at is null for update;
  if not found then return false; end if;
  select k.parcel_count into v_expected from public.order_packages k
    where k.id = v_hold.package_id and k.attempt_number = v_hold.attempt_number;
  select count(*) into v_received from public.local_delivery_return_receipts r
    join public.order_package_parcels p on p.id = r.parcel_id
    where r.shipment_id = v_shipment.id and p.package_id = v_hold.package_id
      and p.attempt_number = v_hold.attempt_number and p.parcel_count = v_expected;
  if v_expected is null or v_received < v_expected then return false; end if;

  update public.order_cancellation_holds set resolved_at = now(), resolved_by = v_shipment.returned_by,
      resolution_request_key = gen_random_uuid(), resolution_code = 'LOCAL-RETURN-RECEIVED'
    where id = v_hold.id returning * into v_hold;
  for v_product_id in
    select distinct (item->>'productId')::bigint from jsonb_array_elements(v_hold.items) item order by 1
  loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;
  perform public.sync_dispatch_blocks(p_order_id);
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
    values (p_order_id, 'system', null, 'dispatch_cancellation_physically_resolved',
      'requires_physical_resolution', 'physically_returned',
      jsonb_build_object('holdId', v_hold.id, 'code', 'LOCAL-RETURN-RECEIVED', 'source', 'local_delivery_return_receipts',
        'shipmentId', v_shipment.id, 'receivedBy', v_shipment.returned_by, 'receivedAt', v_shipment.returned_at,
        'pickedUnits', v_hold.picked_units, 'prepared', v_hold.prepared, 'financial', 'manual_refund_required',
        'shippingProvider', 'beyonix')),
      (p_order_id, 'system', null, 'dispatch_cancellation_stock_restored', 'stock_held', 'stock_restored',
      jsonb_build_object('holdId', v_hold.id, 'units', v_hold.units, 'items', v_hold.items, 'shippingProvider', 'beyonix'));
  return true;
end $$;

create or replace function public.sync_local_delivery_outcome()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_reservation public.local_delivery_return_reservations%rowtype;
begin
  if not public.order_is_local_delivery(new) then return null; end if;
  if new.estado = 'entregado' and old.estado is distinct from 'entregado' then
    update public.local_delivery_shipments
      set outcome_status = 'delivered', delivered_at = coalesce(new.delivered_at, now()), updated_at = now()
      where id = public.local_delivery_current_shipment_id(new.id)
        and outcome_status in ('pending', 'first_attempt_failed', 'incident');
  end if;
  if (new.estado = 'cancelado' or new.cancelled_at is not null)
     and not (old.estado = 'cancelado' or old.cancelled_at is not null) then
    for v_reservation in
      update public.local_delivery_return_reservations
        set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'order_cancelled'
        where order_id = new.id and status = 'active' returning *
    loop
      perform public.local_delivery_audit(new.id, 'system', null, 'local_delivery_return_reservation_cancelled',
        jsonb_build_object('reservationId', v_reservation.id, 'reason', 'order_cancelled'));
    end loop;
  end if;
  -- Corre después de capture_prepared_order_stock_hold (orden alfabético de
  -- triggers AFTER): si la cancelación abrió una retención y el pedido ya
  -- volvió con todos sus bultos, se resuelve con esa recepción.
  if new.estado = 'cancelado' or new.cancelled_at is not null then
    perform public.local_delivery_resolve_return_hold(new.id);
  end if;
  return null;
end $$;
drop trigger if exists sync_local_delivery_outcome on public.ordenes;
create trigger sync_local_delivery_outcome after update of estado, cancelled_at, payment_status on public.ordenes
  for each row execute function public.sync_local_delivery_outcome();

-- Incidencia: Admin decide reintentar la entrega o traer el pedido de vuelta.
-- (Marcarlo entregado es la acción canónica de siempre: Entregas locales.)
create or replace function public.resolve_local_delivery_incident(
  p_order_id bigint, p_actor_id uuid, p_resolution text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order public.ordenes%rowtype;
  v_shipment public.local_delivery_shipments%rowtype;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_resolution not in ('retry', 'return') then raise exception 'LOCAL_DELIVERY_OUTCOME_INVALID'; end if;
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  select * into v_shipment from public.local_delivery_shipments
    where id = public.local_delivery_current_shipment_id(p_order_id) for update;
  if not found or v_shipment.outcome_status <> 'incident' or v_order.estado is distinct from 'en_camino' then
    raise exception 'LOCAL_DELIVERY_STATE_CHANGED';
  end if;
  if p_resolution = 'retry' then
    update public.local_delivery_shipments set
      outcome_status = case when failed_attempts = 0 then 'pending' else 'first_attempt_failed' end,
      incident_reason = null, incident_comment = null, incident_at = null, updated_at = now()
      where id = v_shipment.id returning * into v_shipment;
  else
    update public.local_delivery_shipments set outcome_status = 'returning', returning_at = now(), updated_at = now()
      where id = v_shipment.id returning * into v_shipment;
    perform public.local_delivery_audit(p_order_id, 'admin', p_actor_id, 'local_delivery_return_started',
      jsonb_build_object('shipmentId', v_shipment.id, 'reason', 'incident'));
  end if;
  perform public.local_delivery_audit(p_order_id, 'admin', p_actor_id, 'local_delivery_incident_resolved',
    jsonb_build_object('shipmentId', v_shipment.id, 'resolution', p_resolution));
  return jsonb_build_object('orderId', p_order_id, 'outcomeStatus', v_shipment.outcome_status,
    'failedAttempts', v_shipment.failed_attempts);
end $$;

-- 3. Recepción física (picking inverso) ------------------------------------------
-- Escanear el BX-PKG que volvió. Releer el mismo es idempotente. Sólo valen
-- los bultos del intento que salió (el que se confirmó antes de En camino).
-- Con el último bulto: Devuelto a BEYONIX + reserva (días de la configuración
-- vigente, congelados en la reserva junto con su vencimiento).
create or replace function public.receive_local_delivery_return_parcel(
  p_code text, p_actor_id uuid, p_reservation_days integer)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_parcel public.order_package_parcels%rowtype;
  v_order public.ordenes%rowtype;
  v_package public.order_packages%rowtype;
  v_shipment public.local_delivery_shipments%rowtype;
  v_reservation public.local_delivery_return_reservations%rowtype;
  v_inserted integer;
  v_received integer;
  v_complete boolean := false;
  v_now timestamptz := now();
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if v_code = '' or length(v_code) > 128 then raise exception 'DISPATCH_LABEL_CODE_INVALID'; end if;
  if p_reservation_days is null or p_reservation_days not between 1 and 30 then
    raise exception 'LOCAL_DELIVERY_RESERVATION_DAYS_INVALID';
  end if;
  select * into v_parcel from public.order_package_parcels where barcode = v_code;
  if not found then
    if v_code ~ '^BX-PKG-' then raise exception 'DISPATCH_PARCEL_UNKNOWN'; end if;
    raise exception 'DISPATCH_LOCAL_PARCEL_CODE_REQUIRED';
  end if;
  select * into v_order from public.ordenes where id = v_parcel.order_id for update;
  if not public.order_is_local_delivery(v_order) then raise exception 'DISPATCH_LOCAL_DELIVERY_ONLY'; end if;
  select * into v_package from public.order_packages where order_id = v_order.id for share;
  select * into v_shipment from public.local_delivery_shipments
    where id = public.local_delivery_current_shipment_id(v_order.id) for update;
  if not found or v_shipment.outcome_status not in ('returning', 'returned') then
    raise exception 'LOCAL_DELIVERY_RETURN_NOT_EXPECTED' using detail = v_order.id::text;
  end if;
  if v_package.id is null or v_parcel.package_id <> v_package.id
     or v_parcel.attempt_number <> v_package.attempt_number
     or v_parcel.parcel_count <> v_package.parcel_count then
    raise exception 'DISPATCH_PARCEL_STALE';
  end if;

  insert into public.local_delivery_return_receipts(shipment_id, parcel_id, barcode, received_by)
    values (v_shipment.id, v_parcel.id, v_parcel.barcode, p_actor_id)
    on conflict on constraint local_delivery_return_receipts_unique do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    perform public.local_delivery_audit(v_order.id, 'admin', p_actor_id, 'local_delivery_return_parcel_received',
      jsonb_build_object('shipmentId', v_shipment.id, 'barcode', v_parcel.barcode,
        'parcelIndex', v_parcel.parcel_index, 'parcelCount', v_package.parcel_count));
  end if;
  select count(*) into v_received from public.local_delivery_return_receipts r
    join public.order_package_parcels p on p.id = r.parcel_id
    where r.shipment_id = v_shipment.id and p.package_id = v_package.id
      and p.attempt_number = v_package.attempt_number and p.parcel_count = v_package.parcel_count;

  if v_shipment.outcome_status = 'returning' and v_received = v_package.parcel_count then
    update public.local_delivery_shipments set outcome_status = 'returned', returned_at = v_now,
      returned_by = p_actor_id, updated_at = v_now
      where id = v_shipment.id returning * into v_shipment;
    perform public.local_delivery_audit(v_order.id, 'admin', p_actor_id, 'local_delivery_return_received',
      jsonb_build_object('shipmentId', v_shipment.id, 'parcelCount', v_package.parcel_count,
        'barcodes', (select jsonb_agg(r.barcode order by r.barcode) from public.local_delivery_return_receipts r
                     where r.shipment_id = v_shipment.id)));
    -- Un pedido cancelado mientras volvía ya devolvió su stock: no se reserva.
    if v_order.estado <> 'cancelado' and v_order.cancelled_at is null then
      insert into public.local_delivery_return_reservations(shipment_id, order_id, reservation_days,
          starts_at, expires_at, created_by)
        values (v_shipment.id, v_order.id, p_reservation_days, v_now,
          public.local_delivery_reservation_expiry(v_now, p_reservation_days), p_actor_id)
        returning * into v_reservation;
      insert into public.local_delivery_return_reservation_items(reservation_id, order_item_id, product_id,
          variant_id, conditioned_stock_id, quantity)
        select v_reservation.id, i.id, i.producto_id, i.variante_id, i.conditioned_stock_id, i.cantidad
        from public.orden_items i where i.orden_id = v_order.id and i.cantidad > 0 and i.producto_id is not null;
      perform public.local_delivery_audit(v_order.id, 'admin', p_actor_id, 'local_delivery_return_reservation_started',
        jsonb_build_object('reservationId', v_reservation.id, 'reservationDays', p_reservation_days,
          'expiresAt', v_reservation.expires_at));
    else
      -- Cancelado mientras volvía: esta recepción completa es la evidencia
      -- física de la retención de la cancelación (sin segundo escaneo).
      perform public.local_delivery_resolve_return_hold(v_order.id);
    end if;
    v_complete := true;
  end if;

  return jsonb_build_object('orderId', v_order.id, 'code', v_parcel.barcode,
    'parcelIndex', v_parcel.parcel_index, 'parcelCount', v_package.parcel_count,
    'received', v_received, 'complete', v_shipment.outcome_status = 'returned',
    'completedNow', v_complete, 'duplicate', v_inserted = 0,
    'reservationExpiresAt', v_reservation.expires_at);
end $$;

-- 4. Reserva: consumo (nuevo envío) y vencimiento --------------------------------
-- Punto de enganche del futuro "nuevo envío": usa las unidades que ya están
-- apartadas para el pedido sin liberarlas ni volver a reservarlas. Falla si la
-- reserva ya venció (aunque el job todavía no haya corrido). Idempotente: hay
-- una sola reserva por entrega, así que repetir el consumo sobre la reserva
-- vigente ya consumida devuelve ese estado sin volver a escribir.
create or replace function public.consume_local_delivery_return_reservation(p_order_id bigint, p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_reservation public.local_delivery_return_reservations%rowtype;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  perform 1 from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  select * into v_reservation from public.local_delivery_return_reservations
    where shipment_id = public.local_delivery_current_shipment_id(p_order_id) for update;
  if found and v_reservation.status = 'consumed' then
    return jsonb_build_object('orderId', p_order_id, 'reservationId', v_reservation.id, 'status', 'consumed',
      'alreadyConsumed', true);
  end if;
  if not found or v_reservation.status <> 'active' then raise exception 'LOCAL_DELIVERY_RESERVATION_NOT_ACTIVE'; end if;
  if v_reservation.expires_at <= now() then raise exception 'LOCAL_DELIVERY_RESERVATION_EXPIRED'; end if;
  update public.local_delivery_return_reservations set status = 'consumed', consumed_at = now(), consumed_by = p_actor_id
    where id = v_reservation.id;
  perform public.local_delivery_audit(p_order_id, 'admin', p_actor_id, 'local_delivery_return_reservation_consumed',
    jsonb_build_object('reservationId', v_reservation.id));
  return jsonb_build_object('orderId', p_order_id, 'reservationId', v_reservation.id, 'status', 'consumed',
    'alreadyConsumed', false);
end $$;

-- Job: vence las reservas cuyo plazo terminó. Idempotente y seguro con dos
-- ejecuciones a la vez (SKIP LOCKED por pedido + revalidación bajo lock).
-- Mismo orden de locks que el consumo (pedido → reserva).
create or replace function public.expire_local_delivery_return_reservations(p_limit integer default 100)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_candidate record;
  v_reservation public.local_delivery_return_reservations%rowtype;
  v_product_id bigint;
  v_expired bigint[] := '{}';
begin
  for v_candidate in
    select r.id, r.order_id from public.local_delivery_return_reservations r
    where r.status = 'active' and r.expires_at <= now()
    order by r.expires_at, r.id limit least(greatest(coalesce(p_limit, 100), 1), 500)
  loop
    perform 1 from public.ordenes where id = v_candidate.order_id for update skip locked;
    if not found then continue; end if;
    select * into v_reservation from public.local_delivery_return_reservations
      where id = v_candidate.id for update;
    if v_reservation.status <> 'active' or v_reservation.expires_at > now() then continue; end if;
    update public.local_delivery_return_reservations set status = 'expired', expired_at = now()
      where id = v_reservation.id;
    -- La rama local_delivery_return_release del libro ya cuenta estas
    -- unidades: se recalcula el stock derivado de cada producto.
    for v_product_id in
      select distinct i.product_id from public.local_delivery_return_reservation_items i
      where i.reservation_id = v_reservation.id
    loop
      perform public.refresh_inventory_stock(v_product_id);
    end loop;
    perform public.local_delivery_audit(v_reservation.order_id, 'system', null,
      'local_delivery_return_reservation_expired',
      jsonb_build_object('reservationId', v_reservation.id, 'expiresAt', v_reservation.expires_at,
        'reservationDays', v_reservation.reservation_days));
    v_expired := array_append(v_expired, v_reservation.order_id);
  end loop;
  return jsonb_build_object('expired', cardinality(v_expired), 'orderIds', to_jsonb(v_expired));
end $$;

-- 4b. Colas de Despachos → Entregas locales ----------------------------------------
-- ordenes.estado sigue en 'en_camino' para un pedido Devuelto a BEYONIX, así
-- que filtrar sólo por estado y limitar dejaba que los devueltos ocuparan el
-- cupo de la lista y ocultaran entregas nuevas. El límite se aplica DESPUÉS
-- de separar por el subestado real de la entrega local:
-- * operativos: Preparando/En camino sin resultado terminal (pendiente, 1.er
--   intento fallido, incidencia, regresando — la recepción está pendiente);
-- * devueltos: coordinación con el cliente (reserva activa primero).
-- Mismas condiciones de elegibilidad que whereLocalDeliveryEligible (Envío
-- BEYONIX, pago confirmado y sin cancelación).
create or replace function public.local_delivery_queue_order_ids(p_queue text, p_limit integer)
returns setof bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select o.id
  from public.ordenes o
  left join lateral (
    select s.id, s.outcome_status, s.returned_at from public.local_delivery_shipments s
    where s.order_id = o.id order by s.shipment_number desc limit 1
  ) shipment on true
  left join public.local_delivery_return_reservations r
    on r.shipment_id = shipment.id and r.status = 'active'
  where o.shipping_provider = 'beyonix'
    and o.financial_status = 'payment_confirmed'
    and o.cancelled_at is null
    and o.paid_at is not null
    and o.payment_confirmed_amount > 0
    and o.payment_status in ('confirmado', 'approved', 'confirmed')
    and case p_queue
      when 'operational' then o.estado in ('pagado', 'preparado', 'en_camino')
        and coalesce(shipment.outcome_status, 'pending') not in ('returned', 'delivered')
      when 'returned' then o.estado = 'en_camino' and shipment.outcome_status = 'returned'
      else false
    end
  order by
    case when p_queue = 'returned' then (r.id is null)::int end,
    case when p_queue = 'returned' then shipment.returned_at end desc,
    o.id
  limit least(greatest(coalesce(p_limit, 200), 1), 500)
$$;

-- 5. Libro de inventario: liberación de reservas de retorno vencidas -------------
-- Rama nueva del libro: +unidades de cada ítem de una reserva VENCIDA, con el
-- mismo producto/variante y el mismo predicado de consumo que la rama web_sale
-- (si el pedido deja de consumir stock, ambas desaparecen juntas). Función
-- security definer: inventory_movements es security_invoker y authenticated
-- no lee las tablas de reservas.
create or replace function public.local_delivery_return_release_movements()
returns table (
  product_id bigint, variant_id bigint, movement_date date, recorded_at timestamptz,
  source text, source_id text, quantity_delta bigint, movement_id text, movement_type text,
  origin text, effective_at timestamptz, responsible_user_id uuid, responsible_process text,
  idempotency_key text, document_reference text)
language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select
    items.producto_id::bigint, items.variante_id::bigint,
    (reservations.expired_at at time zone 'America/Argentina/Buenos_Aires')::date,
    reservations.expired_at, 'local_delivery_return_release'::text, reserved.id::text,
    reserved.quantity::bigint,
    'local_delivery_return_release:' || reserved.id::text, 'local_delivery_return_release'::text,
    'local_delivery_return_reservation_items'::text, reservations.expired_at, null::uuid,
    'local_delivery_return_reservation_expiry'::text,
    'local-delivery-return-release:' || reserved.id::text,
    'order:' || orders.id::text
  from public.local_delivery_return_reservation_items reserved
  join public.local_delivery_return_reservations reservations
    on reservations.id = reserved.reservation_id and reservations.status = 'expired'
  join public.orden_items items on items.id = reserved.order_item_id
  join public.ordenes orders on orders.id = items.orden_id
  where items.conditioned_stock_id is null
    and (public.inventory_order_consumes_stock(orders.estado, orders.payment_status)
         or public.order_has_active_stock_hold(orders.id) or orders.super_admin_stock_retained_at is not null)
$$;
revoke all on function public.local_delivery_return_release_movements() from public, anon;
grant execute on function public.local_delivery_return_release_movements() to authenticated, service_role;
revoke all on function public.local_delivery_released_quantity(bigint) from public;
grant execute on function public.local_delivery_released_quantity(bigint) to anon, authenticated, service_role;

-- Idéntica a 20261027210000 salvo la rama final de liberación.
create or replace view public.inventory_movements
with (security_invoker = true)
as
select
  entries.product_id, entries.variant_id, entries.purchase_date as movement_date,
  entries.created_at as recorded_at, 'purchase'::text as source,
  entries.id::text as source_id, entries.received_quantity::bigint as quantity_delta,
  'purchase:' || entries.id::text as movement_id,
  'purchase'::text as movement_type,
  'product_cost_entries'::text as origin,
  entries.purchase_date::timestamp at time zone 'America/Argentina/Buenos_Aires' as effective_at,
  entries.created_by as responsible_user_id,
  'admin_purchase'::text as responsible_process,
  coalesce(entries.idempotency_key, 'purchase:' || entries.id::text) as idempotency_key,
  coalesce(nullif(btrim(entries.document_number), ''), entries.id::text) as document_reference
from public.product_cost_entries entries
where entries.product_id is not null and entries.received_quantity <> 0

union all

select
  items.producto_id, items.variante_id,
  (orders.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
  orders.created_at, 'web_sale'::text, items.id::text, -items.cantidad::bigint,
  'web_sale:' || items.id::text, 'web_sale'::text, 'orden_items'::text,
  orders.created_at, orders.usuario_id, 'checkout'::text,
  coalesce(orders.checkout_idempotency_key, 'order-item:' || items.id::text),
  'order:' || orders.id::text
from public.orden_items items
join public.ordenes orders on orders.id = items.orden_id
where items.conditioned_stock_id is null
  and (public.inventory_order_consumes_stock(orders.estado, orders.payment_status)
       or public.order_has_active_stock_hold(orders.id) or orders.super_admin_stock_retained_at is not null)

union all

select
  sales.product_id, sales.variant_id, sales.sale_date, sales.created_at,
  'external_sale'::text, sales.id::text, -sales.quantity::bigint,
  'external_sale:' || sales.id::text, 'external_sale'::text, 'external_sales'::text,
  sales.sale_date::timestamp at time zone 'America/Argentina/Buenos_Aires',
  sales.created_by, 'admin_external_sale'::text,
  'external-sale:' || sales.id::text,
  coalesce(nullif(btrim(sales.reference), ''), sales.id::text)
from public.external_sales sales
where sales.product_id is not null
  and public.external_sale_consumes_stock(
    sales.stock_effect, sales.status, sales.reversal_kind, sales.return_condition
  )

union all

select
  sales.product_id, public.inventory_ml_variant_id(sales.raw_data),
  coalesce(
    (sales.sale_date at time zone 'America/Argentina/Buenos_Aires')::date,
    (sales.imported_at at time zone 'America/Argentina/Buenos_Aires')::date
  ),
  sales.imported_at, 'mercadolibre_sale'::text, sales.id::text,
  -public.inventory_ml_stock_units(sales.quantity, sales.raw_data)::bigint,
  'mercadolibre_sale:' || sales.id::text, 'mercadolibre_sale'::text,
  'mercadolibre_sales'::text, coalesce(sales.sale_date, sales.imported_at),
  sales.imported_by, 'mercadolibre_import'::text,
  coalesce(sales.source_key, 'mercadolibre-sale:' || sales.id::text),
  coalesce(nullif(btrim(sales.operation_id), ''), nullif(btrim(sales.order_id), ''), sales.id::text)
from public.mercadolibre_sales sales
where sales.product_id is not null
  and public.inventory_ml_stock_units(sales.quantity, sales.raw_data) > 0

union all

select
  movements.product_id, movements.variant_id,
  (movements.occurred_at at time zone 'America/Argentina/Buenos_Aires')::date,
  movements.created_at, 'approved_return'::text, movements.id::text,
  movements.sellable_quantity::bigint,
  'approved_return:' || movements.id::text, 'return'::text,
  'inventory_return_movements'::text,
  coalesce(movements.occurred_at, movements.approved_at, movements.created_at),
  movements.approved_by, 'return_review'::text,
  movements.source_key,
  coalesce(
    case when movements.mercadolibre_sale_id is not null
      then 'mercadolibre-sale:' || movements.mercadolibre_sale_id::text end,
    case when movements.order_item_id is not null
      then 'order-item:' || movements.order_item_id::text end,
    movements.id::text
  )
from public.inventory_return_movements movements
where movements.sellable_quantity <> 0

union all

select
  expenses.product_id, expenses.variant_id, expenses.expense_date,
  expenses.created_at, 'product_expense'::text, expenses.id::text,
  -expenses.quantity::bigint,
  'product_expense:' || expenses.id::text, 'write_off'::text,
  'business_expenses'::text,
  expenses.expense_date::timestamp at time zone 'America/Argentina/Buenos_Aires',
  expenses.created_by, 'admin_product_expense'::text,
  coalesce(expenses.idempotency_key, 'product-expense:' || expenses.id::text),
  coalesce(nullif(btrim(expenses.document_number), ''), expenses.id::text)
from public.business_expenses expenses
where expenses.expense_type = 'product'
  and expenses.product_id is not null
  and expenses.quantity is not null

union all

select
  adjustments.product_id, adjustments.variant_id, adjustments.adjustment_date,
  adjustments.created_at, 'stock_adjustment'::text, adjustments.id::text,
  adjustments.quantity_delta::bigint,
  'stock_adjustment:' || adjustments.id::text, 'adjustment'::text,
  'inventory_stock_adjustments'::text,
  adjustments.created_at, adjustments.created_by, 'admin_stock_adjustment'::text,
  coalesce(adjustments.idempotency_key, 'stock-adjustment:' || adjustments.id::text),
  adjustments.reason
from public.inventory_stock_adjustments adjustments
where adjustments.quantity_delta <> 0

union all

select * from public.local_delivery_return_release_movements();

-- Stock con descuento (pool aparte): lo liberado deja de contarse como vendido.
-- Idénticas a 20261017110000 salvo la resta de local_delivery_released_quantity.
create or replace view public.conditioned_inventory_offers
with (security_invoker = true)
as
select
  movements.id,
  movements.product_id,
  movements.variant_id as source_variant_id,
  movements.conditioned_name as name,
  movements.conditioned_sku as sku,
  movements.conditioned_color_hex as color_hex,
  movements.conditioned_images as images,
  movements.discounted_quantity::integer as original_quantity,
  coalesce(sales.quantity, 0)::integer as sold_quantity,
  greatest(
    movements.discounted_quantity - coalesce(sales.quantity, 0),
    0
  )::integer as available_quantity,
  movements.discount_percent,
  movements.discount_reason as reason,
  movements.conditioned_active as active,
  movements.approved_at
from public.inventory_return_movements movements
left join lateral (
  select sum(
    greatest(
      items.cantidad - coalesce(items.return_restocked_quantity, 0)
        - public.local_delivery_released_quantity(items.id),
      0
    )
  ) as quantity
  from public.orden_items items
  join public.ordenes orders on orders.id = items.orden_id
  where items.conditioned_stock_id = movements.id
    and (public.inventory_order_consumes_stock(
      orders.estado,
      orders.payment_status
    ) or public.order_has_active_stock_hold(orders.id) or orders.super_admin_stock_retained_at is not null)
) sales on true
where movements.discounted_quantity > 0;

create or replace view public.conditioned_catalog_variants
with (security_barrier = true, security_invoker = false)
as
select
  movements.id,
  movements.product_id,
  movements.variant_id as source_variant_id,
  movements.conditioned_name as name,
  movements.conditioned_sku as sku,
  movements.conditioned_color_hex as color_hex,
  movements.conditioned_images as images,
  movements.discounted_quantity::integer as original_quantity,
  coalesce(sales.quantity, 0)::integer as sold_quantity,
  greatest(
    movements.discounted_quantity - coalesce(sales.quantity, 0),
    0
  )::integer as available_quantity,
  movements.discount_percent,
  movements.discount_reason as reason,
  movements.approved_at
from public.inventory_return_movements movements
join public.productos products on products.id = movements.product_id
left join lateral (
  select sum(
    greatest(
      items.cantidad - coalesce(items.return_restocked_quantity, 0)
        - public.local_delivery_released_quantity(items.id),
      0
    )
  ) as quantity
  from public.orden_items items
  join public.ordenes orders on orders.id = items.orden_id
  where items.conditioned_stock_id = movements.id
    and (public.inventory_order_consumes_stock(
      orders.estado,
      orders.payment_status
    ) or public.order_has_active_stock_hold(orders.id) or orders.super_admin_stock_retained_at is not null)
) sales on true
where movements.conditioned_active
  and products.activo
  and movements.discounted_quantity > coalesce(sales.quantity, 0)
  and nullif(btrim(movements.conditioned_name), '') is not null
  and nullif(btrim(movements.conditioned_sku), '') is not null
  and movements.conditioned_color_hex ~ '^#[0-9A-Fa-f]{6}$';

revoke all on function
  public.local_delivery_reservation_expiry(timestamptz, integer),
  public.local_delivery_current_shipment_id(bigint),
  public.local_delivery_audit(bigint, text, uuid, text, jsonb),
  public.ensure_local_delivery_shipment(bigint, uuid, text),
  public.record_local_delivery_courier_outcome(text, text, integer, text, text),
  public.mark_local_delivery_delivered_by_courier(text),
  public.guard_local_delivery_outcome(),
  public.sync_local_delivery_outcome(),
  public.resolve_local_delivery_incident(bigint, uuid, text),
  public.receive_local_delivery_return_parcel(text, uuid, integer),
  public.consume_local_delivery_return_reservation(bigint, uuid),
  public.expire_local_delivery_return_reservations(integer),
  public.local_delivery_resolve_return_hold(bigint),
  public.local_delivery_queue_order_ids(text, integer)
  from public, anon, authenticated;
grant execute on function
  public.local_delivery_reservation_expiry(timestamptz, integer),
  public.local_delivery_current_shipment_id(bigint),
  public.ensure_local_delivery_shipment(bigint, uuid, text),
  public.record_local_delivery_courier_outcome(text, text, integer, text, text),
  public.mark_local_delivery_delivered_by_courier(text),
  public.resolve_local_delivery_incident(bigint, uuid, text),
  public.receive_local_delivery_return_parcel(text, uuid, integer),
  public.consume_local_delivery_return_reservation(bigint, uuid),
  public.expire_local_delivery_return_reservations(integer),
  public.local_delivery_queue_order_ids(text, integer)
  to service_role;

notify pgrst, 'reload schema';

commit;
