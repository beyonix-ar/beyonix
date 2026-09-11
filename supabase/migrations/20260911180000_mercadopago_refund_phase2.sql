-- FASE 2 del sistema seguro de refunds de Mercado Pago (sobre la Fase 1,
-- 20260911170000). Cierra los P1 operativos: cierre automático del claim,
-- reconciliación por lote (job/cron), integración con el webhook, y
-- auditoría explícita de cada transición -- sin debilitar ninguna
-- protección existente (firma HMAC, replay, reconsulta real, ARS, monto,
-- ownership, approved_after_cancellation, reverse_customer_credit_for_order,
-- reverse_customer_credit_topup, stock derivado).

begin;

-- ============================================================
-- 1. close_mercadopago_order_refund_claim
-- ============================================================
-- Cierra el order_claims de cancelación asociado a un pedido cuando su
-- refund de Mercado Pago ya está 'confirmed' -- NUNCA reutiliza
-- commit_order_refund_proof/mark_refund_done (esos quedan bloqueados para
-- pagos de Mercado Pago desde la Fase 1). Idempotente: si el claim ya
-- estaba cerrado por esta misma vía, es un no-op sin error. Nunca toca
-- stock ni customer_credit -- sólo status/resolution/auditoría del claim.
create or replace function public.close_mercadopago_order_refund_claim(
  p_order_id bigint,
  p_refund_id uuid
)
returns public.order_claims
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_refund public.mercadopago_order_refunds%rowtype;
  v_claim public.order_claims%rowtype;
  v_now timestamptz := now();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select *
  into v_refund
  from public.mercadopago_order_refunds
  where id = p_refund_id
  for update;

  if not found then
    raise exception 'REFUND_ATTEMPT_NOT_FOUND';
  end if;

  -- El refund tiene que pertenecer EXACTAMENTE al pedido indicado -- nunca
  -- se cierra el claim de un pedido usando el refund de otro.
  if v_refund.order_id is distinct from p_order_id then
    raise exception 'REFUND_ORDER_MISMATCH';
  end if;

  if v_refund.status is distinct from 'confirmed' then
    raise exception 'REFUND_NOT_CONFIRMED';
  end if;

  -- Único claim de cancelación elegible para este pedido (el mismo
  -- discriminante que usa approve_order_claim_cancellation:
  -- failure_type='cancelar_compra'). Si no hay ninguno, no hay nada que
  -- cerrar por esta vía -- no es un error financiero, el refund ya quedó
  -- confirmado igual.
  select *
  into v_claim
  from public.order_claims
  where order_id = p_order_id
    and failure_type = 'cancelar_compra'
  order by created_at desc
  limit 1
  for update;

  if not found then
    return null;
  end if;

  -- Idempotente: ya cerrado (por esta misma función en un intento previo,
  -- p.ej. una reconciliación posterior que vuelve a confirmar) -- no-op,
  -- nunca un error financiero.
  if v_claim.status = 'cerrado' then
    return v_claim;
  end if;

  if v_claim.status = 'rechazado' then
    raise exception 'CLAIM_ALREADY_REJECTED';
  end if;

  update public.order_claims
  set
    status = 'cerrado',
    resolution = 'reintegro_total',
    admin_response = 'El reintegro fue procesado por Mercado Pago al medio de pago original.',
    closed_at = v_now,
    admin_needs_action = false,
    updated_at = v_now
  where id = v_claim.id
  returning * into v_claim;

  insert into public.order_claim_messages (claim_id, author_user_id, author_role, message)
  values (v_claim.id, null, 'admin', 'El reintegro fue procesado por Mercado Pago al medio de pago original.');

  insert into public.order_audit_events (
    order_id, actor_type, actor_id, action, previous_status, new_status, metadata
  ) values (
    p_order_id, 'system', null, 'mp_refund_claim_closed', 'reintegro_pendiente', 'cerrado',
    jsonb_build_object('claimId', v_claim.id, 'refundAttemptId', v_refund.id, 'mpRefundId', v_refund.mp_refund_id)
  );

  return v_claim;
end;
$function$;

