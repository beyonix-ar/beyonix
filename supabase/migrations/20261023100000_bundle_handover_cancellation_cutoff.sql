-- El QR final del Bulto (andreani_handed_over_at) es el único corte para que el
-- cliente pueda cancelar. Consolida reglas que ya existían, sin estados nuevos.
--
-- Auditoría previa (lo que NO cambia):
--   * Retención física desde el primer pickeo (order_cancellation_holds),
--     resolución por escaneo (resolve_cancelled_order_preparation, que retira
--     el pedido del Bulto y devuelve el stock una vez), worker de cancelaciones,
--     NC/reintegro (orquestador financiero) y guardas de dinero con retención.
--   * La entrega al transportista sigue siendo hand_over_dispatch_batch (lote
--     dispatch_batches = Bulto) con el pedido bloqueado FOR UPDATE.
--
-- Problemas corregidos:
--   1. "Despachado" se calculaba por la mera existencia del envío Andreani
--      (andreani_envio_id/andreani_tracking). Ese envío se crea al terminar el
--      pickeo, ANTES del Bulto: un pedido dentro de un Bulto todavía no
--      entregado no se podía cancelar, y tampoco reintegrarse por Mercado Pago
--      después del retiro físico. order_dispatch_cutoff_reached() es ahora la
--      única regla SQL: QR final confirmado, estado de transporte real, número
--      de seguimiento manual, o un envío histórico creado sin pasar por
--      Despachos (sin order_packages: no hay forma de saber si salió).
--   2. La entrega del Bulto fallaba con el PRIMER pedido bloqueado. Ahora
--      valida TODOS los pedidos dentro de la misma transacción (con sus filas
--      bloqueadas) y devuelve la lista completa en el detalle del error.
--   3. Saldo a favor después del pickeo: sólo por elección explícita del Admin
--      y recién con la mercadería recuperada (retención resuelta, fuera de
--      todo Bulto). Antes era imposible y el asistente no podía ofrecerlo.
--   4. Avisos al cliente sin duplicados: cancelación recibida (una vez, no se
--      vuelve a "reenviar" al cerrar el reintegro), reintegro en proceso y
--      reintegro realizado.

begin;

-- 1. Corte canónico -----------------------------------------------------------------
create or replace function public.order_dispatch_cutoff_reached(p_order public.ordenes)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  return p_order.andreani_handed_over_at is not null
    or lower(coalesce(p_order.estado, '')) in ('enviado', 'en_camino', 'visita_fallida', 'en_sucursal',
      'retiro_pendiente', 'retiro_vencido', 'en_devolucion', 'devuelto_beyonix', 'entregado')
    or nullif(btrim(coalesce(p_order.tracking_number, '')), '') is not null
    or lower(coalesce(p_order.andreani_estado, '')) ~ '(camino|tránsito|transito|distribución|distribucion|reparto|visita|entregado)'
    or ((nullif(btrim(coalesce(p_order.andreani_envio_id, '')), '') is not null
         or nullif(btrim(coalesce(p_order.andreani_tracking, '')), '') is not null)
        and not exists (select 1 from public.order_packages p where p.order_id = p_order.id));
end $$;

comment on function public.order_dispatch_cutoff_reached(public.ordenes) is
  'Corte de cancelación: el pedido ya salió de BEYONIX (QR final del Bulto, transporte real, seguimiento manual o envío histórico sin Despachos). El envío Andreani creado no alcanza.';

