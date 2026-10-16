-- Cancelación con pickeo: "manual" = un Admin autoriza el reintegro DESDE
-- BEYONIX. Nada vuelve solo al cliente después del primer pickeo.
--
-- 1. Reintegro por Mercado Pago iniciado por Admin: se permite después del
--    pickeo (y de una tanda cerrada), con la retención física ya resuelta.
--    El worker (requested_by NULL) sigue rechazado. El refund usa el camino
--    existente: begin_mercadopago_order_refund (monto server-side =
--    payment_confirmed_amount, idempotente, conciliable) + NC C autorizada
--    (guard_refund_requires_invoice). En un pago combinado el saldo vuelve con
--    la NC, nunca con el refund.
-- 2. Saldo a favor / customer credit: la resolución física deja de llamar a
--    reverse_customer_credit_for_order, y esa función difiere SIEMPRE el saldo
--    de un pedido con pickeo (aun sin obligación fiscal). Sólo vuelve:
--      * con la NC C autorizada que emite Admin (circuito fiscal), o
--      * sin obligación fiscal, con release_cancelled_order_customer_credit,
--        acción explícita de Admin.

begin;

-- 1a. Reserva: con corte de preparación sólo se excluye el saldo BEYONIX
-- (definición de 20261015160000; cambia únicamente esa condición).
create or replace function public.reserve_order_financial_resolution(
  p_order_id bigint,p_actor_id uuid,p_choice text
) returns public.order_financial_resolutions
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp as $$
declare v_order public.ordenes%rowtype; v_row public.order_financial_resolutions%rowtype;
  v_amount numeric; v_paid_amount numeric; v_note_amount numeric; v_role text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FINANCIAL_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id=p_actor_id;
  if coalesce(v_role,'') not in ('admin','super_admin') then raise exception 'FINANCIAL_FORBIDDEN'; end if;
  if p_choice not in ('beyonix_credit','mercadopago_refund','manual_refund') then raise exception 'FINANCIAL_INVALID_CHOICE'; end if;
  select * into v_order from public.ordenes where id=p_order_id for update;
  if not found then raise exception 'FINANCIAL_ORDER_NOT_FOUND'; end if;
  select * into v_row from public.order_financial_resolutions where order_id=p_order_id for update;
  if found then
    if v_row.choice<>p_choice then raise exception 'FINANCIAL_CHOICE_CONFLICT'; end if;
    return v_row;
  end if;
  if v_order.financial_status is distinct from 'refund_pending' or v_order.andreani_handed_over_at is not null
     or v_order.paid_at is null or v_order.payment_status not in ('approved','confirmed','confirmado') then
    raise exception 'FINANCIAL_NOT_PENDING';
  end if;
  -- NUEVO: con pickeo o tanda cerrada, reintegro manual o Mercado Pago, ambos
  -- por decisión del Admin que llama a esta RPC. Nunca saldo BEYONIX.
  if public.order_was_prepared_for_dispatch(p_order_id) and p_choice='beyonix_credit' then
    raise exception 'FINANCIAL_PREPARED_MANUAL_ONLY';
  end if;
  if p_choice='mercadopago_refund' and v_order.payment_method_id is distinct from 'mercadopago' then
    raise exception 'FINANCIAL_INVALID_PAYMENT_METHOD';
  end if;
  if p_choice='beyonix_credit' and v_order.usuario_id is null then raise exception 'FINANCIAL_NO_ACCOUNT'; end if;
  v_paid_amount := coalesce(nullif(v_order.payment_confirmed_amount,0),nullif(v_order.external_amount_due,0));
  if v_paid_amount is null or v_paid_amount<=0 then raise exception 'FINANCIAL_AMOUNT_INVALID'; end if;
  select coalesce(sum(coalesce(external_amount,total_amount)),0) into v_note_amount from public.order_credit_notes
    where order_id=p_order_id and status='authorized' and destination='external_refund'
      and settlement_status is distinct from 'completado' and cae is not null;
  if v_note_amount>v_paid_amount then raise exception 'FINANCIAL_AMOUNT_INVALID'; end if;
  if p_choice='manual_refund' and v_order.payment_method_id is distinct from 'transferencia' and
     not (v_order.payment_method_id='mercadopago' and
       (public.order_was_prepared_for_dispatch(p_order_id) or (v_note_amount>0 and v_note_amount<v_paid_amount))) then
    raise exception 'FINANCIAL_INVALID_PAYMENT_METHOD';
  end if;
  v_amount := case when p_choice='manual_refund' and v_note_amount>0 then v_note_amount else v_paid_amount end;
  if p_choice='mercadopago_refund' and (v_paid_amount>40000 or nullif(btrim(v_order.payment_id),'') is null
      or (v_note_amount>0 and v_note_amount<>v_paid_amount)) then
    raise exception 'FINANCIAL_MP_INELIGIBLE';
  end if;
  if p_choice='mercadopago_refund' and (
     lower(coalesce(v_order.estado,'')) in ('enviado','en_camino','visita_fallida','en_sucursal','retiro_pendiente','retiro_vencido','en_devolucion','devuelto_beyonix','entregado')
     or nullif(btrim(v_order.tracking_number),'') is not null
     or nullif(btrim(v_order.andreani_tracking),'') is not null
     or nullif(btrim(v_order.andreani_envio_id),'') is not null
  ) then raise exception 'FINANCIAL_RETURN_REQUIRED'; end if;
  if p_choice='beyonix_credit' and exists(select 1 from public.order_credit_notes
       where order_id=p_order_id and status='authorized' and destination='customer_balance' and cae is not null) then
    raise exception 'FINANCIAL_ALREADY_MOVING';
  end if;
  if exists(select 1 from public.order_refund_proofs where order_id=p_order_id) or
     exists(select 1 from public.mercadopago_order_refunds where order_id=p_order_id and status in ('confirmed','processing','needs_reconciliation')) then
    raise exception 'FINANCIAL_ALREADY_MOVING';
  end if;
  insert into public.order_financial_resolutions(order_id,choice,amount,selected_by)
    values(p_order_id,p_choice,v_amount,p_actor_id) returning * into v_row;
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
    values(p_order_id,'admin',p_actor_id,'financial_resolution_selected',v_order.financial_status,'reserved',
      jsonb_build_object('choice',p_choice,'amount',v_amount,'resolutionId',v_row.id,
        'preparedCut',public.order_was_prepared_for_dispatch(p_order_id)));
  return v_row;