revoke execute on function public.close_mercadopago_order_refund_claim(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.close_mercadopago_order_refund_claim(bigint, uuid)
  to service_role;

-- ============================================================
-- 2. claim_mercadopago_refunds_for_reconciliation
-- ============================================================
-- Reserva un lote de intentos 'needs_reconciliation' para el job de
-- reconciliación, usando FOR UPDATE SKIP LOCKED -- el mecanismo nativo de
-- Postgres para que dos workers concurrentes NUNCA tomen la misma fila.
-- `p_lock_timeout_seconds` libera filas cuyo lock quedó huérfano (el worker
-- que las reservó se cayó sin terminar) para que no queden bloqueadas para
-- siempre.
create or replace function public.claim_mercadopago_refunds_for_reconciliation(
  p_batch_size integer default 10,
  p_lock_timeout_seconds integer default 300
)
returns setof public.mercadopago_order_refunds
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  return query
  update public.mercadopago_order_refunds
  set reconciliation_locked_at = now()
  where id in (
    select id
    from public.mercadopago_order_refunds
    where status = 'needs_reconciliation'
      and (
        reconciliation_locked_at is null
        or reconciliation_locked_at < now() - make_interval(secs => greatest(p_lock_timeout_seconds, 1))
      )
    order by updated_at asc
    limit greatest(least(coalesce(p_batch_size, 10), 50), 1)
    for update skip locked
  )
  returning *;
end;
$function$;

revoke execute on function public.claim_mercadopago_refunds_for_reconciliation(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_mercadopago_refunds_for_reconciliation(integer, integer)
  to service_role;

-- ============================================================
-- 3. record_mercadopago_order_refund_result (CREATE OR REPLACE)
-- ============================================================
-- Misma lógica que la versión de la Fase 1 (20260911170000), más:
-- - auditoría explícita en CADA transición real de estado (mp_refund_*),
--   nunca duplicada ante reentregas (sólo audita si el status
--   efectivamente cambió);
-- - al confirmar, cierra automáticamente el claim de cancelación asociado
--   (close_mercadopago_order_refund_claim) en la MISMA transacción.
create or replace function public.record_mercadopago_order_refund_result(
  p_refund_id uuid,
  p_outcome text,
  p_mp_refund_id text default null,
  p_error_code text default null,
  p_error_message text default null
)
returns public.mercadopago_order_refunds
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_row public.mercadopago_order_refunds%rowtype;
  v_order public.ordenes%rowtype;
  v_previous_status text;
  v_audit_action text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  if p_outcome not in ('confirmed', 'failed', 'needs_reconciliation', 'requested') then
    raise exception 'INVALID_REFUND_OUTCOME';
  end if;

  select *
  into v_row
  from public.mercadopago_order_refunds
  where id = p_refund_id
  for update;

  if not found then
    raise exception 'REFUND_ATTEMPT_NOT_FOUND';
  end if;

  if v_row.status in ('confirmed', 'failed') then
    return v_row;
  end if;

  if v_row.status not in ('processing', 'needs_reconciliation') then
    raise exception 'REFUND_ATTEMPT_NOT_IN_PROGRESS';
  end if;

  v_previous_status := v_row.status;

  update public.mercadopago_order_refunds
  set
    status = p_outcome,
    mp_refund_id = coalesce(p_mp_refund_id, mp_refund_id),
    error_code = case when p_outcome in ('failed', 'needs_reconciliation') then p_error_code else null end,
    error_message = case when p_outcome in ('failed', 'needs_reconciliation') then p_error_message else null end,
    reconciliation_locked_at = case when p_outcome = 'needs_reconciliation' then reconciliation_locked_at else null end,
    completed_at = case when p_outcome in ('confirmed', 'failed') then now() else completed_at end
  where id = p_refund_id
  returning * into v_row;

  -- Auditoría explícita de la transición -- sólo si realmente cambió, para
  -- no spamear ante reconciliaciones repetidas que concluyen lo mismo
  -- (needs_reconciliation -> needs_reconciliation no es una transición real).
  if v_previous_status is distinct from p_outcome then
    v_audit_action := case p_outcome
      when 'confirmed' then 'mp_refund_confirmed'
      when 'failed' then 'mp_refund_failed'
      when 'needs_reconciliation' then 'mp_refund_needs_reconciliation'
      when 'requested' then 'mp_refund_requested'
    end;

    insert into public.order_audit_events (
      order_id, actor_type, actor_id, action, previous_status, new_status, metadata
    ) values (
      v_row.order_id, 'system', null, v_audit_action, v_previous_status, p_outcome,
      jsonb_build_object(
        'refundAttemptId', v_row.id,
        'paymentId', v_row.payment_id,
        'mpRefundId', v_row.mp_refund_id,
        'amount', v_row.amount,
        'errorCode', p_error_code
      )
    );
  end if;

  if p_outcome = 'confirmed' then
    select * into v_order from public.ordenes where id = v_row.order_id for update;

    update public.ordenes
    set
      financial_status = 'refunded',
      refund_method = 'mercadopago',
      refund_amount = v_row.amount,
      refunded_at = now(),
      refunded_by = v_row.requested_by
    where id = v_row.order_id;

    perform public.close_mercadopago_order_refund_claim(v_row.order_id, v_row.id);
  end if;

  return v_row;
end;
$function$;

revoke execute on function public.record_mercadopago_order_refund_result(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_mercadopago_order_refund_result(uuid, text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
