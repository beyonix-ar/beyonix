-- Pago combinado (saldo a favor + Mercado Pago/transferencia):
-- IMPORTE FISCAL DE LA NC ≠ DINERO EXTERNO A REINTEGRAR ≠ SALDO A RESTAURAR.
--
-- HALLAZGO
-- begin_partial_credit_note topeaba el TOTAL de la NC contra el dinero
-- externo cobrado. Pedido de $100.000 = $70.000 MP + $30.000 saldo: la NC de
-- la cancelación total ($100.000, lo facturado) fallaba con
-- CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT. El tope existía porque el dinero se
-- movía por el total de la NC (comprobante de reintegro y acreditación a
-- saldo), así que una NC por el total habría devuelto $100.000 externos.
-- Además, 20261014120000 restauraba TODO el saldo usado con cualquier NC
-- autorizada de un pedido cancelado (sin repartir en cancelaciones parciales).
--
-- CORRECCIÓN
-- 1. Cada NC guarda su desglose de dinero, calculado en la base:
--      total_amount            fiscal (≤ lo facturado, sin cambios)
--      external_amount         dinero externo (MP/transferencia, o acreditado
--                              como saldo si destination='customer_balance')
--      customer_credit_amount  saldo a favor usado en la compra, a restaurar
--    Reparto proporcional a cómo se pagó la venta; la NC que cierra la
--    factura toma todo lo que quede. Cada parte con su propio tope:
--    external ≤ externo cobrado - ya comprometido; saldo ≤ saldo usado - ya
--    comprometido. external_amount NULL = NC previa (todo era externo).
-- 2. commit_order_refund_proof (comprobante de reintegro) liquida
--    external_amount, no el total fiscal.
-- 3. El saldo usado se restaura POR NC autorizada (su customer_credit_amount),
--    una vez por comprobante (source_key + lock por pedido), y descuenta
--    ordenes.credit_balance_used. reverse_customer_credit_for_order deja de
--    restaurar de golpe en ventas con obligación fiscal (siempre lo hace la
--    NC), así nunca hay doble restauración. Sin obligación fiscal (pago nunca
--    confirmado) sigue restaurando en el acto, como siempre.
-- El refund real de Mercado Pago no cambia: devuelve payment_confirmed_amount
-- (el dinero externo), nunca el total fiscal.

begin;

alter table public.order_credit_notes
  add column if not exists external_amount numeric(12, 2),
  add column if not exists customer_credit_amount numeric(12, 2) not null default 0;

alter table public.order_credit_notes
  drop constraint if exists order_credit_notes_money_split_check;
alter table public.order_credit_notes
  add constraint order_credit_notes_money_split_check check (
    customer_credit_amount >= 0
    and (external_amount is null or external_amount >= 0)
    and (external_amount is null or round(external_amount + customer_credit_amount, 2) <= round(total_amount, 2))
  );

comment on column public.order_credit_notes.external_amount is
  'Dinero externo (MP/transferencia, o acreditado como saldo con destination=customer_balance) que mueve la NC. NULL = NC previa a 20261014130000 (todo su total era externo).';
comment on column public.order_credit_notes.customer_credit_amount is
  'Parte del saldo a favor usado en la compra que esta NC restituye (una vez, al autorizarse).';

-- Venta con obligación fiscal: el saldo usado vuelve sólo por NC (por partes).
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
  )
$$;

revoke all on function public.order_customer_credit_reversal_on_hold(bigint) from public, anon, authenticated;
grant execute on function public.order_customer_credit_reversal_on_hold(bigint) to service_role;

create or replace function public.restore_customer_credit_after_credit_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_amount numeric(12, 2) := round(coalesce(new.customer_credit_amount, 0), 2);
  v_source_key text := 'credit-note:' || new.id::text || ':customer-credit-restoration';
  v_balance numeric(12, 2);
