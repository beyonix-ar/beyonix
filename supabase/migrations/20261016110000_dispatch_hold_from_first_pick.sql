-- Ajuste de la regla operativa de 20261016100000 (retención física):
--
-- 1. La retención nace con el PRIMER pickeo válido, no con el armado completo.
--    Desde que existe un escaneo registrado del pedido (cualquier intento) puede
--    haber mercadería fuera de estantería. Sin ningún escaneo, la cancelación
--    sigue el circuito automático de siempre.
--    Concurrencia: guard_preparation_scan_active_order toma el pedido FOR SHARE
--    antes de insertar el escaneo. Si la cancelación llega primero, el escaneo
--    espera y se rechaza (no queda pickeo de un cancelado); si el escaneo llega
--    primero, la cancelación espera su commit y ve el escaneo (retiene).
--
-- 2. Con retención activa no se devuelve NADA en forma automática: ni Mercado
--    Pago, ni transferencia, ni saldo a favor, ni partes de un pago combinado.
--    * order_customer_credit_reversal_on_hold() también es verdadero con
--      retención: reverse_customer_credit_for_order difiere (lo llaman todas las
--      cancelaciones) en vez de restaurar el saldo en el acto.
--    * Ningún camino puede pasar el pedido a financial_status='refunded'
--      mientras haya retención (guard en ordenes), además de las guardas de
--      NC, refund MP, resolución financiera y comprobante de 20261016100000.
--    * Al resolver el retiro se reintenta la restitución del saldo con la regla
--      de siempre (idempotente): con obligación fiscal la hace la NC autorizada
--      (reparto de pagos combinados sin cambios); sin obligación, en el acto.
--
-- 3. El worker de cancelaciones excluye explícitamente: retención activa,
--    pedido todavía dentro de cualquier lote y pedidos con corte de lote
--    cerrado (sólo reintegro manual). Un pedido retirado de un lote cerrado
--    POR la resolución física deja de contar como "preparado para despacho"
--    (la mercadería volvió confirmada por escaneo): vuelve a ser elegible.

begin;

alter table public.order_cancellation_holds
  add column if not exists picked_units integer not null default 0 check (picked_units >= 0),
  add column if not exists prepared boolean not null default true;
comment on column public.order_cancellation_holds.picked_units is
  'Unidades escaneadas al momento de la cancelación (intento vigente).';
comment on column public.order_cancellation_holds.prepared is
  'true = armado completo (con código BX-PREP/etiquetas); false = pickeo parcial.';

-- 1. Detección desde el primer pickeo -------------------------------------------
create or replace function public.capture_prepared_order_stock_hold()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_package public.order_packages%rowtype;
  v_items jsonb;
  v_units integer;
  v_picked integer;
  v_batch_id bigint;
  v_hold_id bigint;
begin
  if not public.inventory_order_consumes_stock(old.estado, old.payment_status)
     or public.inventory_order_consumes_stock(new.estado, new.payment_status)
     or new.andreani_handed_over_at is not null then
    return new;
  end if;
  select * into v_package from public.order_packages where order_id = new.id;
  -- Sin escaneos registrados (en ningún intento) no hay nada fuera de estantería.
  if not found
     or not exists (select 1 from public.order_preparation_scans s where s.package_id = v_package.id)
     or public.order_has_active_stock_hold(new.id) then
    return new;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('orderItemId', i.id, 'productId', i.producto_id,
           'variantId', i.variante_id, 'conditionedStockId', i.conditioned_stock_id,
           'quantity', i.cantidad) order by i.id), '[]'::jsonb),
         coalesce(sum(i.cantidad), 0)::integer
    into v_items, v_units
    from public.orden_items i where i.orden_id = new.id;
  if v_units <= 0 then return new; end if;
  select coalesce(sum(l.scanned_quantity), 0)::integer into v_picked
    from public.order_preparation_lines l where l.package_id = v_package.id;
  select batch_id into v_batch_id from public.dispatch_batch_items
    where order_id = new.id and removed_at is null;
  insert into public.order_cancellation_holds(order_id, package_id, attempt_number, batch_id,
      items, units, picked_units, prepared, previous_estado, previous_payment_status)
    values (new.id, v_package.id, v_package.attempt_number, v_batch_id, v_items, v_units,
      v_picked, v_package.status = 'prepared', old.estado, old.payment_status)
    returning id into v_hold_id;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
    values (new.id, 'system', null, 'dispatch_cancellation_hold_created',
      case when v_package.status = 'prepared' then 'prepared' else 'packing' end,
      'requires_physical_resolution', jsonb_build_object('holdId', v_hold_id, 'packageId', v_package.id,
        'attempt', v_package.attempt_number, 'batchId', v_batch_id, 'units', v_units,
        'pickedUnits', v_picked, 'prepared', v_package.status = 'prepared',
        'previousEstado', old.estado, 'newEstado', new.estado));
  return new;
