-- Envío BEYONIX: guardas finales antes del primer pedido real -----------------
-- MIGRACIÓN C. Requiere A (20261103120000) y B (20261103130000).
--
-- Orden de despliegue: aplicar ESTA migración ANTES de desplegar el código que
-- llama a record_local_delivery_labels_generated (ruta
-- app/api/admin/dispatch/orders/[id]/local-label). Es compatible con el código
-- ya desplegado: (1) sólo agrega una condición a una RPC existente con la misma
-- firma, (2) agrega una RPC nueva que el código anterior no usa y (3-5) sólo
-- cambia el resultado para pedidos Envío BEYONIX con datos Andreani residuales.
--
-- 1. mark_local_delivery_in_transit(): revalida order_change_status BAJO EL
--    LOCK del pedido. El servicio ya lo valida al leer
--    (getLocalDeliveryTransitionError), pero un cambio pedido entre esa lectura
--    y el UPDATE dejaba avanzar el pedido. Misma lista que el resto del sistema
--    (dispatch_order_block_reasons 'change', ARCA): 'change_requested' y
--    'extra_payment_pending'. 'change_approved', 'rejected' y NULL no bloquean.
-- 2. record_local_delivery_labels_generated(): registra la GENERACIÓN de las
--    etiquetas de un intento sólo si ese intento sigue vigente, en la misma
--    transacción y bajo el mismo orden de locks (pedido → preparación) que
--    reset/set_parcels/confirm/En camino. Si hubo un rearmado (intento nuevo)
--    o los bultos ya no son exactamente esos códigos, falla con
--    DISPATCH_PARCEL_STALE y la ruta no devuelve esas etiquetas. Primera
--    generación vs regeneración se decide bajo el lock (sin carreras). El
--    evento se llama "generated": el servidor sabe que generó las etiquetas,
--    no que una impresora las imprimió.
-- 3-5. Proveedor efectivo: los campos Andreani (QR final, tracking, estado,
--    envío, creación) y el seguimiento manual sólo son evidencia logística si
--    el pedido NO es Envío BEYONIX (public.order_is_local_delivery: el mismo
--    criterio de A y de lib/shipping/local-delivery isLocalDeliveryOrder;
--    shipping_provider manda, sin él el fallback legacy envio_proveedor). Un
--    pedido Envío BEYONIX con residuos Andreani ya no queda "despachado",
--    bloqueado en Despachos ni sin cancelación/reintegro por esos residuos.
--    Andreani (moderno y legacy) devuelve exactamente lo mismo que antes.
--    3. order_dispatch_cutoff_reached (corte de cancelación, refund MP,
--       resolución financiera, inspección de devolución: todos la llaman).
--    4. dispatch_order_block_reasons (tracking_in_circuit, shipment_uncertain,
--       already_handed_over).
--    5. Guardas Andreani dentro de las RPC de cancelación (creación en curso o
--       incierta), el QR final en set_order_package_parcels/reset_order_preparation,
--       la elegibilidad del worker de cancelación automática (NC y reintegro MP)
--       y la retención por "despachado" de super_admin_cancel_order:
--       se reemplaza sólo esa condición sobre la definición vigente.

begin;

-- 1. Preparando → En camino, atómico (misma firma y locks que en A) -----------
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
  return query update public.ordenes set estado = 'en_camino' where id = p_order_id returning *;
end $$;

-- 2. Generación de etiquetas del intento vigente -------------------------------
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