begin
  if new.status is distinct from 'authorized'
     or (tg_op = 'UPDATE' and old.status = 'authorized')
     or v_amount <= 0 then
    return new;
  end if;

  -- Mismo lock que reverse_customer_credit_for_order: una sola restauración.
  perform pg_advisory_xact_lock(hashtext('order-credit-reversal:' || new.order_id::text));
  if exists (select 1 from public.customer_credit_movements where source_key = v_source_key) then
    return new;
  end if;
  select * into v_order from public.ordenes where id = new.order_id for update;
  if not found or v_order.usuario_id is null then
    raise exception 'CUSTOMER_CREDIT_RESTORATION_WITHOUT_ACCOUNT';
  end if;

  select public.get_customer_credit_balance(v_order.usuario_id) into v_balance;
  insert into public.customer_credit_movements (
    user_id, movement_type, amount, description, source_type, source_id, order_id,
    created_by, related_movement_id, source_key, resulting_balance, metadata
  ) values (
    v_order.usuario_id, 'reversal', v_amount,
    'Reintegro de saldo a favor usado en la compra (nota de crédito)',
    'reversal', new.order_id::text, new.order_id, new.created_by,
    v_order.credit_balance_movement_id, v_source_key, v_balance + v_amount,
    jsonb_build_object('order_id', new.order_id, 'order_credit_note_id', new.id,
      'reversed_movement_id', v_order.credit_balance_movement_id)
  );
  update public.ordenes
  set credit_balance_used = greatest(round(coalesce(credit_balance_used, 0) - v_amount, 2), 0)
  where id = new.order_id;
  return new;
end;
$$;

revoke all on function public.restore_customer_credit_after_credit_note() from public, anon, authenticated;

drop trigger if exists zz_restore_customer_credit_after_credit_note on public.order_credit_notes;
create trigger zz_restore_customer_credit_after_credit_note
  after insert or update of status on public.order_credit_notes
  for each row execute function public.restore_customer_credit_after_credit_note();

-- begin_partial_credit_note: idéntica a 20261014100000 salvo el reparto
-- fiscal/dinero (bloque NUEVO 20261014130000) y las dos columnas del insert.
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

revoke all on function public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb, text
) from public, anon, authenticated, service_role;

