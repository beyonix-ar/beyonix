-- Automatizacion estricta de NC y reintegro MP para cancelaciones completas
-- previas al despacho. No activa workers ni configuracion ARCA.
begin;

alter table public.mercadopago_order_refunds alter column requested_by drop not null;

create function public.guard_cancelled_order_logistics()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.estado = 'cancelado' and (
    new.estado is distinct from old.estado
    or (nullif(btrim(coalesce(old.tracking_number, '')), '') is null
        and nullif(btrim(coalesce(new.tracking_number, '')), '') is not null)
    or (nullif(btrim(coalesce(old.andreani_tracking, '')), '') is null
        and nullif(btrim(coalesce(new.andreani_tracking, '')), '') is not null)
    or (nullif(btrim(coalesce(old.andreani_envio_id, '')), '') is null
        and nullif(btrim(coalesce(new.andreani_envio_id, '')), '') is not null)
    or (old.andreani_handed_over_at is null and new.andreani_handed_over_at is not null)
  ) then
    raise exception 'CANCELLED_ORDER_LOGISTICS_FORBIDDEN';
  end if;
  return new;
end $$;

create trigger ordenes_guard_cancelled_logistics
before update of estado, tracking_number, andreani_tracking, andreani_envio_id, andreani_handed_over_at
on public.ordenes for each row execute function public.guard_cancelled_order_logistics();

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
  v_credit_total numeric(12, 2);
  v_credit_committed numeric(12, 2);
  v_credit_remaining numeric(12, 2);
  v_fiscal_remaining numeric(12, 2);
  v_external_share numeric(12, 2) := 0;
  v_credit_share numeric(12, 2) := 0;
  v_shift numeric(12, 2);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'No tenés permisos para emitir esta nota de crédito.';
  end if;

  select rol into v_actor_role
  from public.profiles
  where id = p_created_by;

  -- La identidad NULL representa exclusivamente al worker de cancelaciones.
  -- El resto de las operaciones sigue exigiendo un Admin real.
  if p_created_by is null then
    if p_operation_type <> 'cancelacion_antes_despacho'
       or p_destination not in ('external_refund', 'customer_balance') then
      raise exception 'CREDIT_NOTE_ACTOR_FORBIDDEN';
    end if;
    v_actor_role := 'system';
  elsif coalesce(v_actor_role,'') not in ('admin', 'super_admin') then
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

  if p_created_by is null and not exists (
    select 1 from public.ordenes o
    where o.id = p_order_id and o.estado = 'cancelado'
      and o.financial_status = 'refund_pending'
      and o.credit_note_required = true
      and o.invoice_status = 'authorized' and o.invoice_cae is not null
      and o.invoice_queued_at is not null
      and o.andreani_handed_over_at is null
      and nullif(btrim(coalesce(o.andreani_envio_id, '')), '') is null
      and nullif(btrim(coalesce(o.tracking_number, '')), '') is null
      and nullif(btrim(coalesce(o.andreani_tracking, '')), '') is null
  ) then
    raise exception 'AUTO_CREDIT_NOTE_NOT_ELIGIBLE';
  end if;

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

    -- NUEVO (20261014130000): IMPORTE FISCAL ≠ DINERO. La NC refleja la
    -- operación facturada (total ≤ factura, arriba); el dinero que mueve se
    -- reparte entre el pago externo (MP/transferencia) y el saldo a favor
    -- usado en la compra, cada parte con su propio tope. Antes el total de la
    -- NC se topeaba contra el dinero externo: un pedido con saldo + MP no
    -- podía emitir la NC de su cancelación total.
    -- external_amount NULL = NC previa a esta migración (todo su total era
    -- dinero externo).
    select coalesce(sum(coalesce(external_amount, total_amount)), 0), coalesce(sum(customer_credit_amount), 0)
    into v_external_committed, v_credit_committed
    from public.order_credit_notes
    where order_id = p_order_id
      and destination in ('external_refund', 'customer_balance')
      and status in ('processing', 'authorized');

    v_external_paid := least(round(v_external_paid, 2), v_invoice_total);
    v_credit_total := greatest(v_invoice_total - v_external_paid, 0);
    v_refundable_remaining := greatest(v_external_paid - v_external_committed, 0);
    v_credit_remaining := greatest(v_credit_total - v_credit_committed, 0);
    v_fiscal_remaining := round(v_invoice_total - v_committed_total, 2);

    if round(p_total_amount, 2) = v_fiscal_remaining then
      -- La NC que cierra la factura devuelve todo el saldo que quede.
      v_credit_share := v_credit_remaining;
    elsif v_invoice_total > 0 then
      -- Parcial: proporcional a cómo se pagó la venta.
      v_credit_share := least(v_credit_remaining, round(p_total_amount * v_credit_total / v_invoice_total, 2));
    end if;
    v_credit_share := least(v_credit_share, round(p_total_amount, 2));
    v_external_share := round(p_total_amount, 2) - v_credit_share;

    if v_external_share > v_refundable_remaining then
      v_shift := v_external_share - v_refundable_remaining;
      if v_credit_remaining - v_credit_share < v_shift then
        raise exception 'CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT';
      end if;
      v_credit_share := v_credit_share + v_shift;
      v_external_share := v_refundable_remaining;
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

    -- cancelar_compra cancela la orden entera: el reclamo no exige una lista
    -- de unidades afectadas. Las otras operaciones mantienen ese tope.
    if p_claim_id is not null and p_operation_type <> 'cancelacion_antes_despacho' then
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
    operation_type,
    external_amount,
    customer_credit_amount
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
    p_operation_type,
    v_external_share,
    v_credit_share
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

