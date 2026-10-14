-- Obligación de Factura C: nace con el pago válido confirmado y una
-- cancelación/reintegro posterior NO la borra.
--
-- CARRERA CORREGIDA (auditoría BX-1002, 2026-10-13):
--   pago confirmado → zz_queue_arca_invoice encola (invoice_queued_at)
--   → el timer ARCA corre cada 5 min → Admin cancela antes
--   → queue_arca_invoice veía order_is_invoiceable()=false (cancelado) y
--     sacaba el pedido de la cola (invoice_status := null)
--   → una venta efectivamente cobrada quedaba sin comprobante fiscal.
-- claim_arca_invoice y fail_arca_invoice_attempt aplicaban la misma regla.
--
-- QUÉ CAMBIA
-- 1. order_requires_invoice(): facturable hoy (order_is_invoiceable, sin
--    cambios) O ya nació la obligación (invoice_queued_at: sólo lo fija el
--    trigger al volverse facturable = pago válido confirmado) y el pedido se
--    canceló/reintegró. Un cambio de pedido en curso sigue pausando la cola
--    como antes. Una cancelación SIN pago nunca tuvo invoice_queued_at: sigue
--    sin factura ni NC.
-- 2. queue_arca_invoice / claim_arca_invoice / fail_arca_invoice_attempt usan
--    order_requires_invoice: el pedido cancelado sigue en la cola y el worker
--    (o Admin) emite su Factura C. complete_arca_invoice (sin cambios) ya deja
--    credit_note_required=true cuando la venta está cancelada/reintegrada.
-- 3. NC de una cancelación directa de Admin (sin reclamo del cliente):
--    begin_partial_credit_note acepta 'cancelacion_antes_despacho' sin claim
--    SOLO si el pedido tiene la auditoría de admin_cancel_order
--    (order_cancelled_refund_pending / source admin_direct_cancellation).
--    Todos los topes existentes (NC ≤ factura, ≤ reintegrable, por ítem, una
--    'processing' a la vez) quedan intactos.
-- Leases, numeración serializada, reconciliación de CAE y unicidad de
-- comprobantes no cambian: no hay segunda factura ni segundo CAE.
--
-- Pedidos ya desencolados antes de esta migración (p. ej. BX-1002) NO se
-- reencolan acá: emitirles la factura es una decisión fiscal explícita.

begin;

create or replace function public.order_requires_invoice(p_order public.ordenes)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    public.order_is_invoiceable(p_order)
    or (
      p_order.invoice_queued_at is not null
      and coalesce(p_order.total, 0) > 0
      and coalesce(p_order.order_change_status, '') not in ('change_requested', 'extra_payment_pending')
      and (
        coalesce(p_order.estado, '') = 'cancelado'
        or p_order.cancelled_at is not null
        or p_order.cancellation_requested_at is not null
        or coalesce(p_order.financial_status, '') in ('cancellation_requested', 'refund_pending', 'refunded', 'cancelled')
        or coalesce(p_order.payment_status, '') in ('refunded', 'charged_back')
      )
    )
$$;

revoke all on function public.order_requires_invoice(public.ordenes) from public, anon, authenticated;
grant execute on function public.order_requires_invoice(public.ordenes) to service_role;

create or replace function public.order_has_admin_direct_cancellation(p_order_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.order_audit_events e
    where e.order_id = p_order_id
      and e.actor_type = 'admin'
      and e.action = 'order_cancelled_refund_pending'
      and e.metadata->>'source' = 'admin_direct_cancellation'
  )
$$;

revoke all on function public.order_has_admin_direct_cancellation(bigint) from public, anon, authenticated;
grant execute on function public.order_has_admin_direct_cancellation(bigint) to service_role;