end $$;

-- 2. Nada de dinero ni saldo mientras haya retención -----------------------------
create or replace function public.order_customer_credit_reversal_on_hold(p_order_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.ordenes o
    where o.id = p_order_id
      and (o.invoice_queued_at is not null or o.invoice_cae is not null)
  ) or public.order_has_active_stock_hold(p_order_id)
$$;
revoke all on function public.order_customer_credit_reversal_on_hold(bigint) from public, anon, authenticated;
grant execute on function public.order_customer_credit_reversal_on_hold(bigint) to service_role;

create or replace function public.guard_refunded_during_stock_hold()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.financial_status = 'refunded' and old.financial_status is distinct from 'refunded'
     and public.order_has_active_stock_hold(new.id) then
    raise exception 'DISPATCH_PHYSICAL_RESOLUTION_REQUIRED';
  end if;
  return new;
end $$;
create trigger guard_refunded_during_stock_hold
  before update of financial_status on public.ordenes
  for each row execute function public.guard_refunded_during_stock_hold();

-- 3. Corte de lote cerrado: la resolución física lo levanta -----------------------
create or replace function public.order_was_prepared_for_dispatch(p_order_id bigint)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1 from public.dispatch_batch_items i
    join public.dispatch_batches b on b.id=i.batch_id
    where i.order_id=p_order_id and b.prepared_at is not null
      and (i.removed_at is null or i.removed_at >= b.closed_at)
      -- Retirado de ese lote por el escaneo de retiro físico: la mercadería
      -- volvió y el circuito fiscal/financiero sigue como antes del lote.
      and not exists (select 1 from public.order_cancellation_holds h
                      where h.order_id = i.order_id and h.resolved_at is not null
                        and h.resolution_batch_id = i.batch_id)
  );
$$;
revoke all on function public.order_was_prepared_for_dispatch(bigint) from public,anon,authenticated;
grant execute on function public.order_was_prepared_for_dispatch(bigint) to service_role;

create or replace function public.claim_auto_cancellation(p_lease interval default interval '5 minutes')
returns setof public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare v_order public.ordenes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN'; end if;
  select * into v_order from public.ordenes o
  where o.estado = 'cancelado' and o.financial_status = 'refund_pending'
    and o.invoice_status = 'authorized' and o.invoice_cae is not null
    and o.invoice_queued_at is not null
    and exists (select 1 from public.arca_auto_invoicing_control c
      where c.id = true and c.enabled = true
        and greatest(o.invoice_queued_at, o.cancellation_requested_at, o.cancelled_at, o.refund_pending_at) > c.cutoff_at)
    -- Bloqueo operativo: retención física, pedido todavía en un lote o corte
    -- de lote cerrado (reintegro sólo manual). Nunca se intenta para fallar.
    and not exists (select 1 from public.order_cancellation_holds h
      where h.order_id = o.id and h.resolved_at is null)
    and not exists (select 1 from public.dispatch_batch_items i
      where i.order_id = o.id and i.removed_at is null)
    and not public.order_was_prepared_for_dispatch(o.id)
    and o.auto_cancellation_next_attempt_at <= clock_timestamp()
    and (o.auto_cancellation_claimed_until is null or o.auto_cancellation_claimed_until <= clock_timestamp())
  order by o.auto_cancellation_next_attempt_at, o.id
  limit 1 for update of o skip locked;
  if not found then return; end if;
  update public.ordenes set auto_cancellation_claimed_until = clock_timestamp() + p_lease,
    auto_cancellation_attempts = auto_cancellation_attempts + 1
  where id = v_order.id returning * into v_order;
  return next v_order;