revoke all on function public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text) from public,anon,authenticated,service_role;

create or replace function public.begin_mercadopago_order_refund(
  p_order_id bigint,
  p_admin_id uuid
)
returns table (
  refund_id uuid,
  payment_id text,
  amount numeric,
  idempotency_key text,
  status text,
  should_call_mp boolean,
  mp_refund_id text
)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_order public.ordenes%rowtype;
  v_existing public.mercadopago_order_refunds%rowtype;
  v_row public.mercadopago_order_refunds%rowtype;
  v_role text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  if p_order_id is null then
    raise exception 'INVALID_REFUND_REQUEST';
  end if;

  if p_admin_id is not null then
    select rol into v_role from public.profiles where id = p_admin_id;
    if coalesce(v_role, '') not in ('admin', 'super_admin') then
      raise exception 'REFUND_FORBIDDEN';
    end if;
  end if;

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  -- NULL identifica al worker. Nunca habilita un refund sin venta facturada,
  -- NC autorizada/finalizada por el total externo y cancelacion sin despacho.
  if p_admin_id is null and not (
    v_order.estado = 'cancelado'
    and v_order.financial_status in ('refund_pending', 'refunded')
    and v_order.invoice_status = 'authorized' and v_order.invoice_cae is not null
    and v_order.credit_note_required = false
    and v_order.andreani_handed_over_at is null
    and exists (
      select 1 from public.order_credit_notes n
      where n.order_id = p_order_id and n.status = 'authorized'
        and n.destination = 'external_refund' and n.cae is not null
        and n.finalized_at is not null
    )
    and (select coalesce(sum(coalesce(n.external_amount,n.total_amount)),0)
         from public.order_credit_notes n
         where n.order_id=p_order_id and n.status='authorized'
           and n.destination='external_refund') = v_order.payment_confirmed_amount
  ) then
    raise exception 'AUTO_REFUND_NOT_ELIGIBLE';
  end if;

  -- Se busca cualquier intento existente ANTES de exigir las precondiciones
  -- de "orden elegible para un refund nuevo" -- un refund ya confirmado (o
  -- en curso) es siempre un no-op idempotente, incluso si para entonces
  -- ordenes.financial_status ya cambió a 'refunded' y por lo tanto ya NO
  -- pasaría el chequeo de 'refund_pending' de más abajo.
  select *
  into v_existing
  from public.mercadopago_order_refunds
  where order_id = p_order_id
  order by created_at desc
  limit 1
  for update;

  if found and v_existing.status = 'confirmed' then
    refund_id := v_existing.id;
    payment_id := v_existing.payment_id;
    amount := v_existing.amount;
    idempotency_key := v_existing.idempotency_key;
    status := v_existing.status;
    should_call_mp := false;
    mp_refund_id := v_existing.mp_refund_id;
    return next;
    return;
  end if;

  if found and v_existing.status in ('processing', 'needs_reconciliation') then
    -- Ya hay un intento en curso o ambiguo: nunca se dispara un segundo
    -- POST. El llamador debe reconciliar, no reintentar a ciegas.
    refund_id := v_existing.id;
    payment_id := v_existing.payment_id;
    amount := v_existing.amount;
    idempotency_key := v_existing.idempotency_key;
    status := v_existing.status;
    should_call_mp := false;
    mp_refund_id := v_existing.mp_refund_id;
    return next;
    return;
  end if;

  -- A partir de acá se va a crear o reclamar un intento NUEVO (no existe
  -- ninguno confirmado/en curso): recién ahora se exigen las precondiciones
  -- completas de "orden elegible para un refund".
  if v_order.payment_method_id is distinct from 'mercadopago' then
    raise exception 'ORDER_NOT_PAID_BY_MERCADOPAGO';
  end if;

  if nullif(trim(coalesce(v_order.payment_id, '')), '') is null then
    raise exception 'ORDER_MISSING_MERCADOPAGO_PAYMENT_ID';
  end if;

  if coalesce(v_order.payment_confirmed_amount, 0) <= 0 then
    raise exception 'ORDER_MISSING_CONFIRMED_AMOUNT';
  end if;

  if v_order.financial_status is distinct from 'refund_pending' then
    raise exception 'ORDER_NOT_REFUND_PENDING';
  end if;

  -- NUEVO (punto 3): un pedido facturado necesita NC antes de reintegrar,
  -- sin importar el medio de pago -- misma exigencia que ya aplica a
  -- transferencia (commit_order_refund_proof). credit_note_required ya es
  -- false para pedidos que nunca se facturaron, así que esto nunca bloquea
  -- ese caso.
  if v_order.credit_note_required then
    raise exception 'CREDIT_NOTE_REQUIRED';
  end if;

  -- Defensa en profundidad: approve_order_claim_cancellation ya bloquea
  -- aprobar una cancelación sobre un pedido despachado, pero un refund
  -- puede ejecutarse en un momento posterior a esa aprobación -- se
  -- vuelve a chequear acá con las mismas reglas.
  if lower(coalesce(v_order.estado, '')) in (
       'enviado', 'en_camino', 'visita_fallida', 'en_sucursal',
       'retiro_pendiente', 'retiro_vencido', 'en_devolucion',
       'devuelto_beyonix', 'entregado'
     )
     or nullif(trim(v_order.tracking_number), '') is not null
     or nullif(trim(v_order.andreani_tracking), '') is not null
     or nullif(trim(v_order.andreani_envio_id), '') is not null then
    raise exception 'ORDER_ALREADY_DISPATCHED';
  end if;

  if found and v_existing.status = 'requested' then
    -- Fila creada pero el POST nunca se confirmó como enviado (crash entre
    -- el commit de esta función y la llamada HTTP): se reclama la MISMA
    -- fila, con la MISMA idempotency_key -- nunca una nueva.
    update public.mercadopago_order_refunds
    set status = 'processing', attempt_count = attempt_count + 1
    where id = v_existing.id
    returning * into v_row;
  else
    -- Ninguna fila activa (nunca hubo intento, o el último terminó en
    -- 'failed' -- un rechazo definitivo previo SÍ admite un intento nuevo,
    -- con una idempotency_key propia).
    insert into public.mercadopago_order_refunds (
      order_id, payment_id, amount, status, idempotency_key, requested_by
    ) values (
      p_order_id, v_order.payment_id, v_order.payment_confirmed_amount,
      'processing', 'mercadopago-order-refund:' || gen_random_uuid()::text, p_admin_id
    )
    returning * into v_row;
  end if;

  refund_id := v_row.id;
  payment_id := v_row.payment_id;
  amount := v_row.amount;
  idempotency_key := v_row.idempotency_key;
  status := v_row.status;
  should_call_mp := true;
  mp_refund_id := v_row.mp_refund_id;
  return next;