create or replace function public.queue_arca_invoice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Ya facturado o con un pedido de CAE en curso/pendiente de reconciliar:
  -- nunca se toca desde acá.
  if new.invoice_cae is not null or new.invoice_status in ('authorized', 'processing')
     or new.invoice_requested_number is not null then
    return new;
  end if;

  if public.order_is_invoiceable(new) then
    -- Sólo la TRANSICIÓN a facturable encola: una venta vieja que ya era
    -- facturable antes de esta migración no se encola por cualquier UPDATE.
    if new.invoice_status is null
       and (tg_op = 'INSERT' or not public.order_is_invoiceable(old)) then
      new.invoice_status := 'pending';
      new.invoice_error := null;
      new.invoice_queued_at := coalesce(new.invoice_queued_at, now());
      new.invoice_next_attempt_at := coalesce(new.invoice_next_attempt_at, now());
    end if;
  elsif new.invoice_status in ('pending', 'error')
        and not public.order_requires_invoice(new) then
    -- Dejó de ser facturable SIN que haya nacido la obligación (p. ej. un
    -- cambio de pedido en curso): sale de la cola sin haber emitido nada.
    -- Una venta cobrada y luego cancelada/reintegrada se queda en la cola.
    new.invoice_status := null;
    new.invoice_next_attempt_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.queue_arca_invoice() from public, anon, authenticated;

-- claim_arca_invoice: idéntica a 20261003120000 salvo order_requires_invoice.
create or replace function public.claim_arca_invoice(
  p_order_id bigint default null,
  p_lease interval default interval '10 minutes',
  p_manual boolean default false
)
returns setof public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_now timestamptz := clock_timestamp();
  v_cutoff timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if p_manual is not true then
    select cutoff_at into v_cutoff
    from public.arca_auto_invoicing_control
    where id = true and enabled = true
    for share;
    if v_cutoff is null then return; end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('beyonix-arca-invoice-processing'));

  if exists (
    select 1 from public.ordenes
    where invoice_status = 'processing'
      and invoice_processing_started_at > v_now - p_lease
      and (p_order_id is null or id <> p_order_id)
  ) then
    if p_manual then raise exception 'INVOICE_PROCESSING_IN_PROGRESS'; end if;
    return;
  end if;

  if p_order_id is not null then
    select * into v_order from public.ordenes where id = p_order_id for update;
    if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  else
    select * into v_order from public.ordenes o
    where ((o.invoice_status in ('pending', 'error') and o.invoice_next_attempt_at <= v_now)
       or (o.invoice_status = 'processing' and o.invoice_processing_started_at <= v_now - p_lease))
      and o.invoice_queued_at > v_cutoff
      and o.invoice_cae is null
      and o.invoice_number is null
      and (o.invoice_arca_environment is null or o.invoice_arca_environment = 'production')
    order by o.invoice_next_attempt_at nulls first, o.id
    limit 1
    for update of o skip locked;
    if not found then return; end if;
  end if;

  if p_manual is not true and (
    v_order.invoice_queued_at is null or v_order.invoice_queued_at <= v_cutoff
    or v_order.invoice_cae is not null or v_order.invoice_number is not null
    or v_order.invoice_arca_environment = 'homologation'
    or v_order.invoice_status not in ('pending', 'error', 'processing')
  ) then return; end if;

  if v_order.invoice_status = 'authorized' and v_order.invoice_cae is not null then
    if p_manual then raise exception 'INVOICE_ALREADY_AUTHORIZED'; end if;
    return;
  end if;
  if v_order.invoice_status = 'processing'
     and v_order.invoice_processing_started_at > v_now - p_lease then
    if p_manual then raise exception 'INVOICE_ALREADY_PROCESSING'; end if;
    return;
  end if;

  -- Un número ya solicitado exige conciliación aun si la venta se canceló.
  if v_order.invoice_requested_number is null and not public.order_requires_invoice(v_order) then
    if p_manual then raise exception 'ORDER_NOT_INVOICEABLE'; end if;
    update public.ordenes
    set invoice_status = null, invoice_next_attempt_at = null
    where id = v_order.id and invoice_status in ('pending', 'error');
    return;
  end if;

  update public.ordenes
  set invoice_status = 'processing',
      invoice_processing_started_at = v_now,
      invoice_last_attempt_at = v_now,
      invoice_attempts = coalesce(invoice_attempts, 0) + 1,
      invoice_queued_at = coalesce(invoice_queued_at, v_now)
  where id = v_order.id
  returning * into v_order;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (v_order.id, 'system', 'arca_invoice_attempt_started', null, 'processing',
    jsonb_build_object('attempt', v_order.invoice_attempts, 'manual', p_manual,
      'reconciling', v_order.invoice_requested_number is not null,
      'requestedNumber', v_order.invoice_requested_number));

  return next v_order;