-- 3. Corte canónico de despacho por proveedor efectivo -------------------------
-- Igual que 20261023100000 para Andreani. Envío BEYONIX: sólo su propio estado
-- (En camino / Entregado; el resto de la lista nunca lo alcanza un pedido local).
create or replace function public.order_dispatch_cutoff_reached(p_order public.ordenes)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if lower(coalesce(p_order.estado, '')) in ('enviado', 'en_camino', 'visita_fallida', 'en_sucursal',
      'retiro_pendiente', 'retiro_vencido', 'en_devolucion', 'devuelto_beyonix', 'entregado') then
    return true;
  end if;
  if public.order_is_local_delivery(p_order) then return false; end if;
  return p_order.andreani_handed_over_at is not null
    or nullif(btrim(coalesce(p_order.tracking_number, '')), '') is not null
    or lower(coalesce(p_order.andreani_estado, '')) ~ '(camino|tránsito|transito|distribución|distribucion|reparto|visita|entregado)'
    or ((nullif(btrim(coalesce(p_order.andreani_envio_id, '')), '') is not null
         or nullif(btrim(coalesce(p_order.andreani_tracking, '')), '') is not null)
        and not exists (select 1 from public.order_packages p where p.order_id = p_order.id));
end $$;

comment on function public.order_dispatch_cutoff_reached(public.ordenes) is
  'Corte de cancelación: el pedido ya salió de BEYONIX (QR final del Bulto, transporte real, seguimiento manual o envío histórico sin Despachos). El envío Andreani creado no alcanza. Envío BEYONIX: sólo su estado propio (los campos Andreani residuales no cuentan).';

-- 4. Motivos de bloqueo de Despachos -----------------------------------------
-- Igual que en A salvo: para Envío BEYONIX, shipment_uncertain,
-- already_handed_over y la parte Andreani de tracking_in_circuit (evento de
-- tracking, seguimiento, estado Andreani) no se calculan con datos residuales;
-- tracking_in_circuit sigue saliendo por el estado propio del pedido.
create or replace function public.dispatch_order_block_reasons(p_order_id bigint)
returns text[] language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare o public.ordenes%rowtype; v_reasons text[] := '{}'; v_provider text; v_andreani_scope boolean;
begin
  select * into o from public.ordenes where id = p_order_id;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  v_provider := lower(coalesce(o.shipping_provider,o.envio_proveedor,''));
  v_andreani_scope := not public.order_is_local_delivery(o);
  if o.paid_at is null and coalesce(o.payment_confirmed_amount,0) <= 0
     and coalesce(o.payment_status,'') not in ('confirmado','approved','confirmed')
     then v_reasons := array_append(v_reasons,'not_paid'); end if;
  if o.invoice_status is distinct from 'authorized' or o.invoice_cae is null
     then v_reasons := array_append(v_reasons,'invoice_pending'); end if;
  if o.estado = 'cancelado' or o.cancelled_at is not null
     then v_reasons := array_append(v_reasons,'cancelled'); end if;
  if o.financial_status is distinct from 'payment_confirmed'
     then v_reasons := array_append(v_reasons,'financial_conflict'); end if;
  if coalesce(o.payment_status,'') in ('rechazado','rejected','approved_amount_mismatch',
     'approved_currency_mismatch','approved_stock_conflict','approved_after_cancellation',
     'auto_verified_stock_conflict')
     then v_reasons := array_append(v_reasons,'payment_reversed'); end if;
  if o.order_change_status in ('change_requested','extra_payment_pending')
     then v_reasons := array_append(v_reasons,'change'); end if;
  if o.return_status in ('solicitada','en_revision','aprobada') and o.return_resolved_at is null
     then v_reasons := array_append(v_reasons,'return'); end if;
  if exists (select 1 from public.order_claims c where c.order_id = p_order_id
             and c.status not in ('cerrado','rechazado') and c.cancelled_at is null
             and c.failure_type <> 'consulta_pedido')
     then v_reasons := array_append(v_reasons,'claim'); end if;
  if exists (select 1 from public.order_packages p where p.order_id=p_order_id
      and (exists (select 1 from public.orden_items i
        left join public.order_preparation_lines l on l.package_id=p.id and l.order_item_id=i.id
        where i.orden_id=p_order_id and (l.order_item_id is null
          or l.product_id<>i.producto_id or l.variant_id is distinct from i.variante_id
          or l.conditioned_stock_id is distinct from i.conditioned_stock_id
          or l.expected_quantity<>public.order_preparation_effective_quantity(p.id,p.attempt_number,i.id,i.cantidad)))
      or exists (select 1 from public.order_preparation_lines l
        left join public.orden_items i on i.id=l.order_item_id and i.orden_id=p_order_id
        where l.package_id=p.id and i.id is null)))
     then v_reasons := array_append(v_reasons,'items_changed'); end if;
  if v_provider not in ('andreani','beyonix')
     then v_reasons := array_append(v_reasons,'wrong_carrier'); end if;
  -- Envío BEYONIX nunca tiene un envío Andreani válido para Despachos.
  if v_provider = 'beyonix'
     or o.andreani_envio_id is null or o.andreani_creation_status is distinct from 'created'
     then v_reasons := array_append(v_reasons,'shipment_pending'); end if;
  if v_andreani_scope and o.andreani_creation_status in ('claimed','reconciliation_required')
     then v_reasons := array_append(v_reasons,'shipment_uncertain'); end if;
  if v_andreani_scope and o.andreani_handed_over_at is not null
     then v_reasons := array_append(v_reasons,'already_handed_over'); end if;
  if (v_andreani_scope and (o.andreani_tracking_event_at is not null or nullif(btrim(o.tracking_number),'') is not null
       or lower(coalesce(o.andreani_estado,'')) ~ '(camino|tránsito|transito|distribución|distribucion|reparto|visita|entregado)'))
     or o.estado in
     ('enviado','en_camino','visita_fallida','en_sucursal','retiro_pendiente',
      'retiro_vencido','en_devolucion','devuelto_beyonix','entregado')
     then v_reasons := array_append(v_reasons,'tracking_in_circuit'); end if;
  if exists (select 1 from public.mercadopago_order_refunds r where r.order_id = p_order_id
             and r.status in ('requested','processing','needs_reconciliation'))
     then v_reasons := array_append(v_reasons,'refund_in_progress'); end if;
  return v_reasons;