end;
$function$;

revoke all on function public.begin_mercadopago_order_refund(bigint,uuid) from public,anon,authenticated;
grant execute on function public.begin_mercadopago_order_refund(bigint,uuid) to service_role;

alter table public.ordenes
  add column auto_cancellation_next_attempt_at timestamptz not null default '-infinity',
  add column auto_cancellation_claimed_until timestamptz,
  add column auto_cancellation_attempts integer not null default 0,
  add column auto_cancellation_error text;

create index ordenes_auto_cancellation_due_idx
  on public.ordenes(auto_cancellation_next_attempt_at, id)
  where estado = 'cancelado' and financial_status = 'refund_pending'
    and invoice_status = 'authorized' and invoice_cae is not null;

create function public.claim_auto_cancellation(p_lease interval default interval '5 minutes')
returns setof public.ordenes language plpgsql security definer
set search_path = public as $$
declare v_order public.ordenes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN'; end if;
  select * into v_order from public.ordenes o
  where o.estado = 'cancelado' and o.financial_status = 'refund_pending'
    and o.invoice_status = 'authorized' and o.invoice_cae is not null
    and o.invoice_queued_at is not null
    and exists (select 1 from public.arca_auto_invoicing_control c
      where c.id = true and c.enabled = true and o.invoice_queued_at > c.cutoff_at)
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