end;
$$;
revoke all on function public.claim_arca_invoice(bigint, interval, boolean) from public, anon, authenticated;
grant execute on function public.claim_arca_invoice(bigint, interval, boolean) to service_role;

-- fail_arca_invoice_attempt: idéntica a 20260927120000 salvo order_requires_invoice.
create or replace function public.fail_arca_invoice_attempt(
  p_order_id bigint,
  p_error text,
  p_retry_after interval,
  p_release_request boolean default false
)
returns public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.invoice_status is distinct from 'processing' then
    return v_order;
  end if;

  update public.ordenes
  set invoice_status = 'error',
      invoice_error = left(coalesce(nullif(trim(p_error), ''), 'Error de facturación.'), 1000),
      invoice_next_attempt_at = case when p_retry_after is null then null else clock_timestamp() + p_retry_after end,
      invoice_processing_started_at = null,
      invoice_requested_point = case when p_release_request then null else invoice_requested_point end,
      invoice_requested_type = case when p_release_request then null else invoice_requested_type end,
      invoice_requested_number = case when p_release_request then null else invoice_requested_number end,
      invoice_requested_total = case when p_release_request then null else invoice_requested_total end,
      invoice_requested_date = case when p_release_request then null else invoice_requested_date end,
      invoice_requested_at = case when p_release_request then null else invoice_requested_at end,
      invoice_arca_environment = case
        when p_release_request and invoice_cae is null and invoice_number is null then null
        else invoice_arca_environment end
  where id = p_order_id
  returning * into v_order;

  if v_order.invoice_requested_number is null and not public.order_requires_invoice(v_order) then
    update public.ordenes set invoice_status = null, invoice_next_attempt_at = null
    where id = p_order_id returning * into v_order;
  end if;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (p_order_id, 'system', 'arca_invoice_attempt_failed', 'processing', coalesce(v_order.invoice_status, 'not_invoiceable'),
    jsonb_build_object('error', left(p_error, 1000), 'attempt', v_order.invoice_attempts,
      'requestReleased', p_release_request,
      'pendingReconciliation', v_order.invoice_requested_number,
      'environment', v_order.invoice_arca_environment,
      'nextAttemptAt', v_order.invoice_next_attempt_at));
  return v_order;
end;
$$;

revoke all on function public.fail_arca_invoice_attempt(bigint, text, interval, boolean) from public, anon, authenticated;
grant execute on function public.fail_arca_invoice_attempt(bigint, text, interval, boolean) to service_role;