end;
$$;
revoke all on function public.reserve_order_financial_resolution(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_order_financial_resolution(bigint,uuid,text) to service_role;

-- 1b. Refund MP con corte de preparación: sólo si lo inició un Admin.
create or replace function public.guard_claim_mercadopago_refund()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public,pg_temp
as $$
begin
  if new.status='processing' and (tg_op='INSERT' or old.status is distinct from 'processing') then
    -- Antes: cualquier refund con corte de preparación se rechazaba. Ahora el
    -- automático (worker, requested_by NULL) sigue rechazado y el de Admin pasa.
    if public.order_was_prepared_for_dispatch(new.order_id) and new.requested_by is null then
      raise exception 'REFUND_PREPARED_BATCH';
    end if;
    if exists (select 1 from public.ordenes where id=new.order_id and andreani_handed_over_at is not null) then
      raise exception 'REFUND_HANDED_OVER';
    end if;
    if exists (select 1 from public.order_financial_resolutions
               where order_id=new.order_id and choice<>'mercadopago_refund') then
      raise exception 'FINANCIAL_CHOICE_CONFLICT';
    end if;
    perform public.assert_order_claim_money_released(new.order_id);
  end if;
  return new;
end;
$$;
revoke all on function public.guard_claim_mercadopago_refund() from public, anon, authenticated;

-- 2a. Saldo diferido siempre en pedidos con pickeo. Sólo la liberación
-- explícita de Admin (flag de transacción) levanta la condición de pickeo; la
-- obligación fiscal (NC) se exige igual.
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
  ) or (
    public.order_cancelled_after_picking(p_order_id)
    and coalesce(current_setting('beyonix.admin_credit_release', true), '') is distinct from p_order_id::text
  )