end $$;

-- 5. Guardas Andreani dentro de las RPC de cancelación y preparación ----------
-- Se reemplaza sólo la condición indicada de la definición vigente (mismo
-- método que 20261023100000). Si ya está reemplazada o esa versión no tiene la
-- guarda, no hace nada; si aparece más de una vez, la migración falla (nunca se
-- aplica a medias). Una función ausente (bases de prueba parciales) se saltea.
do $migration$
declare
  v_target record;
  v_definition text;
  v_matches integer;
begin
  for v_target in
    select * from (values
      ('public.request_customer_order_cancellation_with_claim(bigint,uuid,text)',
       $old$if v_order.andreani_creation_status = 'claimed' then$old$,
       $new$if v_order.andreani_creation_status = 'claimed' and not public.order_is_local_delivery(v_order) then$new$),
      ('public.request_customer_order_cancellation_with_claim(bigint,uuid,text)',
       $old$if v_order.andreani_creation_status = 'reconciliation_required' then$old$,
       $new$if v_order.andreani_creation_status = 'reconciliation_required' and not public.order_is_local_delivery(v_order) then$new$),
      ('public.admin_cancel_order(bigint,uuid,text,text,text,text)',
       $old$if v_order.andreani_creation_status = 'claimed' then$old$,
       $new$if v_order.andreani_creation_status = 'claimed' and not public.order_is_local_delivery(v_order) then$new$),
      ('public.admin_cancel_order(bigint,uuid,text,text,text,text)',
       $old$if v_order.andreani_creation_status = 'reconciliation_required' then$old$,
       $new$if v_order.andreani_creation_status = 'reconciliation_required' and not public.order_is_local_delivery(v_order) then$new$),
      ('public.approve_order_claim_cancellation(bigint,uuid,text,text)',
       $old$if v_order.andreani_creation_status = 'claimed' then$old$,
       $new$if v_order.andreani_creation_status = 'claimed' and not public.order_is_local_delivery(v_order) then$new$),
      ('public.approve_order_claim_cancellation(bigint,uuid,text,text)',
       $old$if v_order.andreani_creation_status = 'reconciliation_required' then$old$,
       $new$if v_order.andreani_creation_status = 'reconciliation_required' and not public.order_is_local_delivery(v_order) then$new$),
      ('public.set_order_package_parcels(bigint,integer,uuid,uuid)',
       $old$where id = p_order_id and andreani_handed_over_at is not null) then$old$,
       $new$where id = p_order_id and andreani_handed_over_at is not null and not public.order_is_local_delivery(ordenes)) then$new$),
      ('public.reset_order_preparation(bigint,uuid,uuid,text)',
       $old$where id=p_order_id and andreani_handed_over_at is not null) then$old$,
       $new$where id=p_order_id and andreani_handed_over_at is not null and not public.order_is_local_delivery(ordenes)) then$new$),
      -- Cancelación automática (worker): NC C y reintegro MP sin despacho.
      ('public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text)',
       $old$and o.andreani_handed_over_at is null$old$,
       $new$and (o.andreani_handed_over_at is null or public.order_is_local_delivery(o))$new$),
      ('public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text)',
       $old$and nullif(btrim(coalesce(o.andreani_envio_id, '')), '') is null$old$,
       $new$and (nullif(btrim(coalesce(o.andreani_envio_id, '')), '') is null or public.order_is_local_delivery(o))$new$),
      ('public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text)',
       $old$and nullif(btrim(coalesce(o.tracking_number, '')), '') is null$old$,
       $new$and (nullif(btrim(coalesce(o.tracking_number, '')), '') is null or public.order_is_local_delivery(o))$new$),
      ('public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text)',
       $old$and nullif(btrim(coalesce(o.andreani_tracking, '')), '') is null$old$,
       $new$and (nullif(btrim(coalesce(o.andreani_tracking, '')), '') is null or public.order_is_local_delivery(o))$new$),
      ('public.begin_mercadopago_order_refund(bigint,uuid)',
       $old$and v_order.andreani_handed_over_at is null$old$,
       $new$and (v_order.andreani_handed_over_at is null or public.order_is_local_delivery(v_order))$new$),
      ('public.super_admin_cancel_order(bigint,uuid,text,text)',
       $old$v_dispatched := v_order.andreani_handed_over_at is not null$old$,
       $new$v_dispatched := (v_order.andreani_handed_over_at is not null and not public.order_is_local_delivery(v_order))$new$)
    ) as t(signature, old_text, new_text)
  loop
    if to_regprocedure(v_target.signature) is null then
      raise notice 'Función % ausente: sin cambios', v_target.signature;
      continue;
    end if;
    v_definition := pg_get_functiondef(to_regprocedure(v_target.signature));
    if position(v_target.new_text in v_definition) > 0 then continue; end if;
    v_matches := (length(v_definition) - length(replace(v_definition, v_target.old_text, ''))) / length(v_target.old_text);
    if v_matches = 0 then
      -- Esa versión de la función no tiene esta guarda Andreani: nada que neutralizar.
      raise notice 'Guarda Andreani ausente en %: sin cambios', v_target.signature;
      continue;
    end if;
    if v_matches > 1 then
      raise exception 'Guarda Andreani ambigua en % (%)', v_target.signature, v_matches;
    end if;
    execute replace(v_definition, v_target.old_text, v_target.new_text);
  end loop;
end
$migration$;

revoke all on function public.record_local_delivery_labels_generated(bigint, uuid, bigint, integer, text[])
  from public, anon, authenticated;
grant execute on function public.record_local_delivery_labels_generated(bigint, uuid, bigint, integer, text[])
  to service_role;

notify pgrst, 'reload schema';

commit;