-- begin_partial_credit_note: idéntica a 20260917120000 salvo la rama sin claim
-- de 'cancelacion_antes_despacho' (marcada NUEVO).
create or replace function public.begin_partial_credit_note(
  p_order_id bigint,
  p_claim_id bigint,
  p_destination text,
  p_reason text,
  p_items_amount numeric,
  p_manual_amount numeric,
  p_total_amount numeric,
  p_invoice_point integer,
  p_invoice_number bigint,
  p_created_by uuid,
  p_items jsonb,
  p_operation_type text
)
returns public.order_credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note public.order_credit_notes;
  v_invoice_total numeric(12, 2);
  v_order_user_id uuid;
  v_order_financial_status text;
  v_order_payment_confirmed_amount numeric(12, 2);
  v_order_external_amount_due numeric(12, 2);
  v_order_credit_balance_used numeric(12, 2);
  v_committed_total numeric(12, 2);
  v_external_paid numeric(12, 2);
  v_external_committed numeric(12, 2);
  v_refundable_remaining numeric(12, 2);
  v_item jsonb;
  v_order_item public.orden_items;
  v_committed_quantity integer;
  v_actor_role text;
  v_claim public.order_claims%rowtype;
  v_affected_item jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'No tenés permisos para emitir esta nota de crédito.';
  end if;

  select rol into v_actor_role
  from public.profiles
  where id = p_created_by;

  if coalesce(v_actor_role,'') not in ('admin', 'super_admin') then
    raise exception 'CREDIT_NOTE_ACTOR_FORBIDDEN';
  end if;

  if p_operation_type not in (
    'devolucion_parcial',
    'devolucion_total',
    'cambio_producto',
    'cancelacion_antes_despacho',
    'reembolso_excepcional',
    'ajuste_manual'
  ) then
    raise exception 'INVALID_CREDIT_NOTE_OPERATION_TYPE';
  end if;

  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_CREDIT_NOTE_ITEM';
  end if;

  perform pg_advisory_xact_lock(91091, p_order_id::integer);

  -- Expiry cannot prove ARCA did not authorize the previous request.
  if exists(select 1 from public.order_credit_notes where order_id=p_order_id and status='processing') then
    raise exception 'CREDIT_NOTE_PROCESSING_IN_PROGRESS';
  end if;

  if p_destination not in ('external_refund', 'customer_balance', 'none') then
    raise exception 'INVALID_CREDIT_NOTE_DESTINATION';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'CREDIT_NOTE_REASON_REQUIRED';
  end if;

  if round(coalesce(p_total_amount, 0), 2) <= 0
     or round(coalesce(p_total_amount, 0), 2)
        <> round(coalesce(p_items_amount, 0) + coalesce(p_manual_amount, 0), 2) then
    raise exception 'INVALID_CREDIT_NOTE_AMOUNT';
  end if;

  if p_operation_type in ('ajuste_manual', 'reembolso_excepcional') then
    if v_actor_role <> 'super_admin' then
      raise exception 'CREDIT_NOTE_ADMIN_OPERATION_FORBIDDEN';
    end if;
    if p_claim_id is not null then
      raise exception 'INVALID_CREDIT_NOTE_CLAIM';
    end if;
    if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) <> 0
       or round(coalesce(p_items_amount, 0), 2) <> 0 then
      raise exception 'CREDIT_NOTE_ADMIN_ITEMS_FORBIDDEN';
    end if;
  elsif p_claim_id is null then
    -- NUEVO (20261014100000): una cancelación hecha directamente por Admin
    -- (admin_cancel_order, auditada) no tiene reclamo del cliente. Si la
    -- venta se facturó después de esa cancelación (obligación fiscal nacida
    -- con el pago), la NC de cancelación se autoriza con esa auditoría.
    if not (p_operation_type = 'cancelacion_antes_despacho'
            and public.order_has_admin_direct_cancellation(p_order_id)) then
      raise exception 'CLAIM_REQUIRED';
    end if;
  end if;

  select
    round(total::numeric, 2),
    usuario_id,
    financial_status,
    payment_confirmed_amount,
    external_amount_due,
    credit_balance_used
  into
    v_invoice_total,
    v_order_user_id,
    v_order_financial_status,
    v_order_payment_confirmed_amount,
    v_order_external_amount_due,
    v_order_credit_balance_used
  from public.ordenes
  where id = p_order_id
    and invoice_status = 'authorized'
    and invoice_cae is not null
    and invoice_point = p_invoice_point
    and invoice_number = p_invoice_number
  for update;

  if v_invoice_total is null then
    raise exception 'AUTHORIZED_INVOICE_REQUIRED';
  end if;

  -- NUEVO (P0-3): un pedido ya liquidado por CUALQUIER canal (NC previa a
  -- customer_balance, refund de Mercado Pago confirmado, comprobante de
  -- transferencia commiteado) nunca puede recibir una segunda NC que mueva
  -- dinero. Simétrico al guard que ya tiene begin_mercadopago_order_refund
  -- (exige financial_status='refund_pending').
  if p_destination in ('external_refund', 'customer_balance')
     and v_order_financial_status = 'refunded' then
    raise exception 'ORDER_ALREADY_REFUNDED';
  end if;

  if p_claim_id is not null then
    select * into v_claim
    from public.order_claims
    where id = p_claim_id
      and order_id = p_order_id
    for update;

    if not found or v_claim.user_id is distinct from v_order_user_id then
      raise exception 'INVALID_CREDIT_NOTE_CLAIM';
    end if;
    if v_claim.status not in (
         'aprobado',
         'reintegro_pendiente',
         'cambio_pendiente',
         'cupon_pendiente',
         'reemplazo_enviado'
       )
       or v_claim.resolution = 'rechazado'
       or v_claim.failure_type = 'consulta_pedido' then
      raise exception 'INVALID_CREDIT_NOTE_CLAIM_STATUS';
    end if;
    if p_operation_type = 'cancelacion_antes_despacho'
       and v_claim.failure_type is distinct from 'cancelar_compra' then
      raise exception 'INVALID_CREDIT_NOTE_CLAIM_STATUS';
    end if;
    if p_operation_type <> 'cancelacion_antes_despacho'
       and v_claim.failure_type = 'cancelar_compra' then
      raise exception 'INVALID_CREDIT_NOTE_CLAIM_STATUS';
    end if;
  end if;

  select coalesce(sum(total_amount), 0)
  into v_committed_total
  from public.order_credit_notes
  where order_id = p_order_id
    and status in ('processing', 'authorized');

  if round(v_committed_total + p_total_amount, 2) > v_invoice_total then
    raise exception 'CREDIT_NOTE_EXCEEDS_INVOICE';
  end if;

  -- NUEVO (P0-1): tope FINANCIERO independiente del fiscal de arriba.
  -- Sólo aplica cuando la NC mueve dinero de verdad. No reemplaza el check
  -- fiscal (que sigue intacto, contra el total facturado): una NC puede
  -- seguir representando fiscalmente el valor facturado completo, pero el
  -- importe que efectivamente se acredita/reintegra por este destino nunca
  -- puede superar lo que todavía queda pendiente de devolver en dinero
  -- externo.
  if p_destination in ('external_refund', 'customer_balance') then
    v_external_paid := coalesce(
      nullif(v_order_payment_confirmed_amount, 0),
      v_order_external_amount_due,
      greatest(v_invoice_total - coalesce(v_order_credit_balance_used, 0), 0),
      0
    );

    select coalesce(sum(total_amount), 0)
    into v_external_committed
    from public.order_credit_notes
    where order_id = p_order_id
      and destination in ('external_refund', 'customer_balance')
      and status in ('processing', 'authorized');

    v_refundable_remaining := greatest(round(v_external_paid, 2) - v_external_committed, 0);

    if round(p_total_amount, 2) > v_refundable_remaining then
      raise exception 'CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT';
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    select *
    into v_order_item
    from public.orden_items
    where id = (v_item->>'order_item_id')::bigint
      and orden_id = p_order_id;

    if not found then
      raise exception 'INVALID_CREDIT_NOTE_ITEM';
    end if;

    if p_claim_id is not null then
      v_affected_item := null;
      select affected.value into v_affected_item
      from jsonb_array_elements(coalesce(v_claim.affected_items, '[]'::jsonb)) affected
      where (affected.value->>'order_item_id')::bigint = v_order_item.id
      limit 1;

      if v_affected_item is null
         or (v_item->>'quantity')::integer > (v_affected_item->>'quantity')::integer then
        raise exception 'INVALID_CREDIT_NOTE_CLAIM_ITEM';
      end if;
    end if;

    select coalesce(sum(cni.quantity), 0)
    into v_committed_quantity
    from public.order_credit_note_items cni
    join public.order_credit_notes cn on cn.id = cni.credit_note_id
    where cni.order_item_id = v_order_item.id
      and cn.status in ('processing', 'authorized');

    if (v_item->>'quantity')::integer <= 0
       or v_committed_quantity + (v_item->>'quantity')::integer > v_order_item.cantidad then
      raise exception 'CREDIT_NOTE_ITEM_QUANTITY_EXCEEDED';
    end if;
  end loop;

  insert into public.order_credit_notes (
    order_id,
    claim_id,
    destination,
    reason,
    items_amount,
    manual_amount,
    total_amount,
    invoice_point,
    invoice_number,
    created_by,
    operation_type
  )
  values (
    p_order_id,
    p_claim_id,
    p_destination,
    trim(p_reason),
    round(p_items_amount, 2),
    round(p_manual_amount, 2),
    round(p_total_amount, 2),
    p_invoice_point,
    p_invoice_number,
    p_created_by,
    p_operation_type
  )
  returning * into v_note;

  insert into public.order_credit_note_items (
    credit_note_id,
    order_item_id,
    quantity,
    unit_amount,
    total_amount,
    product_name,
    variant_name
  )
  select
    v_note.id,
    (value->>'order_item_id')::bigint,
    (value->>'quantity')::integer,
    round((value->>'unit_amount')::numeric, 4),
    round((value->>'total_amount')::numeric, 2),
    left(value->>'product_name', 240),
    nullif(left(value->>'variant_name', 240), '')
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb));

  return v_note;
exception
  when unique_violation then
    raise exception 'CREDIT_NOTE_PROCESSING_IN_PROGRESS';
end;
$$;

revoke all on function public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb, text
) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;