$$;
revoke all on function public.order_customer_credit_reversal_on_hold(bigint) from public, anon, authenticated;
grant execute on function public.order_customer_credit_reversal_on_hold(bigint) to service_role;

create or replace function public.release_cancelled_order_customer_credit(p_order_id bigint, p_actor_id uuid)
returns table(movement_id uuid, restored_amount numeric)
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_order public.ordenes%rowtype; v_movement uuid; v_amount numeric;
begin
  if auth.role() is distinct from 'service_role'
     or not exists (select 1 from public.profiles where id = p_actor_id and rol in ('admin','super_admin')) then
    raise exception 'FINANCIAL_FORBIDDEN';
  end if;
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'FINANCIAL_ORDER_NOT_FOUND'; end if;
  if v_order.estado is distinct from 'cancelado' then raise exception 'FINANCIAL_NOT_PENDING'; end if;
  if public.order_has_active_stock_hold(p_order_id) then raise exception 'DISPATCH_PHYSICAL_RESOLUTION_REQUIRED'; end if;
  -- Venta con obligación fiscal: el saldo vuelve sólo con la NC C.
  if v_order.invoice_queued_at is not null or v_order.invoice_cae is not null then
    raise exception 'CREDIT_NOTE_REQUIRED_BEFORE_REFUND';
  end if;
  perform set_config('beyonix.admin_credit_release', p_order_id::text, true);
  select r.movement_id, r.restored_amount into v_movement, v_amount
    from public.reverse_customer_credit_for_order(p_order_id,
      'Reintegro de saldo a favor autorizado por administración', p_actor_id) r;
  perform set_config('beyonix.admin_credit_release', '', true);
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
    values (p_order_id, 'admin', p_actor_id, 'customer_credit_released_by_admin', null, null,
      jsonb_build_object('movementId', v_movement, 'amount', v_amount));
  movement_id := v_movement; restored_amount := v_amount;
  return next;
end $$;
revoke all on function public.release_cancelled_order_customer_credit(bigint, uuid) from public, anon, authenticated;
grant execute on function public.release_cancelled_order_customer_credit(bigint, uuid) to service_role;

-- 2b. Resolución física: igual que 20261016110000 SIN la restitución de saldo.
-- Sólo stock, retiro del lote y auditoría.
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
  -- Sin saldo, dinero ni estado financiero: eso es siempre una acción de Admin.

  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
    values (v_order_id, 'admin', p_actor_id, 'dispatch_cancellation_physically_resolved',
      'requires_physical_resolution', 'physically_returned',
      jsonb_build_object('holdId', v_hold.id, 'code', v_code, 'batchId', v_item.batch_id,
        'batchCode', v_batch.code, 'pickedUnits', v_hold.picked_units, 'prepared', v_hold.prepared,
        'financial', 'manual_refund_required')),
      (v_order_id, 'admin', p_actor_id, 'dispatch_cancellation_stock_restored',
      'stock_held', 'stock_restored',
      jsonb_build_object('holdId', v_hold.id, 'units', v_hold.units, 'items', v_hold.items));

  return jsonb_build_object('orderId', v_order_id, 'units', v_hold.units, 'pickedUnits', v_hold.picked_units,
    'items', v_hold.items, 'batchId', v_item.batch_id, 'batchCode', v_batch.code,
    'duplicate', false, 'alreadyResolved', false);
end $$;
revoke all on function public.resolve_cancelled_order_preparation(text, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.resolve_cancelled_order_preparation(text, uuid, uuid, bigint) to service_role;

notify pgrst, 'reload schema';

commit;
