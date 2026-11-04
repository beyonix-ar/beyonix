-- Envío BEYONIX: preparación, bultos físicos y etiqueta propia ----------------
-- MIGRACIÓN A (estructural, compatible con el código ya desplegado).
--
-- Orden de despliegue:
--   1. esta migración (A);
--   2. código nuevo (define/imprime/confirma bultos y exige bultos listos
--      antes de En camino desde la aplicación);
--   3. verificación en producción;
--   4. 20261103130000_local_delivery_in_transit_parcels_guard.sql (B), que
--      recién entonces exige lo mismo en la base.
-- Esta migración NO bloquea el flujo local actual: el código anterior sigue
-- pasando un pedido local a En camino exactamente como antes (no existe
-- todavía ninguna guarda de bultos sobre `ordenes.estado`).
--
-- Reutiliza el pickeo y los bultos físicos (order_packages /
-- order_package_parcels, códigos BX-PKG-<1000+pedido>[-R<intento>]-NN) del
-- circuito de Despachos, sin tocar a Andreani:
--
-- 1. dispatch_order_block_reasons: un pedido Envío BEYONIX deja de figurar
--    como `wrong_carrier` (bloqueaba el pickeo) y queda SIEMPRE
--    `shipment_pending` para el circuito Andreani. `shipment_pending` no frena
--    el pickeo ni los bultos (misma excepción que ya usan begin/scan/adjust/
--    set_parcels), pero sí impide entrar a un Bulto general Andreani, su
--    verificación y su entrega: un pedido local nunca recibe guía, etiqueta
--    ni handover Andreani, aunque tuviera un andreani_envio_id residual.
--    Para pedidos Andreani la función devuelve exactamente lo mismo que antes.
-- 2. Confirmación física de cada etiqueta Envío BEYONIX: se escanea el BX-PKG
--    del bulto (label_confirmed_at/by). Imprimir no confirma nada.
-- 3. Bultos de un intento: una vez definidos para un pedido local, cambiar la
--    cantidad exige rearmar (intento nuevo => códigos -R<n> nuevos), así una
--    etiqueta ya impresa nunca queda con un "Bulto X de N" equivocado.
-- 4. local_delivery_parcels_ready(): helper de "bultos listos". Lo usan la
--    RPC de En camino del código nuevo (6) y la guarda global de la migración B.
-- 5. Un pedido local ya En camino/Entregado no se puede rearmar, y nunca se
--    identifica con una etiqueta Andreani (aunque tenga un envío residual).
-- 6. mark_local_delivery_in_transit(): Preparando → En camino atómico para el
--    código nuevo (bultos vigentes y confirmados comprobados bajo lock en la
--    misma transacción del UPDATE). Así el código nuevo es seguro aunque B
--    todavía no esté aplicada. El código anterior no la usa.

begin;

-- 1. Motivos de bloqueo --------------------------------------------------------
-- Igual que 20261016160000 salvo wrong_carrier/shipment_pending para 'beyonix'.
create or replace function public.dispatch_order_block_reasons(p_order_id bigint)
returns text[] language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare o public.ordenes%rowtype; v_reasons text[] := '{}'; v_provider text;
begin
  select * into o from public.ordenes where id = p_order_id;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  v_provider := lower(coalesce(o.shipping_provider,o.envio_proveedor,''));
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
  if o.andreani_creation_status in ('claimed','reconciliation_required')
     then v_reasons := array_append(v_reasons,'shipment_uncertain'); end if;
  if o.andreani_handed_over_at is not null
     then v_reasons := array_append(v_reasons,'already_handed_over'); end if;
  if o.andreani_tracking_event_at is not null or nullif(btrim(o.tracking_number),'') is not null
     or lower(coalesce(o.andreani_estado,'')) ~ '(camino|tránsito|transito|distribución|distribucion|reparto|visita|entregado)'
     or o.estado in
     ('enviado','en_camino','visita_fallida','en_sucursal','retiro_pendiente',
      'retiro_vencido','en_devolucion','devuelto_beyonix','entregado')
     then v_reasons := array_append(v_reasons,'tracking_in_circuit'); end if;
  if exists (select 1 from public.mercadopago_order_refunds r where r.order_id = p_order_id
             and r.status in ('requested','processing','needs_reconciliation'))
     then v_reasons := array_append(v_reasons,'refund_in_progress'); end if;
  return v_reasons;
