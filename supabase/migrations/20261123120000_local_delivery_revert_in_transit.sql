-- Envío BEYONIX: corrección administrativa de "Entregado al cadete" ----------
-- Pedido local marcado En camino por error (no salió con el cadete). Sólo
-- Admin / Super Admin, con motivo obligatorio y auditoría append-only. Vuelve
-- el pedido al estado de preparación del que salió (pagado/preparado) sin tocar
-- pagos, facturas, stock, bultos, etiquetas ni el token del QR: el mismo QR y
-- los mismos BX-PKG siguen sirviendo cuando vuelva a salir.
--
-- 1. mark_local_delivery_in_transit() (misma firma, locks y validaciones) deja
--    además, en la MISMA transacción del cambio de estado, el registro
--    'local_delivery_in_transit_marked' con el estado real del que salió. Es la
--    única fuente del estado anterior: el registro 'order_status_changed' del
--    servicio se escribe después (puede faltar o reintentarse con un valor por
--    defecto), así que nunca se usa para decidir a qué estado volver.
--
-- 2. local_delivery_revert_blockers(ids): única regla de elegibilidad. La usa
--    la corrección (bajo lock) y Despachos para mostrar u ocultar el botón.
--    Bloquea (sin cambios) si:
--      * el pedido no existe o no es Envío BEYONIX;
--      * está cancelado o con reintegro;
--      * ya fue entregado (estado, delivered_at o resultado del cadete);
--      * no está En camino;
--      * el cadete (o Admin sobre una incidencia) ya registró algo en la
--        entrega vigente, aunque después se haya reintentado;
--      * no hay un registro atómico de salida posterior a la última corrección
--        o su estado de origen no es pagado/preparado: nunca se inventa.
--
-- 3. revert_local_delivery_in_transit(): rol, motivo, idempotencia por
--    p_request_key, mismo orden de locks que el circuito local (pedido →
--    paquete → entrega) y la regla del punto 2. El cadete ("Entregado" /
--    "Ausente" / "Problema") y Despachos quedan serializados.
--
-- Efectos derivados (triggers existentes): sync_dispatch_blocks resuelve
-- "Envío ya en curso"; el corte de cancelación vuelve a ser el de un pedido en
-- preparación; el libro de inventario no cambia (pagado/preparado y en_camino
-- consumen stock igual).
--
-- Pedidos que salieron antes de esta migración no tienen registro atómico: la
-- corrección se rechaza (LOCAL_DELIVERY_REVERT_PREVIOUS_UNKNOWN) en lugar de
-- suponer el estado anterior.
--
-- Reversible: drop function public.revert_local_delivery_in_transit(bigint, uuid, text, uuid);
-- drop function public.local_delivery_revert_blockers(bigint[]); y volver a
-- crear mark_local_delivery_in_transit desde 20261104120000.

begin;

-- 1. Preparando → En camino con registro atómico del estado de origen ---------
create or replace function public.mark_local_delivery_in_transit(
  p_order_id bigint, p_from_estado text, p_actor_id uuid)
returns setof public.ordenes language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_order public.ordenes%rowtype;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then return; end if;
  perform 1 from public.order_packages where order_id = p_order_id for update;
  select * into v_order from public.ordenes where id = p_order_id;
  if not public.order_is_local_delivery(v_order)
     or v_order.estado is distinct from p_from_estado
     or p_from_estado not in ('pagado', 'preparado')
     or v_order.cancelled_at is not null
     or v_order.financial_status is distinct from 'payment_confirmed'
     or v_order.paid_at is null
     or coalesce(v_order.payment_confirmed_amount, 0) <= 0
     or coalesce(v_order.payment_status, '') not in ('confirmado', 'approved', 'confirmed')
     or coalesce(v_order.order_change_status, '') in ('change_requested', 'extra_payment_pending')
     or not public.local_delivery_parcels_ready(p_order_id) then
    return;
  end if;
  update public.ordenes set estado = 'en_camino' where id = p_order_id returning * into v_order;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
    values (p_order_id, 'admin', p_actor_id, 'local_delivery_in_transit_marked', p_from_estado, 'en_camino',
      jsonb_build_object('previousEstado', p_from_estado, 'newEstado', 'en_camino', 'shippingProvider', 'beyonix',
        'shipmentId', public.local_delivery_current_shipment_id(p_order_id)));
  return next v_order;
end $$;

-- 2. Regla única de elegibilidad de la corrección ----------------------------
create or replace function public.local_delivery_revert_blockers(p_order_ids bigint[])
returns table(order_id bigint, blocker text, previous_estado text)
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_id bigint;
  v_order public.ordenes%rowtype;
  v_shipment public.local_delivery_shipments%rowtype;
  v_has_shipment boolean;
  v_last_revert bigint;
  v_marker public.order_audit_events%rowtype;
  v_has_marker boolean;