-- commit_order_refund_proof: idéntica a 20260917130000 salvo que la rama con
-- NC liquida external_amount (dinero), no el total fiscal.
create or replace function public.commit_order_refund_proof(p_operation_id uuid, p_actor_id uuid, p_file jsonb)
returns public.ordenes
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_op public.order_claim_operations%rowtype;
  v_order public.ordenes%rowtype;
  v_amount numeric;
  v_notes uuid[];
  v_proof_id bigint;
  v_role text;
  v_path text := p_file->>'path';
  v_reference text := nullif(trim(coalesce(p_file->>'reference', '')), '');
  v_refund_date date := nullif(p_file->>'refund_date', '')::date;
  v_observation text := nullif(trim(coalesce(p_file->>'notes', '')), '');
  v_no_credit_note_path boolean := false;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CLAIM_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id=p_actor_id;
  if coalesce(v_role,'') not in ('admin','super_admin') then raise exception 'CLAIM_FORBIDDEN'; end if;
  if length(coalesce(v_reference, '')) > 120 or length(coalesce(v_observation, '')) > 600 then
    raise exception 'INVALID_REFUND_DETAILS';
  end if;
  select * into v_op from public.order_claim_operations where id=p_operation_id and actor_id=p_actor_id for update;
  if not found then raise exception 'CLAIM_FORBIDDEN'; end if;
  select * into v_order from public.ordenes where id=v_op.order_id for update;
  if v_order.payment_method_id = 'mercadopago' then
    raise exception 'MERCADOPAGO_REQUIRES_REAL_REFUND';
  end if;
  if v_op.status='committed' then return v_order; end if;
  if v_op.status<>'uploading' or v_op.expires_at<=now() or v_op.bucket_id<>'payment-proofs' then raise exception 'CLAIM_CONFLICT'; end if;
  if v_order.financial_status='cancelled' then raise exception 'CLAIM_CONFLICT'; end if;

  -- NUEVO (Fase 4, punto 1): sin NC requerida y sin ninguna NC que mueva
  -- dinero ya emitida para este pedido -- reintegro directo contra el
  -- dinero externo confirmado. Nunca se activa para un pedido que sí
  -- necesita NC (credit_note_required=true cae siempre a la rama de abajo,
  -- sin cambios).
  if not coalesce(v_order.credit_note_required, false)
     and not exists(
       select 1 from public.order_credit_notes
       where order_id = v_order.id and destination <> 'none'
     ) then
    v_no_credit_note_path := true;

    -- Idempotencia: sólo puede completarse una vez por pedido -- tras la
    -- primera ejecución financial_status pasa a 'refunded' y cualquier
    -- reintento cae acá (mismo código de error que ya usa la rama con NC
    -- cuando no queda nada pendiente de liquidar).
    if v_order.financial_status <> 'refund_pending' then
      raise exception 'CLAIM_REFUND_PENDING';
    end if;

    -- Misma fórmula REFUNDABLE_EXTERNAL_AMOUNT que
    -- 20260917120000_credit_note_refundable_external_cap.sql: dinero
    -- externo confirmado, nunca el total (que podría incluir saldo ya
    -- restaurado aparte por reverse_customer_credit_for_order).
    v_amount := greatest(
      coalesce(
        nullif(v_order.payment_confirmed_amount, 0),
        v_order.external_amount_due,
        greatest(coalesce(v_order.original_total, v_order.total, 0) - coalesce(v_order.credit_balance_used, 0), 0),
        0
      ),
      0
    );
    if coalesce(v_amount, 0) <= 0 then raise exception 'CLAIM_REFUND_PENDING'; end if;
  else
    perform id from public.order_credit_notes where order_id=v_order.id order by id for update;
    select sum(coalesce(external_amount,total_amount)),array_agg(id order by id) into v_amount,v_notes from public.order_credit_notes
      where order_id=v_order.id and status='authorized' and destination='external_refund' and settlement_status is distinct from 'completado' and cae is not null;
    if coalesce(v_amount,0)<=0 then raise exception 'CLAIM_REFUND_PENDING'; end if;
    if jsonb_typeof(p_file->'expected_note_ids') is distinct from 'array' or
      v_notes is distinct from (select array_agg(value::uuid order by value::uuid) from jsonb_array_elements_text(p_file->'expected_note_ids')) then raise exception 'CLAIM_CONFLICT'; end if;
    if exists(select 1 from public.order_credit_notes where order_id=v_order.id and status='processing') then raise exception 'CLAIM_CONFLICT'; end if;
  end if;

  if not(v_path=any(v_op.file_paths)) or not exists(select 1 from storage.objects where bucket_id='payment-proofs' and name=v_path) then raise exception 'CLAIM_INVALID_FILES'; end if;
  insert into public.order_refund_proofs(order_id,uploaded_by,file_name,file_path,mime_type,file_size,amount,method,observation,bank_reference,refund_date)
    values(v_order.id,p_actor_id,p_file->>'name','payment-proofs/'||v_path,p_file->>'type',(p_file->>'size')::bigint,v_amount,'Devolución de dinero',v_observation,v_reference,coalesce(v_refund_date, current_date))
    returning id into v_proof_id;
  if not v_no_credit_note_path then
    update public.order_credit_notes set management_status='finalizada',settlement_status='completado',settlement_date=current_date,settlement_reference=v_proof_id::text,updated_at=now() where id=any(v_notes);
  end if;
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
    values(v_order.id,'admin',p_actor_id,'order_refunded',v_order.financial_status,'refunded',jsonb_build_object('proofId',v_proof_id,'amount',v_amount,'creditNoteIds',v_notes,'reference',v_reference,'refundDate',v_refund_date,'requiredCreditNote', not v_no_credit_note_path));
  update public.ordenes set financial_status='refunded',refund_proof_url='payment-proofs/'||v_path,refund_proof_file_name=p_file->>'name',refund_proof_mime_type=p_file->>'type',refund_proof_file_size=(p_file->>'size')::bigint,
    refund_amount=(select sum(amount) from public.order_refund_proofs where order_id=v_order.id),refund_method='Devolución de dinero',refund_uploaded_by=p_actor_id,refund_uploaded_at=now(),refunded_at=now(),refunded_by=p_actor_id,credit_note_required=false where id=v_order.id returning * into v_order;
  if v_order.usuario_id is not null then
    insert into public.customer_notifications(user_id,type,title,body,action_url,order_id,source_key)
      values(v_order.usuario_id,'order_refunded','Dinero reintegrado','Registramos el reintegro de tu pedido.','/cuenta/compras/'||v_order.id,v_order.id,'order:'||v_order.id||':refunded') on conflict(source_key) do nothing;
  end if;
  update public.order_claim_operations set status='committed' where id=v_op.id;
  return v_order;
end $$;

revoke all on function public.commit_order_refund_proof(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.commit_order_refund_proof(uuid,uuid,jsonb) to service_role;

notify pgrst, 'reload schema';

commit;