end $$;

-- 2. Confirmación física de cada bulto ----------------------------------------
alter table public.order_package_parcels
  add column if not exists label_confirmed_at timestamptz,
  add column if not exists label_confirmed_by uuid;
alter table public.order_package_parcels
  add constraint order_package_parcels_label_confirmation_pair_check
    check ((label_confirmed_at is null) = (label_confirmed_by is null));

create or replace function public.order_is_local_delivery(p_order public.ordenes)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp as $$
  select lower(coalesce(p_order.shipping_provider, p_order.envio_proveedor, '')) = 'beyonix'
$$;

/** Todos los bultos del intento vigente definidos y con su etiqueta confirmada. */
create or replace function public.local_delivery_parcels_ready(p_order_id bigint)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1 from public.order_packages k
    where k.order_id = p_order_id and k.status = 'prepared' and k.parcel_count is not null
      and (select count(*) from public.order_package_parcels p
           where p.package_id = k.id and p.attempt_number = k.attempt_number
             and p.parcel_count = k.parcel_count and p.label_confirmed_at is not null) = k.parcel_count)
$$;

-- Escanear el BX-PKG impreso y pegado en el bulto. Releer el mismo es
-- idempotente; un bulto de otro pedido o de un intento anterior se rechaza.
create or replace function public.confirm_local_delivery_parcel(
  p_order_id bigint, p_code text, p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order public.ordenes%rowtype;
  v_package public.order_packages%rowtype;
  v_parcel public.order_package_parcels%rowtype;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_duplicate boolean := false;
  v_confirmed integer;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if v_code = '' or length(v_code) > 128 then raise exception 'DISPATCH_LABEL_CODE_INVALID'; end if;
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  if not public.order_is_local_delivery(v_order) then raise exception 'DISPATCH_LOCAL_DELIVERY_ONLY'; end if;
  if exists (select 1 from unnest(public.dispatch_order_block_reasons(p_order_id)) r
             where r not in ('invoice_pending','shipment_pending'))
     or exists (select 1 from public.dispatch_blocks where order_id = p_order_id
                and source = 'manual' and resolved_at is null) then
    raise exception 'DISPATCH_ORDER_BLOCKED'; end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_PREPARATION_NOT_STARTED'; end if;
  if v_package.status <> 'prepared' then raise exception 'DISPATCH_PACKAGE_NOT_PREPARED'; end if;
  if v_package.parcel_count is null then raise exception 'DISPATCH_LOCAL_PARCELS_PENDING'; end if;
  select * into v_parcel from public.order_package_parcels where barcode = v_code for update;
  if not found then
    if v_code ~ '^BX-PKG-' then raise exception 'DISPATCH_PARCEL_UNKNOWN'; end if;
    raise exception 'DISPATCH_LOCAL_PARCEL_CODE_REQUIRED';
  end if;
  if v_parcel.order_id <> p_order_id then
    raise exception 'DISPATCH_LABEL_MISMATCH' using detail = p_order_id::text; end if;
  if v_parcel.package_id <> v_package.id or v_parcel.attempt_number <> v_package.attempt_number
     or v_parcel.parcel_count <> v_package.parcel_count then
    raise exception 'DISPATCH_PARCEL_STALE'; end if;
  if v_parcel.label_confirmed_at is not null then
    v_duplicate := true;
  else
    update public.order_package_parcels set label_confirmed_at = now(), label_confirmed_by = p_actor_id
      where id = v_parcel.id;
    insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
      values (p_order_id, 'admin', p_actor_id, 'local_delivery_parcel_confirmed',
        jsonb_build_object('packageId', v_package.id, 'attempt', v_package.attempt_number,
          'parcelIndex', v_parcel.parcel_index, 'parcelCount', v_package.parcel_count,
          'barcode', v_parcel.barcode));
  end if;
  select count(*) into v_confirmed from public.order_package_parcels
    where package_id = v_package.id and attempt_number = v_package.attempt_number
      and parcel_count = v_package.parcel_count and label_confirmed_at is not null;
  return jsonb_build_object('orderId', p_order_id, 'code', v_parcel.barcode,
    'parcelIndex', v_parcel.parcel_index, 'parcelCount', v_package.parcel_count,
    'confirmed', v_confirmed, 'complete', v_confirmed = v_package.parcel_count,
    'duplicate', v_duplicate);
end $$;

-- 3 y 5. Bultos de un pedido local -------------------------------------------
create or replace function public.guard_local_delivery_package()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_order public.ordenes%rowtype;
begin
  select * into v_order from public.ordenes where id = new.order_id;
  if not found or not public.order_is_local_delivery(v_order) then return new; end if;
  -- Ni siquiera con un andreani_envio_id residual: un pedido local nunca se
  -- identifica con una etiqueta Andreani (confirm_order_andreani_label).
  if new.identification_method = 'andreani' and old.identification_method is distinct from 'andreani' then
    raise exception 'DISPATCH_LOCAL_DELIVERY_NO_ANDREANI';
  end if;
  if new.attempt_number <> old.attempt_number and v_order.estado in ('en_camino', 'entregado') then
    raise exception 'DISPATCH_LOCAL_ALREADY_DISPATCHED';
  end if;
  if new.attempt_number = old.attempt_number and old.parcel_count is not null
     and new.parcel_count is not null and new.parcel_count <> old.parcel_count then
    raise exception 'DISPATCH_LOCAL_PARCELS_DEFINED';
  end if;
  return new;
end $$;
create trigger guard_local_delivery_package before update on public.order_packages
  for each row execute function public.guard_local_delivery_package();

-- 6. Preparando → En camino, atómico ----------------------------------------
-- La usa el código nuevo (el anterior nunca la llama: su UPDATE sigue igual).
-- Bloquea el pedido y su preparación con el mismo orden que reset/
-- set_parcels/confirm (pedido → paquete): un rearmado, una redefinición de
-- bultos o una confirmación en curso termina antes, y cada comprobación
-- siguiente lee lo ya confirmado (READ COMMITTED, statement nuevo después del
-- lock). Recién con todo vigente escribe: si no, 0 filas (conflicto).
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
     or not public.local_delivery_parcels_ready(p_order_id) then
    return;
  end if;
  return query update public.ordenes set estado = 'en_camino' where id = p_order_id returning *;
end $$;

-- Pedidos locales ya existentes: recalcular sus bloqueos con la regla nueva.
do $$
declare v_id bigint;
begin
  for v_id in select id from public.ordenes
    where lower(coalesce(shipping_provider, envio_proveedor, '')) = 'beyonix'
  loop
    perform public.sync_dispatch_blocks(v_id);
  end loop;
end $$;

revoke all on function public.order_is_local_delivery(public.ordenes),
  public.local_delivery_parcels_ready(bigint),
  public.confirm_local_delivery_parcel(bigint, text, uuid),
  public.mark_local_delivery_in_transit(bigint, text, uuid),
  public.guard_local_delivery_package()
  from public, anon, authenticated;
grant execute on function public.order_is_local_delivery(public.ordenes),
  public.local_delivery_parcels_ready(bigint),
  public.confirm_local_delivery_parcel(bigint, text, uuid),
  public.mark_local_delivery_in_transit(bigint, text, uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
