-- P0 FINANCIERO (auditoría de cancelaciones/reintegros/NC): begin_partial_credit_note
-- topeaba el importe SOLO contra el total facturado (ordenes.total), sin
-- descontar el dinero que ya volvió al cliente por OTRO canal.
--
-- Escenario confirmado por el usuario:
--   Pedido total: $50.000. Saldo usado: $20.000. Transferencia real: $30.000.
--   1) Al cancelar, reverse_customer_credit_for_order ya devuelve
--      automáticamente los $20.000 a la billetera del cliente.
--   2) begin_partial_credit_note sólo exigía
--      `v_committed_total + p_total_amount <= ordenes.total` ($50.000) --
--      nada le impedía a un admin emitir una NC de $50.000 con destino
--      external_refund o customer_balance.
--   3) Resultado posible: $20.000 (saldo) + $50.000 (NC) = $70.000
--      devueltos por un pedido de $50.000.
--
-- IMPORTANTE -- no se toca la lógica fiscal existente
-- (CREDIT_NOTE_EXCEEDS_INVOICE sigue exactamente igual, contra
-- ordenes.total): una Nota de Crédito debe poder representar fiscalmente el
-- valor facturado completo, sin importar el medio de pago. Lo que faltaba
-- es un tope FINANCIERO independiente, que sólo aplica cuando la NC además
-- mueve dinero de verdad (destination in ('external_refund',
-- 'customer_balance')):
--
--   REFUNDABLE_EXTERNAL_AMOUNT_REMAINING =
--     GREATEST(0,
--       dinero externo realmente pagado por el cliente (payment_confirmed_amount,
--       que ya excluye el saldo usado -- ver confirm_transfer_auto_verification
--       y el endpoint de confirmación manual de transferencia, ambos setean
--       payment_confirmed_amount = importe realmente cobrado por fuera del
--       saldo; fallback a external_amount_due o total-credit_balance_used
--       para pedidos legados sin ese campo poblado)
--       MENOS lo ya comprometido en NC previas de este pedido con destino
--       external_refund/customer_balance (status processing o authorized)
--     )
--
-- El saldo a favor usado (credit_balance_used) NUNCA se resta de nuevo acá:
-- payment_confirmed_amount/external_amount_due ya lo excluyen desde el
-- checkout, así que restarlo otra vez sería un doble descuento.
--
-- P0-3 (mismo bug, otra puerta): si ordenes.financial_status ya es
-- 'refunded' (por CUALQUIER canal -- NC anterior o refund de Mercado Pago
-- confirmado vía record_mercadopago_order_refund_result), una NC nueva con
-- destino external_refund/customer_balance queda bloqueada de entrada con
-- ORDER_ALREADY_REFUNDED. Esto cierra el hueco simétrico al que ya existía
-- del otro lado: begin_mercadopago_order_refund ya exige
-- financial_status='refund_pending' (ORDER_NOT_REFUND_PENDING si no lo es),
-- pero begin_partial_credit_note no tenía el equivalente.
--
-- Redefinición byte a byte de la versión vigente
-- (20260906100000_claims_final_security.sql) salvo las dos inserciones
-- nuevas, marcadas "-- NUEVO" abajo, y los nuevos declare correspondientes.
-- No se toca la firma (mismos 12 args), así que el wrapper con snapshot de
-- 13 args (20260906110000_claim_credit_note_snapshot.sql) hereda el fix sin
-- cambios propios.

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
    raise exception 'CLAIM_REQUIRED';
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

-- 20260906110000_claim_credit_note_snapshot.sql ya revocó EXECUTE de
-- service_role sobre esta firma de 12 args -- sólo el wrapper de 13 args
-- (dueño de la función, SECURITY DEFINER) puede invocarla, para que nadie
-- se salte CREDIT_NOTE_SNAPSHOT_CONFLICT llamando directo al motor. CREATE
-- OR REPLACE no toca privilegios ya otorgados/revocados, pero reafirmamos
-- acá la revocación completa (incluido service_role, sin volver a
-- otorgársela) para que el estado quede explícito en esta misma migración y
-- no dependa de que nadie la reabra sin querer copiando el bloque viejo.
revoke all on function public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb, text
) from public, anon, authenticated, service_role;

comment on function public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb, text
) is
  'Reserva una NC serializada: devoluciones con claim válido y productos afectados, o ajustes sin claim exclusivos de super_admin y sin items. Fix 20260917120000: cuando el destino mueve dinero (external_refund/customer_balance), exige además que el pedido no esté ya refunded y que el importe no supere lo que todavía falta devolver en dinero externo (payment_confirmed_amount menos lo ya comprometido por NC previas) -- independiente del tope fiscal contra el total facturado, que sigue sin cambios.';

notify pgrst, 'reload schema';
