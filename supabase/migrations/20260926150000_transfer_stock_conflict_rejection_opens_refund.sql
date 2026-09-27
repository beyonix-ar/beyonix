-- Fase 6: rechazar una transferencia YA COBRADA en conflicto de stock abre el
-- reintegro en vez de dejar el dinero sin camino de devolución.
--
-- BUG: auto_verified_stock_conflict significa que Mercado Pago identificó la
-- transferencia (payment.id reclamado, importe exacto) pero el stock ya no
-- alcanzaba. Admin sólo puede "confirmar" (si repone stock) o "rechazar".
-- review_manual_transfer_payment trataba ese rechazo igual que el de un
-- comprobante dudoso: estado='pendiente', financial_status='pending_payment',
-- payment_status='rechazado'. El dinero recibido quedaba sin ninguna
-- obligación de reintegro registrada, la acción urgente del Admin
-- desaparecía (payment_status ya no es de conflicto) y el pedido seguía
-- "pendiente" con su beneficio retenido.
--
-- CORRECCIÓN (misma transacción y lock de fila, sin sistema paralelo): ese
-- rechazo cancela el pedido y lo deja en el flujo de reintegro EXISTENTE,
-- igual que record_transfer_payment_after_cancellation:
--   * estado='cancelado', financial_status='refund_pending',
--     refund_pending_at, cancelled_at;
--   * payment_status sigue en auto_verified_stock_conflict: Admin conserva la
--     acción urgente hasta que el reintegro se registra (refunded);
--   * external_amount_due = importe REALMENTE recibido (el validado al
--     centavo contra este mismo campo al identificar la transferencia),
--     capturado ANTES de devolver el saldo (reverse_customer_credit_for_order
--     lo vuelve al total); commit_order_refund_proof (rama sin NC: nunca se
--     facturó) lo cierra una sola vez;
--   * saldo a favor y beneficio retenidos vuelven al cliente una sola vez
--     (reversión idempotente por source_key; beneficio sólo si sigue ligado a
--     ESTE pedido);
--   * el stock nunca se consumió (conflicto) y la cancelación libera la
--     reserva vía release_order_stock_reservation.
-- El resto de la función (permisos, transiciones, comprobante dudoso) queda
-- idéntico a 20260923120000.
--
-- Depende de: 20260923120000_atomic_manual_transfer_review.sql.

begin;

create or replace function public.review_manual_transfer_payment(
  p_order_id bigint, p_actor_id uuid, p_expected_status text,
  p_next_status text, p_observation text
)
returns public.ordenes language plpgsql security definer set search_path = public as $$
declare
  v_order public.ordenes%rowtype;
  v_previous text;
  v_observation text := nullif(btrim(p_observation), '');
  v_paid_conflict boolean;
  v_received numeric;