create function public.release_auto_cancellation(p_order_id bigint, p_delay interval, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN'; end if;
  update public.ordenes set auto_cancellation_claimed_until = null,
    auto_cancellation_next_attempt_at = case when p_delay is null then 'infinity'::timestamptz else clock_timestamp() + p_delay end,
    auto_cancellation_error = left(p_error, 500)
  where id = p_order_id;
end $$;
revoke all on function public.release_auto_cancellation(bigint,interval,text) from public, anon, authenticated;
grant execute on function public.release_auto_cancellation(bigint,interval,text) to service_role;

create function public.complete_zero_external_cancellation(p_order_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_order public.ordenes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN'; end if;
  select * into v_order from public.ordenes where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.financial_status = 'refunded' then return false; end if;
  if v_order.estado <> 'cancelado' or v_order.financial_status <> 'refund_pending'
     or coalesce(v_order.payment_confirmed_amount, 0) <> 0
     or v_order.credit_note_required or v_order.credit_balance_used <> 0
     or not exists (select 1 from public.order_credit_notes n where n.order_id=p_order_id
       and n.status='authorized' and n.finalized_at is not null and n.cae is not null)
     or (select coalesce(sum(n.total_amount),0) from public.order_credit_notes n
         where n.order_id=p_order_id and n.status='authorized') <> v_order.total
     or (select coalesce(sum(coalesce(n.external_amount,n.total_amount)),0)
         from public.order_credit_notes n where n.order_id=p_order_id and n.status='authorized') <> 0
  then raise exception 'ZERO_EXTERNAL_CANCELLATION_NOT_READY'; end if;
  update public.ordenes set financial_status='refunded', refund_amount=0,
    refund_method='Saldo a favor restaurado', refunded_at=clock_timestamp()
  where id=p_order_id;
  insert into public.order_audit_events(order_id,actor_type,action,previous_status,new_status,metadata)
  values(p_order_id,'system','order_refunded','refund_pending','refunded',
    jsonb_build_object('method','customer_credit_restoration'));
  return true;
end $$;
revoke all on function public.complete_zero_external_cancellation(bigint) from public, anon, authenticated;
grant execute on function public.complete_zero_external_cancellation(bigint) to service_role;

notify pgrst, 'reload schema';
commit;