begin
  foreach v_id in array coalesce(p_order_ids, '{}'::bigint[]) loop
    order_id := v_id;
    blocker := null;
    previous_estado := null;
    select * into v_order from public.ordenes o where o.id = v_id;
    if not found then
      blocker := 'DISPATCH_ORDER_NOT_FOUND';
      return next;
      continue;
    end if;
    select * into v_shipment from public.local_delivery_shipments s
      where s.id = public.local_delivery_current_shipment_id(v_id);
    v_has_shipment := found;

    if not public.order_is_local_delivery(v_order) then
      blocker := 'DISPATCH_LOCAL_DELIVERY_ONLY';
    elsif v_order.estado = 'cancelado' or v_order.cancelled_at is not null
       or coalesce(v_order.financial_status, '') in ('cancellation_requested', 'refund_pending', 'refunded', 'cancelled') then
      blocker := 'LOCAL_DELIVERY_REVERT_ORDER_CANCELLED';
    elsif v_order.estado = 'entregado' or v_order.delivered_at is not null
       or (v_has_shipment and (v_shipment.outcome_status = 'delivered' or v_shipment.delivered_at is not null)) then
      blocker := 'LOCAL_DELIVERY_REVERT_ALREADY_DELIVERED';
    elsif v_order.estado is distinct from 'en_camino' then
      blocker := 'LOCAL_DELIVERY_REVERT_NOT_IN_TRANSIT';
    -- Cualquier resultado del cadete (o del Admin sobre una incidencia) es una
    -- operación posterior real. "Reintentar entrega" limpia los campos de la
    -- incidencia: el historial de la entrega vigente es la evidencia.
    elsif v_has_shipment and (v_shipment.outcome_status <> 'pending' or v_shipment.failed_attempts <> 0
       or v_shipment.returning_at is not null or v_shipment.returned_at is not null or v_shipment.incident_at is not null
       or exists (select 1 from public.order_audit_events e
         where e.order_id = v_id
           and e.action in ('local_delivery_incident_reported', 'local_delivery_attempt_failed',
             'local_delivery_incident_resolved', 'local_delivery_return_started')
           and e.metadata->>'shipmentId' = v_shipment.id::text)) then
      blocker := 'LOCAL_DELIVERY_REVERT_OUTCOME_RECORDED';
    else
      -- Estado de origen: sólo el registro atómico de la salida vigente
      -- (posterior a la última corrección). Sin él, no se adivina.
      select max(e.id) into v_last_revert from public.order_audit_events e
        where e.order_id = v_id and e.action = 'local_delivery_in_transit_reverted';
      select * into v_marker from public.order_audit_events e
        where e.order_id = v_id and e.action = 'local_delivery_in_transit_marked'
        order by e.id desc limit 1;
      v_has_marker := found;
      if not v_has_marker or v_marker.id <= coalesce(v_last_revert, 0)
         or v_marker.new_status is distinct from 'en_camino'
         or coalesce(v_marker.previous_status, '') not in ('pagado', 'preparado') then
        blocker := 'LOCAL_DELIVERY_REVERT_PREVIOUS_UNKNOWN';
      else
        previous_estado := v_marker.previous_status;
      end if;
    end if;
    return next;
  end loop;
end $$;

-- 3. Corrección ---------------------------------------------------------------
create or replace function public.revert_local_delivery_in_transit(
  p_order_id bigint, p_actor_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order public.ordenes%rowtype;
  v_shipment_id bigint;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_role text;
  v_blocker text;
  v_previous text;
  v_replay public.order_audit_events%rowtype;
begin
  select rol into v_role from public.profiles where id = p_actor_id;
  if auth.role() is distinct from 'service_role' or coalesce(v_role, '') not in ('admin', 'super_admin') then
    raise exception 'LOCAL_DELIVERY_REVERT_FORBIDDEN';
  end if;
  if p_request_key is null then raise exception 'LOCAL_DELIVERY_REVERT_INVALID'; end if;
  if v_reason is null or char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'LOCAL_DELIVERY_REVERT_REASON_REQUIRED';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;

  -- Reintento de la misma solicitud (doble click, red): mismo resultado.
  select * into v_replay from public.order_audit_events
    where order_id = p_order_id and action = 'local_delivery_in_transit_reverted'
      and metadata->>'requestKey' = p_request_key::text
    order by id desc limit 1;
  if found then
    return jsonb_build_object('orderId', p_order_id, 'estado', v_order.estado, 'replayed', true);
  end if;

  perform 1 from public.order_packages where order_id = p_order_id for update;
  select id into v_shipment_id from public.local_delivery_shipments
    where id = public.local_delivery_current_shipment_id(p_order_id) for update;

  select b.blocker, b.previous_estado into v_blocker, v_previous
    from public.local_delivery_revert_blockers(array[p_order_id]) b;
  if v_blocker is not null then raise exception '%', v_blocker; end if;
  if v_previous is null or v_previous not in ('pagado', 'preparado') then
    raise exception 'LOCAL_DELIVERY_REVERT_PREVIOUS_UNKNOWN';
  end if;

  update public.ordenes set estado = v_previous where id = p_order_id and estado = 'en_camino';
  if not found then raise exception 'LOCAL_DELIVERY_REVERT_NOT_IN_TRANSIT'; end if;

  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
    values (p_order_id, 'admin', p_actor_id, 'local_delivery_in_transit_reverted', 'en_camino', v_previous,
      jsonb_build_object('reason', v_reason, 'requestKey', p_request_key::text, 'actorRole', v_role,
        'shipmentId', v_shipment_id,
        'previousEstado', 'en_camino', 'newEstado', v_previous, 'shippingProvider', 'beyonix'));

  return jsonb_build_object('orderId', p_order_id, 'estado', v_previous, 'replayed', false);
end $$;

revoke all on function public.local_delivery_revert_blockers(bigint[]) from public, anon, authenticated;
grant execute on function public.local_delivery_revert_blockers(bigint[]) to service_role;
revoke all on function public.revert_local_delivery_in_transit(bigint, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.revert_local_delivery_in_transit(bigint, uuid, text, uuid) to service_role;

notify pgrst, 'reload schema';

commit;