begin
  if auth.role() is distinct from 'service_role' or not exists (
    select 1 from public.profiles where id = p_actor_id and rol in ('admin', 'super_admin')
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found or v_order.payment_method_id is distinct from 'transferencia' then
    raise exception 'TRANSFER_ORDER_NOT_FOUND';
  end if;
  -- Reintento del rechazo de un conflicto ya resuelto (doble click): mismo
  -- resultado, sin repetir reversión, beneficio ni auditoría.
  if p_next_status = 'rechazado'
     and v_order.payment_status = 'auto_verified_stock_conflict'
     and v_order.estado = 'cancelado'
     and v_order.financial_status in ('refund_pending', 'refunded') then
    return v_order;
  end if;
  if v_order.estado = 'cancelado' or v_order.cancelled_at is not null
     or v_order.cancellation_requested_at is not null
     or coalesce(v_order.financial_status, 'pending_payment') not in
        ('pending_payment', 'payment_submitted', 'payment_confirmed') then
    raise exception 'TRANSFER_CANCELLATION_CONFLICT';
  end if;
  if p_next_status is null or p_next_status not in ('pendiente_comprobante', 'en_revision', 'confirmado', 'rechazado') then
    raise exception 'TRANSFER_INVALID_TRANSITION';
  end if;
  -- Read-only retry: no audit, balance reversal, stock refresh or update repeated.
  if v_order.payment_status = p_next_status then return v_order; end if;
  if v_order.payment_status is distinct from p_expected_status then
    raise exception 'TRANSFER_PAYMENT_CONFLICT';
  end if;
  if v_order.payment_status = 'confirmado' or v_order.financial_status = 'payment_confirmed'
     or p_next_status not in ('confirmado', 'rechazado')
     or (coalesce(v_order.payment_status, '') <> 'auto_verified_stock_conflict' and
         (v_order.payment_status is distinct from 'en_revision' or nullif(v_order.payment_proof_url, '') is null)) then
    raise exception 'TRANSFER_INVALID_TRANSITION';
  end if;
  if p_next_status = 'rechazado' and coalesce(length(v_observation), 0) < 3 then
    raise exception 'TRANSFER_REJECTION_REASON_REQUIRED';
  end if;
  v_previous := coalesce(v_order.financial_status, v_order.payment_status, 'pending_payment');
  perform set_config('beyonix.actor_id', p_actor_id::text, true);

  v_paid_conflict := p_next_status = 'rechazado'
    and v_order.payment_status = 'auto_verified_stock_conflict'
    and v_order.transfer_matched_payment_id is not null;

  if v_paid_conflict then
    -- Importe recibido: validado al centavo contra external_amount_due al
    -- identificar la transferencia. Se toma ANTES de devolver el saldo.
    v_received := coalesce(v_order.external_amount_due, v_order.total, 0);
    if round(v_received * 100) <= 0 then
      raise exception 'TRANSFER_INVALID_TRANSITION';
    end if;

    update public.ordenes set
      estado = 'cancelado',
      financial_status = 'refund_pending',
      cancelled_at = coalesce(cancelled_at, now()),
      refund_pending_at = coalesce(refund_pending_at, now()),
      payment_confirmation_observation = left(v_observation, 1000)
    where id = p_order_id returning * into v_order;

    if coalesce(v_order.credit_balance_used, 0) > 0 then
      perform public.reverse_customer_credit_for_order(
        p_order_id, 'Reintegro de saldo: la transferencia no pudo confirmarse por falta de stock', p_actor_id);
    end if;
    if v_order.store_benefit_id is not null then
      update public.customer_store_benefits
      set status = 'active', used_at = null, used_order_id = null
      where id = v_order.store_benefit_id and status = 'used' and used_order_id = p_order_id;
    end if;

    -- El pedido está cancelado y nunca puede volver a cobrarse: este valor
    -- sólo describe el dinero recibido a devolver (commit_order_refund_proof).
    update public.ordenes set external_amount_due = v_received
    where id = p_order_id returning * into v_order;

    insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
    values (p_order_id, 'admin', p_actor_id, 'transfer_stock_conflict_rejected_refund_pending',
      v_previous, v_order.financial_status,
      jsonb_build_object('observation', v_observation, 'receivedAmount', v_received,
        'matchedPaymentId', v_order.transfer_matched_payment_id,
        'creditBalanceRestored', v_order.credit_balance_used = 0,
        'storeBenefitId', v_order.store_benefit_id));
    return v_order;
  end if;

  update public.ordenes set
    payment_status = p_next_status,
    estado = case when p_next_status = 'confirmado' then 'pagado' else 'pendiente' end,
    financial_status = case when p_next_status = 'confirmado' then 'payment_confirmed' else 'pending_payment' end,
    paid_at = case when p_next_status = 'confirmado' then coalesce(v_order.paid_at, now()) else null end,
    payment_confirmed_by = case when p_next_status = 'confirmado' then p_actor_id else null end,
    payment_confirmed_at = case when p_next_status = 'confirmado' then now() else null end,
    payment_confirmed_amount = case when p_next_status = 'confirmado' then coalesce(v_order.external_amount_due, v_order.total, 0) else null end,
    payment_confirmation_observation = left(v_observation, 1000),
    order_change_status = case when p_next_status = 'confirmado' then 'change_approved' else v_order.order_change_status end,
    order_change_extra_amount = case when p_next_status = 'confirmado' then 0 else v_order.order_change_extra_amount end
  where id = p_order_id returning * into v_order;
  if p_next_status = 'rechazado' and coalesce(v_order.credit_balance_used, 0) > 0 then
    perform public.reverse_customer_credit_for_order(p_order_id, 'Reintegro de saldo por pago rechazado', p_actor_id);
    select * into v_order from public.ordenes where id = p_order_id;
  end if;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (p_order_id, 'admin', p_actor_id,
    case when p_next_status = 'confirmado' then 'payment_confirmed' else 'payment_status_rechazado' end,
    v_previous, v_order.financial_status,
    jsonb_build_object('observation', v_observation, 'amount', v_order.total,
      'externalAmount', v_order.payment_confirmed_amount, 'creditBalanceUsed', v_order.credit_balance_used,
      'proofUrl', v_order.payment_proof_url, 'proofFileName', v_order.payment_proof_file_name));
  return v_order;
end;
$$;
revoke all on function public.review_manual_transfer_payment(bigint, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.review_manual_transfer_payment(bigint, uuid, text, text, text) to service_role;
notify pgrst, 'reload schema';
commit;
