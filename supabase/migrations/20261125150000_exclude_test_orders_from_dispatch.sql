-- Compras de prueba (ordenes.test_order_at) fuera de las listas operativas de
-- Despachos. La clasificación (20261124120000) las archiva, pero Despachos no
-- mira el archivo: BX-1019 y BX-1020 (Envío BEYONIX, entregados) seguían como
-- filas "Despachado" en Pedidos y Bultos, y BX-1020 en Entregas locales.
--
-- Listas: dos funciones de LECTURA (mismo cuerpo que 20261106110000 y
-- 20261105120000, verificado idéntico al de producción el 2026-11-25), con un
-- único filtro más cada una:
--   * search_dispatch_records (Pedidos y Bultos, contadores y paginación): la
--     compra de prueba no es una fila de pedido con ningún filtro, fecha ni
--     TRANSPORTISTA (se excluye ANTES de contar y paginar). Buscar su N° no
--     lleva a su Bulto; el Bulto en sí (contenido físico, sumas) no cambia.
--   * local_delivery_queue_order_ids (colas de Entregas locales): una compra de
--     prueba nunca ocupa cupo operativo ni de devueltos.
-- Operaciones nuevas sobre una compra de prueba (ver "Carreras con la
-- clasificación", al final): las RPC de etiquetas BEYONIX, el inicio de una
-- garantía y las marcas de efectos de entrega local la rechazan bajo lock /
-- con lectura fresca.
-- La migración no escribe datos: pedidos, bultos, etiquetas, tracking,
-- entregas, cadete, garantías existentes, pagos, facturas y auditoría quedan
-- intactos. Admin > Pedidos > Archivados las sigue mostrando.

create or replace function public.search_dispatch_records(
  p_page integer default 1, p_date date default null, p_order text default null,
  p_batch text default null, p_actor_id uuid default null, p_state text default null,
  p_open_all_dates boolean default false, p_kind text default null, p_carrier text default null
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order text := nullif(btrim(coalesce(p_order, '')), '');
  v_batch text := nullif(btrim(coalesce(p_batch, '')), '');
  v_batch_number text := ltrim(regexp_replace(coalesce(p_batch, ''), '[^0-9]', '', 'g'), '0');
  v_result jsonb;
begin
  if p_page < 1 or p_page > 100000 or (p_state is not null and p_state not in ('P','C','E','X'))
     or (p_kind is not null and p_kind not in ('order','batch'))
     or (p_carrier is not null and p_carrier not in ('andreani','beyonix'))
     or length(coalesce(p_order, '')) > 80 or length(coalesce(p_batch, '')) > 80 then
    raise exception 'DISPATCH_FILTER_INVALID';
  end if;

  with order_base as (
    select o.id, o.total, o.created_at, o.cancelled_at, o.delivered_at, o.andreani_created_at,
      o.andreani_handed_over_at, o.andreani_handed_over_by, c.carrier,
      pkg.id package_id, pkg.attempt_number, pkg.prepared_at, pkg.prepared_by, pkg.identified_by,
      pkg.identification_method, ev.created_at local_dispatched_at, ev.actor_id local_dispatched_by,
      case
        when c.carrier = 'beyonix' then
          case
            when o.cancelled_at is not null then 'X'
            when o.estado in ('en_camino','entregado') then 'E'
            when pkg.status = 'prepared' and public.local_delivery_parcels_ready(o.id) then 'C'
            else 'P'
          end
        when o.cancelled_at is not null then 'X'
        when o.andreani_handed_over_at is not null then 'E'
        when pkg.status = 'prepared' and o.andreani_creation_status = 'created'
          and nullif(btrim(o.andreani_tracking), '') is not null
          and nullif(btrim(o.andreani_envio_id), '') is not null then 'C'
        else 'P'
      end state
    from public.ordenes o
    cross join lateral (select public.order_shipping_carrier(o) carrier) c
    left join public.order_packages pkg on pkg.order_id = o.id
    left join lateral (
      select e.created_at, e.actor_id from public.order_audit_events e
      where c.carrier = 'beyonix' and e.order_id = o.id
        and e.action = 'order_status_changed' and e.new_status = 'en_camino'
      order by e.created_at, e.id limit 1
    ) ev on true
    where c.carrier in ('andreani','beyonix')
      and (p_carrier is null or c.carrier = p_carrier)
      and not exists (select 1 from public.dispatch_batch_items m where m.order_id = o.id and m.removed_at is null)
      and (
        (c.carrier = 'andreani'
          and ((o.andreani_handed_over_at is null
                and ((o.cancelled_at is null and o.financial_status = 'payment_confirmed'
                      and o.estado not in ('cancelado','enviado','en_camino','entregado'))
                  or (o.cancelled_at is not null and pkg.id is not null)))
            -- Respaldo: entregado al transporte por un Bulto pero sin pertenencia activa.
            or o.andreani_handed_over_at is not null))
        or (c.carrier = 'beyonix'
          and ((o.cancelled_at is null and o.financial_status = 'payment_confirmed' and o.estado <> 'cancelado')
            or (o.cancelled_at is not null and pkg.id is not null))))
      -- Compra de prueba clasificada: fuera de Despachos (sigue en Pedidos > Archivados).
      and o.test_order_at is null
      and v_batch is null
      and (v_order is null or ('BX-' || (o.id + 1000)::text) ilike '%' || v_order || '%')
  ), order_rows as (
    select 'order'::text kind, b.id, null::text code, null::integer display_number, b.state, b.carrier,
      case b.state
        when 'X' then b.cancelled_at
        when 'E' then case when b.carrier = 'beyonix'
          then coalesce(b.local_dispatched_at, b.delivered_at, b.prepared_at, b.created_at)
          else b.andreani_handed_over_at end
        when 'C' then coalesce(b.prepared_at, b.andreani_created_at, b.created_at)
        else b.created_at
      end at,
      case b.state
        when 'X' then (select h.resolved_by from public.order_cancellation_holds h
          where h.order_id = b.id order by h.detected_at desc limit 1)
        when 'E' then case when b.carrier = 'beyonix' then b.local_dispatched_by else b.andreani_handed_over_by end
        when 'C' then coalesce(b.identified_by, b.prepared_by)
        else (select s.scanned_by from public.order_preparation_scans s
          where s.package_id = b.package_id and s.attempt_number = b.attempt_number
          order by s.scanned_at desc, s.id desc limit 1)
      end actor_id,
      (select coalesce(sum(oi.cantidad), 0) from public.orden_items oi where oi.orden_id = b.id)::integer units,
      b.total, 1 order_count,
      (b.carrier = 'andreani' and b.state = 'C' and b.identification_method is not null
        and not exists (select 1 from public.dispatch_blocks k where k.order_id = b.id and k.resolved_at is null)
        and not exists (select 1 from public.order_cancellation_holds h where h.order_id = b.id and h.resolved_at is null)) selectable
    from order_base b
  ), batch_base as (
    -- Bultos generales: sólo Andreani.
    select bt.id, bt.code, bt.display_number, bt.status, bt.created_at, bt.closed_at, bt.handed_over_at,
      bt.created_by, bt.closed_by, bt.handed_over_by, t.order_count, t.units, t.total
    from public.dispatch_batches bt
    cross join lateral (
      -- Un pedido tiene a lo sumo una pertenencia activa: sumar sólo las activas no duplica.
      select count(*)::integer order_count,
        coalesce(sum(u.units), 0)::integer units,
        coalesce(sum(o.total), 0) total
      from public.dispatch_batch_items m
      join public.ordenes o on o.id = m.order_id
      cross join lateral (select coalesce(sum(oi.cantidad), 0) units from public.orden_items oi where oi.orden_id = m.order_id) u
      where m.batch_id = bt.id and m.removed_at is null
    ) t
    where t.order_count > 0
      and (p_carrier is null or p_carrier = 'andreani')
      and (v_batch is null or bt.code ilike '%' || v_batch || '%'
        or ('Bulto - ' || lpad(coalesce(bt.display_number, bt.id)::text, 4, '0')) ilike '%' || v_batch || '%'
        or ('Bulto-' || lpad(coalesce(bt.display_number, bt.id)::text, 4, '0')) ilike '%' || v_batch || '%'
        or (v_batch_number <> '' and coalesce(bt.display_number, bt.id)::text = v_batch_number))
      -- El N° de una compra de prueba no lleva a su Bulto (el contenido físico del Bulto no cambia).
      and (v_order is null or exists (select 1 from public.dispatch_batch_items m
        join public.ordenes mo on mo.id = m.order_id and mo.test_order_at is null
        where m.batch_id = bt.id and m.removed_at is null
          and ('BX-' || (m.order_id + 1000)::text) ilike '%' || v_order || '%'))
  ), batch_rows as (
    select 'batch'::text kind, b.id, b.code, b.display_number, s.state, 'andreani'::text carrier,
      case s.state when 'E' then b.handed_over_at
        when 'C' then coalesce(b.closed_at, b.created_at) else b.created_at end at,
      case s.state when 'E' then b.handed_over_by
        when 'C' then coalesce(b.closed_by, b.created_by) else b.created_by end actor_id,
      b.units, b.total, b.order_count, false selectable
    from batch_base b
    cross join lateral (select case when b.status = 'handed_over' then 'E'
      when b.status = 'closed' then 'C' else 'P' end state) s
  ), filtered as materialized (
    select * from (select * from order_rows union all select * from batch_rows) r
    where (p_kind is null or r.kind = p_kind)
      and (p_state is null or r.state = p_state)
      and (p_actor_id is null or r.actor_id = p_actor_id)
      and (p_date is null or (p_open_all_dates and r.state in ('P','C'))
        or (r.at >= (p_date::timestamp at time zone 'America/Argentina/Buenos_Aires')
          and r.at < ((p_date + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')))
  ), page_rows as (
    select * from filtered order by at desc nulls last, kind, id desc limit 20 offset (p_page - 1) * 20
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'code', code,
      'displayNumber', display_number, 'state', state, 'carrier', carrier, 'at', at, 'actorId', actor_id,
      'units', units, 'total', total, 'orderCount', order_count, 'selectable', selectable)
      order by at desc nulls last, kind, id desc) from page_rows), '[]'::jsonb),
    'total', (select count(*) from filtered)) into v_result;
  return v_result;
end $$;

revoke all on function public.search_dispatch_records(integer, date, text, text, uuid, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.search_dispatch_records(integer, date, text, text, uuid, text, boolean, text, text) to service_role;

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
    and o.test_order_at is null
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

revoke all on function public.local_delivery_queue_order_ids(text, integer) from public, anon, authenticated;
grant execute on function public.local_delivery_queue_order_ids(text, integer) to service_role;

-- -- Carreras con la clasificación (20261124120000) -------------------------
-- La clasificación toma el pedido (FOR NO KEY UPDATE) y después sus ítems
-- (FOR UPDATE), y recién entonces fija test_order_at. Las validaciones de la
-- app (ruta de etiquetas, cron de efectos) son una defensa adicional; la
-- garantía es de PostgreSQL:
--   * Etiquetas BEYONIX: ensure_local_delivery_shipment (emite/rota el token
--     del QR) y record_local_delivery_labels_generated (registra la
--     generación) ya bloquean el pedido FOR UPDATE como primer paso; la
--     validación de test_order_at va inmediatamente después de ese lock. Si la
--     clasificación está en curso, esperan y ven la fila confirmada (READ
--     COMMITTED relee la versión nueva): DISPATCH_TEST_ORDER, sin token ni
--     historial. Si la etiqueta va primero, la clasificación espera. Mismo
--     orden de locks que antes (pedido -> entrega/bulto): sin deadlocks nuevos.
--     Cuerpos idénticos a 20261105120000 / 20261104120000 (verificados contra
--     producción el 2026-11-26) más esa única validación.
--   * Garantía de una entrega (efecto del cron local-delivery-effects): se
--     activa con UPDATE de orden_items. El trigger existente
--     lock_item_order_for_dispatch ya bloquea el pedido (FOR UPDATE) cuando
--     tiene armado; este guard corre después (orden alfabético de triggers
--     BEFORE), sólo LEE el pedido con un snapshot nuevo (función VOLATILE) y
--     rechaza iniciar una garantía de una compra de prueba ya clasificada. No
--     toma locks propios: no agrega riesgo de deadlock. Sólo frena el INICIO
--     de una garantía (de null a una fecha); nada existente cambia.

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
  -- Compra de prueba: bajo el mismo lock del pedido que toma la clasificación.
  if v_order.test_order_at is not null then raise exception 'DISPATCH_TEST_ORDER'; end if;
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

revoke all on function public.ensure_local_delivery_shipment(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.ensure_local_delivery_shipment(bigint, uuid, text) to service_role;

create or replace function public.record_local_delivery_labels_generated(
  p_order_id bigint, p_actor_id uuid, p_package_id bigint, p_attempt integer, p_barcodes text[])
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order public.ordenes%rowtype;
  v_package public.order_packages%rowtype;
  v_current text[];
  v_reprint boolean;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  -- Compra de prueba: bajo el mismo lock del pedido que toma la clasificación.
  if v_order.test_order_at is not null then raise exception 'DISPATCH_TEST_ORDER'; end if;
  if not public.order_is_local_delivery(v_order) then raise exception 'DISPATCH_LOCAL_DELIVERY_ONLY'; end if;
  if v_order.estado = 'cancelado' or v_order.cancelled_at is not null
     or coalesce(v_order.financial_status, '') in ('cancellation_requested', 'refund_pending', 'refunded', 'cancelled') then
    raise exception 'LOCAL_DELIVERY_LABEL_ORDER_CANCELLED';
  end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found or v_package.id is distinct from p_package_id
     or v_package.attempt_number is distinct from p_attempt
     or v_package.status <> 'prepared' or v_package.parcel_count is null
     or v_package.parcel_count is distinct from coalesce(cardinality(p_barcodes), 0) then
    raise exception 'DISPATCH_PARCEL_STALE';
  end if;
  select coalesce(array_agg(barcode order by parcel_index), '{}') into v_current
    from public.order_package_parcels
    where package_id = v_package.id and attempt_number = v_package.attempt_number
      and parcel_count = v_package.parcel_count;
  if v_current is distinct from p_barcodes then raise exception 'DISPATCH_PARCEL_STALE'; end if;
  -- Incluye el nombre anterior del evento para no tratar como primera una
  -- generación de un intento ya registrado con él.
  select exists (
    select 1 from public.order_audit_events
    where order_id = p_order_id
      and action in ('local_delivery_labels_generated', 'local_delivery_labels_printed')
      and metadata->>'packageId' = v_package.id::text
      and metadata->>'attempt' = v_package.attempt_number::text) into v_reprint;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
    values (p_order_id, 'admin', p_actor_id, 'local_delivery_labels_generated',
      jsonb_build_object('packageId', v_package.id, 'attempt', v_package.attempt_number,
        'parcelCount', v_package.parcel_count, 'barcodes', to_jsonb(v_current),
        'reprint', v_reprint));
  return jsonb_build_object('packageId', v_package.id, 'attempt', v_package.attempt_number,
    'parcelCount', v_package.parcel_count, 'reprint', v_reprint);
end $$;

revoke all on function public.record_local_delivery_labels_generated(bigint, uuid, bigint, integer, text[]) from public, anon, authenticated;
grant execute on function public.record_local_delivery_labels_generated(bigint, uuid, bigint, integer, text[]) to service_role;

create or replace function public.prevent_test_order_warranty_start()
returns trigger language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if exists (select 1 from public.ordenes o where o.id = new.orden_id and o.test_order_at is not null) then
    raise exception 'ORDER_TEST_WARRANTY_BLOCKED';
  end if;
  return new;
end $$;
revoke all on function public.prevent_test_order_warranty_start() from public, anon, authenticated;

drop trigger if exists prevent_test_order_warranty_start on public.orden_items;
create trigger prevent_test_order_warranty_start
  before update of warranty_started_at on public.orden_items
  for each row when (old.warranty_started_at is null and new.warranty_started_at is not null)
  execute function public.prevent_test_order_warranty_start();

-- Marcas de efectos de entrega local (cron local-delivery-effects, Despachos y
-- cadete): las escribe recordEffect (lib/orders/local-delivery-deps.ts) como
-- filas de order_audit_events con metadata.localDeliveryEffect; ningún otro
-- evento usa esa clave (verificado en producción el 2026-11-26). La app relee
-- la clasificación antes de cada efecto, pero entre esa lectura y el INSERT
-- podía confirmarse la clasificación. Este guard lo cierra en la base:
--   * Sólo esas filas (WHEN metadata ? localDeliveryEffect): auditorías
--     administrativas, fiscales, financieras y de seguridad no pasan por acá.
--   * Bloquea SÓLO la fila del pedido con FOR SHARE, que choca con el FOR NO
--     KEY UPDATE de classify_test_order_admin: si la clasificación está en
--     curso, la marca espera y relee el pedido confirmado; si la marca va
--     primero, la clasificación espera a que termine. Nunca la tabla.
--   * Compra de prueba ya clasificada: la marca se rechaza
--     (LOCAL_DELIVERY_EFFECT_TEST_ORDER), sin escritura parcial; recordEffect
--     lo informa como falla y el efecto queda pendiente.
--   * Orden de locks: el INSERT no tiene otro lock antes del pedido (la FK
--     toma después KEY SHARE de la misma fila, compatible); la clasificación
--     toma pedido -> ítems -> inventario. Sin ciclos.
--   * Eventos existentes, stock y estado del pedido no cambian.
create or replace function public.guard_test_order_local_delivery_effect()
returns trigger language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_test_order_at timestamptz;
begin
  select o.test_order_at into v_test_order_at from public.ordenes o where o.id = new.order_id for share;
  if v_test_order_at is not null then
    raise exception 'LOCAL_DELIVERY_EFFECT_TEST_ORDER';
  end if;
  return new;
end $$;
revoke all on function public.guard_test_order_local_delivery_effect() from public, anon, authenticated;

drop trigger if exists guard_test_order_local_delivery_effect on public.order_audit_events;
create trigger guard_test_order_local_delivery_effect
  before insert on public.order_audit_events
  for each row when (new.metadata ? 'localDeliveryEffect')
  execute function public.guard_test_order_local_delivery_effect();

notify pgrst, 'reload schema';
