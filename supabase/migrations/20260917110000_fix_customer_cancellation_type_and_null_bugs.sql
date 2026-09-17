-- BUG CONFIRMADO CONTRA LA BASE REAL (transacciones de prueba con ROLLBACK,
-- sin datos de cliente reales): la cancelación de compra desde "Mis compras"
-- (POST /api/orders/[id]/cancel -> request_customer_order_cancellation_with_claim)
-- fallaba con el mensaje genérico "No se pudo cancelar la compra de forma
-- segura." para pedidos completamente normales, previos al envío, porque la
-- función tenía DOS bugs reales sin relación con las reglas de negocio:
--
-- 1) `insert into order_claims (..., offered_resolutions, ...) values (...,
--    '[]'::jsonb, ...)`. En la base real `order_claims.offered_resolutions`
--    es `text[]`, no jsonb (ver el CHECK
--    order_claims_offered_resolutions_check, que ya lo trata como array).
--    Postgres no castea jsonb -> text[] implícitamente: CUALQUIER llamada a
--    esta función fallaba con
--    `ERROR 42804: column "offered_resolutions" is of type text[] but
--    expression is of type jsonb`, un error que
--    app/api/orders/[id]/cancel/route.ts no reconoce y que cae directo al
--    fallback genérico. Esto rompía el 100% de las cancelaciones de cliente
--    (no así admin_cancel_order/approve_order_claim_cancellation, que nunca
--    insertan en order_claims).
--
-- 2) `v_invoiced := v_order.invoice_status in ('authorized','processing')
--    or ...`. Cuando `invoice_status is null` (pedido pagado pero todavía no
--    facturado -- el caso más común de "previo al envío"), `IN` con NULL
--    evalúa a NULL, no a false, y esa propagación de NULL llega hasta
--    `credit_note_required = v_payment_confirmed and v_invoiced` (true and
--    null = null). `ordenes.credit_note_required` es NOT NULL, así que el
--    UPDATE fallaba con
--    `ERROR 23502: null value in column "credit_note_required" ... violates
--    not-null constraint` -- de nuevo, un error no reconocido por el route
--    que cae al mensaje genérico.
--
-- Ambos bugs se arrastraban sin cambios desde
-- 20260825130000_atomic_customer_cancellation_claim.sql, incluida la
-- redefinición de 20260916100000_block_cancellation_during_andreani_creation.sql
-- (que sólo agregó el guard de Andreani). No se toca ninguna migración ya
-- aplicada: esta es una redefinición nueva, byte a byte igual salvo los dos
-- literales corregidos (marcados "-- FIX" abajo).

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
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cancelar esta compra.';
  end if;

  if p_order_id is null or p_user_id is null
     or length(trim(coalesce(p_reason, ''))) not between 5 and 600 then
    raise exception 'INVALID_CANCELLATION_REQUEST';
  end if;

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

  -- Guard de creación Andreani en curso / conciliación pendiente -- sin
  -- cambios respecto a 20260916100000.
  if v_order.andreani_creation_status = 'claimed' then
    raise exception 'ANDREANI_CREATION_IN_PROGRESS';
  end if;
  if v_order.andreani_creation_status = 'reconciliation_required' then
    raise exception 'ANDREANI_RECONCILIATION_REQUIRED';
  end if;

  if lower(coalesce(v_order.estado, '')) in (
       'enviado', 'en_camino', 'visita_fallida', 'en_sucursal',
       'retiro_pendiente', 'retiro_vencido', 'en_devolucion',
       'devuelto_beyonix', 'entregado'
     )
     or nullif(btrim(coalesce(v_order.tracking_number, '')), '') is not null
     or nullif(btrim(coalesce(v_order.andreani_tracking, '')), '') is not null
     or nullif(btrim(coalesce(v_order.andreani_envio_id, '')), '') is not null then
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
  -- FIX 2/2: `invoice_status in (...)` con invoice_status NULL (pedido
  -- pagado, todavía no facturado) evaluaba a NULL y propagaba NULL hasta
  -- credit_note_required (NOT NULL) -- ver el comentario de cabecera.
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
    -- FIX 1/2: offered_resolutions es text[] en la base real, no jsonb.
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
      'source', 'customer_cancellation'
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

  return to_jsonb(v_order) || jsonb_build_object('claim_id', v_claim.id);
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
  'Cancela una orden no despachada y crea atómicamente el claim comercial del cliente. Bloquea si hay una creación Andreani en curso (claimed) o con resultado externo incierto (reconciliation_required). Fix 20260917110000: offered_resolutions es text[] (no jsonb) y v_invoiced ya no propaga NULL cuando invoice_status es NULL.';

notify pgrst, 'reload schema';