-- 2. Cancelación del cliente ------------------------------------------------------
-- Igual que 20260917110000 salvo el corte (punto 1) y el estado físico en la
-- auditoría: pickeo, armado o Bulto al momento de cancelar.
create or replace function public.request_customer_order_cancellation_with_claim(
  p_order_id bigint,
  p_user_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_claim public.order_claims%rowtype;
  v_now timestamptz := now();
  v_payment_confirmed boolean;
  v_proof_pending boolean;
  v_invoiced boolean;
  v_next_financial_status text;
  v_previous_financial_status text;
  v_affected_items jsonb;
  v_package_status text;
  v_picked boolean := false;
  v_batch_id bigint;
  v_batch_number bigint;
  v_batch_code text;
  v_physical_state text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cancelar esta compra.';
  end if;

  if p_order_id is null or p_user_id is null
     or length(trim(coalesce(p_reason, ''))) not between 5 and 600 then
    raise exception 'INVALID_CANCELLATION_REQUEST';
  end if;

  -- Mismo lock que hand_over_dispatch_batch: si el QR final se confirmó
  -- primero, acá se ve andreani_handed_over_at y se rechaza.
  select * into v_order
  from public.ordenes
  where id = p_order_id
    and usuario_id = p_user_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if lower(coalesce(v_order.estado, '')) = 'cancelado'
     or lower(coalesce(v_order.financial_status, '')) in (
       'cancelled', 'refund_pending', 'refunded'
     ) then
    raise exception 'ORDER_ALREADY_CANCELLED';
  end if;

  if v_order.andreani_creation_status = 'claimed' then
    raise exception 'ANDREANI_CREATION_IN_PROGRESS';
  end if;
  if v_order.andreani_creation_status = 'reconciliation_required' then
    raise exception 'ANDREANI_RECONCILIATION_REQUIRED';
  end if;

  if public.order_dispatch_cutoff_reached(v_order) then
    raise exception 'ORDER_ALREADY_DISPATCHED';
  end if;

  v_payment_confirmed :=
    v_order.paid_at is not null
    or coalesce(v_order.payment_confirmed_amount, 0) > 0
    or lower(coalesce(v_order.payment_status, '')) in (
      'confirmado', 'approved', 'confirmed'
    )
    or lower(coalesce(v_order.financial_status, '')) = 'payment_confirmed';
  v_proof_pending :=
    nullif(btrim(coalesce(v_order.payment_proof_url, '')), '') is not null
    and lower(coalesce(v_order.payment_status, '')) in (
      'en_revision', 'pendiente_comprobante', 'pending'
    );
  v_invoiced :=
    coalesce(v_order.invoice_status, '') in ('authorized', 'processing')
    or v_order.invoice_cae is not null
    or (v_order.invoice_number is not null and v_order.invoice_point is not null);
  v_next_financial_status := case
    when v_payment_confirmed then 'refund_pending'
    when v_proof_pending then 'cancellation_requested'
    else 'cancelled'
  end;
  v_previous_financial_status := coalesce(
    v_order.financial_status,
    v_order.payment_status,
    'pending_payment'
  );

  -- Estado físico al cancelar (auditoría; la retención la decide el trigger
  -- capture_prepared_order_stock_hold con la misma regla del primer pickeo).
  select p.status,
         exists (select 1 from public.order_preparation_scans s where s.package_id = p.id)
    into v_package_status, v_picked
    from public.order_packages p where p.order_id = v_order.id;
  select i.batch_id, b.display_number, b.code
    into v_batch_id, v_batch_number, v_batch_code
    from public.dispatch_batch_items i
    join public.dispatch_batches b on b.id = i.batch_id
    where i.order_id = v_order.id and i.removed_at is null;
  v_physical_state := case
    when v_batch_id is not null then 'in_bundle'
    when v_package_status = 'prepared' then 'prepared'
    when coalesce(v_picked, false) then 'picking'
    else 'not_picked'
  end;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'order_item_id', oi.id,
        'quantity', oi.cantidad
      ) order by oi.id
    ),
    '[]'::jsonb
  ) into v_affected_items
  from public.orden_items oi
  where oi.orden_id = v_order.id;

  insert into public.order_claims (
    order_id,
    user_id,
    claim_type,
    status,
    failure_type,
    started_at,
    description,
    resolution,
    offered_resolutions,
    admin_needs_action,
    last_customer_message_at,
    affected_items,
    closed_at
  ) values (
    v_order.id,
    p_user_id,
    'transporte_48hs',
    case
      when v_payment_confirmed then 'reintegro_pendiente'
      when v_proof_pending then 'en_revision'
      else 'cerrado'
    end,
    'cancelar_compra',
    v_now,
    trim(p_reason),
    case when v_payment_confirmed then 'reintegro_total' else 'otro' end,
    '{}'::text[],
    v_payment_confirmed or v_proof_pending,
    v_now,
    v_affected_items,
    case when not v_payment_confirmed and not v_proof_pending then v_now else null end
  )
  returning * into v_claim;

  update public.ordenes
  set
    estado = 'cancelado',
    cancelled_at = v_now,
    financial_status = v_next_financial_status,
    cancellation_requested_at = v_now,
    cancellation_requested_by = p_user_id,
    refund_pending_at = case when v_payment_confirmed then v_now else null end,
    credit_note_required = v_payment_confirmed and v_invoiced
  where id = v_order.id
  returning * into v_order;

  if coalesce(v_order.credit_balance_used, 0) > 0 then
    perform *
    from public.reverse_customer_credit_for_order(
      v_order.id,
      'Reintegro de saldo por cancelación de compra',
      p_user_id
    );
  end if;

  insert into public.order_audit_events (
    order_id,
    actor_type,
    actor_id,
    action,
    previous_status,
    new_status,
    metadata
  ) values (
    v_order.id,
    'customer',
    p_user_id,
    case
      when v_payment_confirmed then 'cancellation_requested_refund_pending'
      else 'cancellation_requested'
    end,
    v_previous_financial_status,
    v_next_financial_status,
    jsonb_build_object(
      'claimId', v_claim.id,
      'cancellationReason', trim(p_reason),
      'invoiceIssued', v_invoiced,
      'creditNoteRequired', v_payment_confirmed and v_invoiced,
      'source', 'customer_cancellation',
      'physicalState', v_physical_state,
      'bundleId', v_batch_id,
      'bundleNumber', v_batch_number,
      'bundleCode', v_batch_code
    )
  );

  insert into public.order_claim_messages (
    claim_id,
    author_user_id,
    author_role,
    message
  ) values (
    v_claim.id,
    p_user_id,
    'cliente',
    trim(p_reason)
  );

  return to_jsonb(v_order) || jsonb_build_object(
    'claim_id', v_claim.id,
    'physical_state', v_physical_state,
    'bundle_number', v_batch_number
  );