end $$;
revoke all on function public.claim_auto_cancellation(interval) from public, anon, authenticated;
grant execute on function public.claim_auto_cancellation(interval) to service_role;

-- Resolución: igual que 20261016100000 + pickeo parcial (sin etiquetas: vale el
-- código del pedido BX-NNNN o BX-PREP) + restitución diferida del saldo.
create or replace function public.resolve_cancelled_order_preparation(
  p_code text, p_actor_id uuid, p_request_key uuid, p_expected_order_id bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_match text[];
  v_order_id bigint;
  v_attempt integer;
  v_order_code boolean := false;
  v_parcel public.order_package_parcels%rowtype;
  v_hold public.order_cancellation_holds%rowtype;
  v_batch public.dispatch_batches%rowtype;
  v_item public.dispatch_batch_items%rowtype;
  v_product_id bigint;
  v_order public.ordenes%rowtype;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null or v_code = '' or length(v_code) > 64 then
    raise exception 'DISPATCH_SCAN_INVALID'; end if;

  select * into v_hold from public.order_cancellation_holds where resolution_request_key = p_request_key;
  if found then
    if v_hold.resolution_code <> v_code then raise exception 'DISPATCH_SCAN_KEY_CONFLICT'; end if;
    return jsonb_build_object('orderId', v_hold.order_id, 'units', v_hold.units, 'pickedUnits', v_hold.picked_units,
      'items', v_hold.items, 'batchId', v_hold.resolution_batch_id, 'duplicate', true, 'alreadyResolved', true);
  end if;

  v_match := regexp_match(v_code, '^BX-PREP-([0-9]+)(?:-R([0-9]+))?$');
  if v_match is not null then
    v_order_id := v_match[1]::bigint - 1000;
    v_attempt := coalesce(v_match[2]::integer, 1);
  else
    v_match := regexp_match(v_code, '^#?BX-([0-9]+)$');
    if v_match is not null then
      v_order_id := v_match[1]::bigint - 1000;
      v_order_code := true;
    else
      select * into v_parcel from public.order_package_parcels where barcode = v_code;
      if found then
        v_order_id := v_parcel.order_id;
        v_attempt := v_parcel.attempt_number;
      elsif v_code ~ '^DSP-' then raise exception 'DISPATCH_CODE_IS_BATCH';
      elsif v_code ~ '^BX-PKG-' then raise exception 'DISPATCH_PARCEL_UNKNOWN';
      elsif exists (select 1 from public.catalog_barcode_registry
                    where normalized_barcode = public.normalized_catalog_barcode(p_code))
         or exists (select 1 from public.catalog_sku_registry
                    where normalized_sku = public.normalized_catalog_sku(p_code)) then
        raise exception 'DISPATCH_RESOLUTION_CODE_IS_PRODUCT';
      else raise exception 'DISPATCH_CODE_UNKNOWN';
      end if;
    end if;
  end if;
  if v_order_id is null or v_order_id <= 0 then raise exception 'DISPATCH_CODE_UNKNOWN'; end if;
  if p_expected_order_id is not null and p_expected_order_id <> v_order_id then
    raise exception 'DISPATCH_RESOLUTION_WRONG_ORDER' using detail = v_order_id::text; end if;

  perform 1 from public.ordenes where id = v_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  select * into v_hold from public.order_cancellation_holds
    where order_id = v_order_id and resolved_at is null for update;
  if not found then
    select * into v_hold from public.order_cancellation_holds
      where order_id = v_order_id order by resolved_at desc nulls last limit 1;
    if found then
      return jsonb_build_object('orderId', v_order_id, 'units', v_hold.units, 'pickedUnits', v_hold.picked_units,
        'items', v_hold.items, 'batchId', v_hold.resolution_batch_id, 'duplicate', true, 'alreadyResolved', true);
    end if;
    raise exception 'DISPATCH_RESOLUTION_NOT_REQUIRED' using detail = v_order_id::text;
  end if;
  -- Armado completo: hay etiquetas, se exige una (BX-PREP o bulto) del intento
  -- retenido. El código BX-NNNN sólo identifica pickeos parciales (sin etiqueta).
  if v_order_code and v_hold.prepared then raise exception 'DISPATCH_RESOLUTION_LABEL_REQUIRED'; end if;
  if not v_order_code and v_attempt <> v_hold.attempt_number then
    raise exception 'DISPATCH_PARCEL_STALE' using detail = v_order_id::text; end if;

  select * into v_item from public.dispatch_batch_items where order_id = v_order_id and removed_at is null;
  if found then
    select * into v_batch from public.dispatch_batches where id = v_item.batch_id;
    perform public.remove_order_from_dispatch_batch(v_item.batch_id, v_order_id, p_actor_id,
      'Pedido cancelado retirado físicamente del lote (escaneo ' || v_code || ')');
  end if;

  update public.order_cancellation_holds set resolved_at = now(), resolved_by = p_actor_id,
      resolution_request_key = p_request_key, resolution_code = v_code,
      resolution_batch_id = v_item.batch_id
    where id = v_hold.id returning * into v_hold;

  for v_product_id in
    select distinct (item->>'productId')::bigint from jsonb_array_elements(v_hold.items) item
      order by 1
  loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;
  perform public.sync_dispatch_blocks(v_order_id);

  -- Saldo a favor: la regla de siempre, recién ahora (idempotente). Con
  -- obligación fiscal sigue diferido y lo restituye la NC autorizada.
  select * into v_order from public.ordenes where id = v_order_id;
  if v_order.estado = 'cancelado' and coalesce(v_order.credit_balance_used, 0) > 0 then
    perform * from public.reverse_customer_credit_for_order(v_order_id,
      'Reintegro de saldo a favor por cancelación (después del retiro físico)', p_actor_id);
  end if;

  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
    values (v_order_id, 'admin', p_actor_id, 'dispatch_cancellation_physically_resolved',
      'requires_physical_resolution', 'physically_returned',
      jsonb_build_object('holdId', v_hold.id, 'code', v_code, 'batchId', v_item.batch_id,
        'batchCode', v_batch.code, 'pickedUnits', v_hold.picked_units, 'prepared', v_hold.prepared)),
      (v_order_id, 'admin', p_actor_id, 'dispatch_cancellation_stock_restored',
      'stock_held', 'stock_restored',
      jsonb_build_object('holdId', v_hold.id, 'units', v_hold.units, 'items', v_hold.items));

  return jsonb_build_object('orderId', v_order_id, 'units', v_hold.units, 'pickedUnits', v_hold.picked_units,
    'items', v_hold.items, 'batchId', v_item.batch_id, 'batchCode', v_batch.code,
    'duplicate', false, 'alreadyResolved', false);
end $$;

revoke all on function public.capture_prepared_order_stock_hold(),
  public.guard_refunded_during_stock_hold(),
  public.resolve_cancelled_order_preparation(text, uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.resolve_cancelled_order_preparation(text, uuid, uuid, bigint) to service_role;

notify pgrst, 'reload schema';

commit;
