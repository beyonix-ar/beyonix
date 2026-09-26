-- Cierre Fases 1-4: transferencia real que llega DESPUÉS de que su pedido se
-- canceló sin pago.
--
-- Caso: el pedido A por transferencia vence y se cancela sin evidencia de
-- pago -- al iniciar un nuevo intento (checkout_superseded) o por la ventana
-- técnica de 48 h (vencido_falta_comprobante) -- y su saldo a favor y su
-- beneficio se devuelven. Después aparece la transferencia de A. Antes nadie
-- la detectaba: el cron y claim_transfer_verification_attempt descartan los
-- pedidos cancelados.
--
-- Esta función SÓLO REGISTRA el pago, de forma atómica bajo el lock de la fila:
--   * reclama el payment.id en transfer_verification_payment_claims
--     (insert-only): nunca puede acreditar otro pedido;
--   * reutiliza el estado existente approved_after_cancellation ("pago cobrado
--     sobre un pedido ya cancelado", el mismo que usa el webhook de Mercado
--     Pago) -> Admin lo ve como pago cobrado sin confirmar (acción urgente);
--   * NO confirma el pedido, NO toca estado (sigue cancelado) ni stock, NO
--     reacredita saldo ni reactiva beneficio (ya se devolvieron: confirmar
--     con este pago duplicaría el crédito o el beneficio).
-- Resolución: el pedido queda listo para el flujo de reintegro EXISTENTE
-- (sin sistema paralelo). financial_status pasa a refund_pending, así
-- getCancellationNextAction ofrece "Registrar reintegro" y
-- commit_order_refund_proof (rama sin nota de crédito: nunca se facturó)
-- lo cierra una sola vez con comprobante -> financial_status='refunded' y la
-- acción urgente desaparece. external_amount_due pasa a ser el importe
-- REALMENTE recibido (el previo queda en la auditoría): es la base de
-- REFUNDABLE_EXTERNAL_AMOUNT de ese flujo. El pedido está cancelado y nunca
-- puede volver a cobrarse ni confirmarse, así que este valor sólo describe el
-- dinero a devolver.
--
-- El monto se valida contra transfer_amount_declared: el importe que el
-- servidor le indicó transferir antes de mostrar alias/CVU. external_amount_due
-- ya no sirve: reverse_customer_credit_for_order lo vuelve al total.
begin;

create function public.record_transfer_payment_after_cancellation(
  p_order_id bigint,
  p_matched_payment_id text,
  p_matched_operation_type text,
  p_matched_payment_method_id text,
  p_matched_amount numeric,
  p_matched_identification_type text,
  p_matched_identification_number text,
  p_matched_dni_derived text,
  p_matched_bank_transfer_id text,
  p_matched_date_created timestamptz,
  p_matched_date_approved timestamptz
)
returns public.ordenes
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_order public.ordenes%rowtype;
  v_now timestamptz := now();
  v_snapshot jsonb;
  v_previous_financial_status text;
  v_previous_external_amount_due numeric;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para esta operación.';
  end if;
  if coalesce(trim(p_matched_payment_id), '') = '' then
    raise exception 'INVALID_PAYMENT_ID: falta el identificador de Mercado Pago.';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: no encontramos el pedido.';
  end if;
  if v_order.payment_method_id is distinct from 'transferencia' then
    raise exception 'NOT_TRANSFER_ORDER: este pedido no corresponde a transferencia bancaria.';
  end if;

  -- Idempotente: el mismo payment.id ya registrado para este pedido.
  if v_order.payment_status = 'approved_after_cancellation'
     and v_order.transfer_matched_payment_id = p_matched_payment_id then
    return v_order;
  end if;

  if v_order.estado is distinct from 'cancelado'
     or v_order.financial_status is distinct from 'cancelled'
     or coalesce(v_order.payment_status, '') not in ('checkout_superseded', 'vencido_falta_comprobante')
     or v_order.transfer_matched_payment_id is not null then
    raise exception 'NOT_ELIGIBLE: el pedido no es una transferencia cancelada sin pago.';
  end if;

  if v_order.transfer_amount_declared is null
     or round(v_order.transfer_amount_declared * 100) <= 0
     or round(coalesce(p_matched_amount, -1) * 100) <> round(v_order.transfer_amount_declared * 100) then
    raise exception 'AMOUNT_MISMATCH: el importe no coincide con el que se indicó transferir.';
  end if;

  if exists (
    select 1 from public.ordenes
    where transfer_matched_payment_id = p_matched_payment_id and id <> p_order_id
  ) then
    raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
  end if;
  insert into public.transfer_verification_payment_claims (payment_id, order_id)
  values (p_matched_payment_id, p_order_id)
  on conflict (payment_id) do nothing;
  if not exists (
    select 1 from public.transfer_verification_payment_claims
    where payment_id = p_matched_payment_id and order_id = p_order_id
  ) then
    raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
  end if;

  v_snapshot := jsonb_build_object(
    'operationType', p_matched_operation_type,
    'paymentMethodId', p_matched_payment_method_id,
    'identificationType', p_matched_identification_type,
    'identificationNumber', p_matched_identification_number,
    'dniDerivado', p_matched_dni_derived,
    'bankTransferId', p_matched_bank_transfer_id,
    'dateCreated', p_matched_date_created,
    'dateApproved', p_matched_date_approved,
    'detectedAfterCancellation', true
  );

  v_previous_financial_status := v_order.financial_status;
  v_previous_external_amount_due := v_order.external_amount_due;

  begin
    update public.ordenes
    set
      payment_status = 'approved_after_cancellation',
      financial_status = 'refund_pending',
      refund_pending_at = coalesce(refund_pending_at, v_now),
      external_amount_due = p_matched_amount,
      transfer_verification_status = 'manual_review',
      transfer_verification_failure_reason = 'paid_after_cancellation',
      transfer_last_verification_at = v_now,
      transfer_matched_payment_id = p_matched_payment_id,
      transfer_match_snapshot = v_snapshot
    where id = v_order.id
    returning * into v_order;
  exception
    when unique_violation then
      raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
  end;

  insert into public.order_audit_events (
    order_id, actor_type, actor_id, action, previous_status, new_status, metadata
  ) values (
    v_order.id, 'system', null, 'transfer_payment_after_cancellation',
    v_previous_financial_status, v_order.financial_status,
    jsonb_build_object(
      'provider', 'mercadopago',
      'matchedPaymentId', p_matched_payment_id,
      'matchedAmount', p_matched_amount,
      'previousExternalAmountDue', v_previous_external_amount_due,
      'cancelledAt', v_order.cancelled_at,
      'reason', 'order_cancelled_before_payment_detected_requires_manual_resolution'
    )
  );

  return v_order;
end;
$$;

revoke all on function public.record_transfer_payment_after_cancellation(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_transfer_payment_after_cancellation(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz)
  to service_role;

comment on function public.record_transfer_payment_after_cancellation(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz) is
  'Registra (sin confirmar) una transferencia real detectada sobre un pedido por transferencia cancelado sin pago: reclama el payment.id y deja payment_status=approved_after_cancellation + financial_status=refund_pending (importe recibido en external_amount_due) para el flujo de reintegro existente (commit_order_refund_proof). No toca estado, stock, saldo ni beneficio.';

commit;