end;
$$;

revoke all on function public.request_customer_order_cancellation_with_claim(
  bigint, uuid, text
) from public, anon, authenticated;
grant execute on function public.request_customer_order_cancellation_with_claim(
  bigint, uuid, text
) to service_role;

comment on function public.request_customer_order_cancellation_with_claim(
  bigint, uuid, text
) is
  'Cancela una orden antes del QR final del Bulto (order_dispatch_cutoff_reached) y crea atómicamente el claim comercial del cliente. Bloquea si hay una creación Andreani en curso o con resultado incierto. Audita el estado físico al cancelar.';

-- 3. Mismo corte en la cancelación directa de Admin, la aprobación del reclamo
-- de cancelación y el refund de Mercado Pago. Se reemplaza sólo el bloque de
-- "despachado" (sin punto y coma interno) de la definición vigente; el resto de
-- cada función queda idéntico. Si el bloque no aparece exactamente una vez, la
-- migración falla (nunca se aplica a medias). Una función ausente (sólo en
-- bases de prueba parciales) se informa y se saltea.
do $migration$
declare
  v_target record;
  v_definition text;
  v_updated text;
  v_matches integer;
begin
  for v_target in
    select * from (values
      ('public.admin_cancel_order(bigint,uuid,text,text,text,text)',
       $re$if lower\(coalesce\(v_order\.estado, ''\)\) in \([^;]*raise exception 'ORDER_ALREADY_DISPATCHED';$re$,
       $new$if public.order_dispatch_cutoff_reached(v_order) then
    raise exception 'ORDER_ALREADY_DISPATCHED';$new$),
      ('public.approve_order_claim_cancellation(bigint,uuid,text,text)',
       $re$if lower\(coalesce\(v_order\.estado, ''\)\) in \([^;]*raise exception 'No se puede aprobar la cancelación porque el pedido ya fue despachado\.';$re$,
       $new$if public.order_dispatch_cutoff_reached(v_order) then
    raise exception 'No se puede aprobar la cancelación porque el pedido ya fue despachado.';$new$),
      ('public.begin_mercadopago_order_refund(bigint,uuid)',
       $re$if lower\(coalesce\(v_order\.estado, ''\)\) in \([^;]*raise exception 'ORDER_ALREADY_DISPATCHED';$re$,
       $new$if public.order_dispatch_cutoff_reached(v_order) then
    raise exception 'ORDER_ALREADY_DISPATCHED';$new$)
    ) as t(signature, pattern, replacement)
  loop
    if to_regprocedure(v_target.signature) is null then
      raise notice 'Función % ausente: sin cambios', v_target.signature;
      continue;
    end if;
    v_definition := pg_get_functiondef(to_regprocedure(v_target.signature));
    select count(*) into v_matches from regexp_matches(v_definition, v_target.pattern, 'g');
    if v_matches <> 1 then
      raise exception 'Bloque de despacho no encontrado exactamente una vez en % (%)', v_target.signature, v_matches;
    end if;
    v_updated := regexp_replace(v_definition, v_target.pattern, v_target.replacement);
    execute v_updated;
  end loop;
end
$migration$;

-- 4. Resolución financiera ----------------------------------------------------------
-- Igual que 20261016140000 salvo: (a) el refund MP usa el corte canónico (un
-- pedido cancelado dentro de un Bulto y retirado físicamente ya no figura como
-- "despachado" por tener envío Andreani); (b) saldo BEYONIX después del pickeo
-- sólo con la retención resuelta y fuera de todo Bulto.
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
  -- Con corte de preparación, saldo BEYONIX sólo si la mercadería ya volvió
  -- (cancelación con pickeo resuelta por escaneo) y el pedido no sigue en un Bulto.
  if p_choice='beyonix_credit' and public.order_was_prepared_for_dispatch(p_order_id)
     and (not public.order_cancelled_after_picking(p_order_id)
          or public.order_has_active_stock_hold(p_order_id)
          or exists (select 1 from public.dispatch_batch_items i
                     where i.order_id=p_order_id and i.removed_at is null)) then
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
  if p_choice='mercadopago_refund' and (nullif(btrim(v_order.payment_id),'') is null
      or (v_note_amount>0 and v_note_amount<>v_paid_amount)) then
    raise exception 'FINANCIAL_MP_INELIGIBLE';
  end if;
  if p_choice='mercadopago_refund' and public.order_dispatch_cutoff_reached(v_order) then
    raise exception 'FINANCIAL_RETURN_REQUIRED';
  end if;
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

-- 5. Bulto: validación completa antes del QR final ---------------------------------
-- Todos los pedidos que hoy impiden entregar el Bulto, con sus motivos. Misma
-- regla que la entrega (bloqueos automáticos y manuales, armado vigente y
-- retención física). Sólo lectura.
create or replace function public.dispatch_batch_handover_issues(p_batch_id bigint)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_item record; v_reasons text[]; v_issues jsonb := '[]'::jsonb;
begin
  for v_item in select i.order_id, i.package_id from public.dispatch_batch_items i
    where i.batch_id = p_batch_id and i.removed_at is null order by i.order_id loop
    v_reasons := public.dispatch_order_block_reasons(v_item.order_id)
      || coalesce((select array_agg(b.reason order by b.reason) from public.dispatch_blocks b
                   where b.order_id = v_item.order_id and b.resolved_at is null), '{}'::text[]);
    if not exists (select 1 from public.order_packages p
                   where p.id = v_item.package_id and p.order_id = v_item.order_id and p.status = 'prepared') then
      v_reasons := array_append(v_reasons, 'not_prepared');
    end if;
    if public.order_has_active_stock_hold(v_item.order_id) then
      v_reasons := array_append(v_reasons, 'physical_hold');
    end if;
    if cardinality(v_reasons) > 0 then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'orderId', v_item.order_id,
        'reasons', (select coalesce(jsonb_agg(distinct reason), '[]'::jsonb) from unnest(v_reasons) reason)));
    end if;
  end loop;
  return v_issues;
end $$;

-- Igual que 20261016150000, salvo que primero bloquea TODOS los pedidos y
-- después valida el Bulto completo: si hay uno o cincuenta pedidos con
-- problemas, el error lleva la lista entera (detail = JSON) y nada cambia.
create or replace function public.hand_over_dispatch_batch(p_batch_id bigint, p_actor_id uuid)
returns public.dispatch_batches language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_batch public.dispatch_batches%rowtype; v_item record; v_at timestamptz := now(); v_issues jsonb;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  if v_batch.status = 'handed_over' then return v_batch; end if;
  if v_batch.status <> 'closed' then raise exception 'DISPATCH_BATCH_NOT_CLOSED'; end if;
  if not exists (select 1 from public.dispatch_batch_items where batch_id = p_batch_id and removed_at is null)
     then raise exception 'DISPATCH_BATCH_EMPTY'; end if;
  -- Cancelación, reintegro y retiro bloquean las mismas filas: lo que se valida
  -- abajo es lo que queda entregado (una cancelación posterior ve el corte).
  for v_item in select i.order_id from public.dispatch_batch_items i
    where i.batch_id = p_batch_id and i.removed_at is null order by i.order_id loop
    perform 1 from public.ordenes where id = v_item.order_id for update;
  end loop;
  v_issues := public.dispatch_batch_handover_issues(p_batch_id);
  if jsonb_array_length(v_issues) > 0 then
    raise exception 'DISPATCH_ORDER_BLOCKED' using detail = v_issues::text, hint = 'DISPATCH_BATCH_ISSUES';
  end if;
  for v_item in select i.order_id, i.verified_at, i.verification_round
    from public.dispatch_batch_items i
    where i.batch_id = p_batch_id and i.removed_at is null order by i.order_id loop
    if v_batch.verification_required
       and (v_item.verified_at is null or v_item.verification_round is distinct from v_batch.verification_round) then
      raise exception 'DISPATCH_ORDERS_UNVERIFIED' using detail = v_item.order_id::text; end if;
  end loop;
  update public.dispatch_batches set status = 'handed_over', handed_over_by = p_actor_id,
    handed_over_at = v_at where id = p_batch_id returning * into v_batch;
  insert into public.dispatch_batch_events(batch_id, actor_id, action)
    values (p_batch_id, p_actor_id, 'handed_over');
  for v_item in select order_id from public.dispatch_batch_items
    where batch_id = p_batch_id and removed_at is null order by order_id loop
    update public.ordenes set andreani_handed_over_at = v_at,
      andreani_handed_over_by = p_actor_id, andreani_handed_over_batch_id = p_batch_id
      where id = v_item.order_id and andreani_handed_over_at is null;
    if not found then raise exception 'DISPATCH_ORDER_ALREADY_HANDED_OVER'; end if;
    insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
      values (v_item.order_id, 'admin', p_actor_id, 'order_handed_over_to_andreani',
        jsonb_build_object('batchId', p_batch_id, 'batchCode', v_batch.code));
  end loop;
  return v_batch;
end $$;

-- Igual que 20261018120000, con la misma validación completa antes de marcar
-- los pedidos como verificados presencialmente.
create or replace function public.confirm_dispatch_batch_mobile_control(p_batch_id bigint, p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_batch public.dispatch_batches%rowtype;
  v_item record;
  v_included bigint[] := array[]::bigint[];
  v_removed bigint[] := array[]::bigint[];
  v_parcels integer := 0;
  v_issues jsonb;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  if v_batch.status = 'handed_over' then
    return jsonb_build_object('batchId', p_batch_id, 'duplicate', true,
      'handedOverAt', v_batch.handed_over_at);
  end if;
  if v_batch.status not in ('open', 'closed') then raise exception 'DISPATCH_BATCH_NOT_CLOSED'; end if;
  for v_item in
    select i.order_id, p.parcel_count
    from public.dispatch_batch_items i
    join public.order_packages p on p.id = i.package_id
    where i.batch_id = p_batch_id and i.removed_at is null
    order by i.order_id
  loop
    perform 1 from public.ordenes where id = v_item.order_id for update;
    v_included := array_append(v_included, v_item.order_id);
    v_parcels := v_parcels + coalesce(v_item.parcel_count, 0);
  end loop;
  if cardinality(v_included) = 0 then raise exception 'DISPATCH_BATCH_EMPTY'; end if;
  v_issues := public.dispatch_batch_handover_issues(p_batch_id);
  if jsonb_array_length(v_issues) > 0 then
    raise exception 'DISPATCH_ORDER_BLOCKED' using detail = v_issues::text, hint = 'DISPATCH_BATCH_ISSUES';
  end if;
  select coalesce(array_agg(order_id order by order_id), array[]::bigint[]) into v_removed
    from public.dispatch_batch_items where batch_id = p_batch_id and removed_at is not null;
  -- La confirmación presencial equivale a verificar físicamente los pedidos vigentes.
  update public.dispatch_batch_items set verified_at = now(), verified_by = p_actor_id,
    verification_method = 'manual_selection', verification_code = 'CONTROL-PRESENCIAL',
    verification_round = v_batch.verification_round
    where batch_id = p_batch_id and removed_at is null
      and (verified_at is null or verification_round is distinct from v_batch.verification_round);
  if v_batch.status = 'open' then
    v_batch := public.close_dispatch_batch(p_batch_id, p_actor_id);
  end if;
  v_batch := public.hand_over_dispatch_batch(p_batch_id, p_actor_id);
  insert into public.dispatch_batch_events(batch_id, actor_id, action, metadata)
    values (p_batch_id, p_actor_id, 'mobile_control_confirmed',
      jsonb_build_object('parcelCount', v_parcels, 'includedOrderIds', v_included,
        'removedOrderIds', v_removed, 'confirmedAt', v_batch.handed_over_at));
  return jsonb_build_object('batchId', p_batch_id, 'duplicate', false,
    'handedOverAt', v_batch.handed_over_at, 'parcelCount', v_parcels,
    'includedOrderIds', v_included, 'removedOrderIds', v_removed);
end $$;

revoke all on function public.order_dispatch_cutoff_reached(public.ordenes),
  public.dispatch_batch_handover_issues(bigint),
  public.hand_over_dispatch_batch(bigint, uuid),
  public.confirm_dispatch_batch_mobile_control(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.order_dispatch_cutoff_reached(public.ordenes),
  public.dispatch_batch_handover_issues(bigint),
  public.hand_over_dispatch_batch(bigint, uuid),
  public.confirm_dispatch_batch_mobile_control(bigint, uuid)
  to service_role;

-- 6. Avisos al cliente --------------------------------------------------------------
-- Cancelación recibida: una sola vez, al entrar en cancelación. Antes el aviso
-- se reescribía (y volvía a "no leído") en cada cambio posterior de
-- financial_status, incluido el cierre del reintegro.
create or replace function public.notify_customer_order_cancelled()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  order_code text;
  notification_body text;
  was_cancelling boolean;
begin
  if new.usuario_id is null then
    return new;
  end if;

  if new.estado <> 'cancelado'
     and coalesce(new.financial_status, '') not in ('cancelled', 'cancellation_requested', 'refund_pending') then
    return new;
  end if;

  was_cancelling := old.estado = 'cancelado'
    or coalesce(old.financial_status, '') in ('cancelled', 'cancellation_requested', 'refund_pending', 'refunded');
  if was_cancelling then
    return new;
  end if;

  order_code := 'BX-' || (1000 + new.id);
  notification_body := case
    when public.order_has_active_stock_hold(new.id) then
      'Recibimos la cancelación de tu pedido ' || order_code || '. Estamos procesando tu cancelación y te avisamos cuando el reintegro esté listo.'
    when coalesce(new.financial_status, '') in ('cancellation_requested', 'refund_pending') then
      'Recibimos la cancelación de tu pedido ' || order_code || '. Te avisamos cuando el reintegro esté listo.'
    else
      'Recibimos la cancelación de tu pedido ' || order_code || '.'
  end;

  insert into public.customer_notifications (
    user_id, type, title, body, action_url, order_id, source_key, is_read, created_at
  ) values (
    new.usuario_id, 'order_cancelled', 'Cancelación recibida', notification_body,
    '/cuenta/compras/' || new.id, new.id, 'order:' || new.id || ':cancelled', false, now()
  )
  on conflict (source_key) do update
  set
    type = excluded.type,
    title = excluded.title,
    body = excluded.body,
    action_url = excluded.action_url,
    is_read = false,
    created_at = now();

  return new;
end;
$$;

-- Reintegro en proceso: el Admin eligió cómo devolver el dinero.
create or replace function public.notify_customer_cancellation_refund_progress()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_order public.ordenes%rowtype;
begin
  select * into v_order from public.ordenes where id = new.order_id;
  if not found or v_order.usuario_id is null or v_order.estado <> 'cancelado' then return new; end if;
  insert into public.customer_notifications(user_id, type, title, body, action_url, order_id, source_key)
    values (v_order.usuario_id, 'order_refund_processing', 'Reintegro en proceso',
      case when new.choice = 'beyonix_credit'
        then 'Estamos acreditando el saldo de tu pedido BX-' || (1000 + v_order.id) || ' en tu cuenta.'
        else 'Tu reintegro del pedido BX-' || (1000 + v_order.id) || ' está siendo procesado.' end,
      '/cuenta/compras/' || v_order.id, v_order.id, 'order:' || v_order.id || ':refund-processing')
    on conflict (source_key) do nothing;
  return new;
end $$;

drop trigger if exists notify_customer_cancellation_refund_progress on public.order_financial_resolutions;
create trigger notify_customer_cancellation_refund_progress
  after insert on public.order_financial_resolutions
  for each row execute function public.notify_customer_cancellation_refund_progress();

-- Reintegro realizado: misma clave que los registros manuales existentes
-- (order:<id>:refunded), así ningún camino lo avisa dos veces. El saldo
-- BEYONIX tiene su propio aviso ("Saldo acreditado").
create or replace function public.notify_customer_cancellation_refunded()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.usuario_id is null or new.estado <> 'cancelado'
     or new.financial_status is distinct from 'refunded'
     or old.financial_status is not distinct from 'refunded'
     or coalesce(new.refund_method, '') = 'Saldo BEYONIX'
     or exists (select 1 from public.order_credit_notes n
                where n.order_id = new.id and n.status = 'authorized' and n.destination = 'customer_balance') then
    return new;
  end if;
  insert into public.customer_notifications(user_id, type, title, body, action_url, order_id, source_key)
    values (new.usuario_id, 'order_refunded', 'Reintegro realizado',
      'Tu reintegro del pedido BX-' || (1000 + new.id) || ' fue realizado.',
      '/cuenta/compras/' || new.id, new.id, 'order:' || new.id || ':refunded')
    on conflict (source_key) do nothing;
  return new;
end $$;

drop trigger if exists zz_notify_customer_cancellation_refunded on public.ordenes;
create trigger zz_notify_customer_cancellation_refunded
  after update of financial_status on public.ordenes
  for each row execute function public.notify_customer_cancellation_refunded();

revoke all on function public.notify_customer_order_cancelled(),
  public.notify_customer_cancellation_refund_progress(),
  public.notify_customer_cancellation_refunded()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
