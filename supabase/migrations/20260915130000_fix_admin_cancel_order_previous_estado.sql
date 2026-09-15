-- Corrige un bug confirmado en public.admin_cancel_order
-- (20260915120000_admin_direct_order_cancellation.sql, YA aplicada
-- remotamente -- no se edita, se redefine acá con CREATE OR REPLACE, mismo
-- patrón que usa el resto del proyecto para iterar sobre una función ya
-- desplegada, ej. record_mercadopago_order_refund_result en
-- 20260911180000_mercadopago_refund_phase2.sql).
--
-- BUG: el UPDATE final hacía "returning * into v_order", pisando v_order
-- con la fila YA cancelada. El insert de auditoría, más abajo, todavía leía
-- 'previousEstado' desde v_order.estado -- para ese momento, v_order.estado
-- ya era 'cancelado'. Resultado: metadata.previousEstado quedaba siempre
-- igual a metadata.newEstado ('cancelado'), perdiendo el estado real
-- anterior (ej. 'pendiente', 'pagado', 'en_revision').
--
-- FIX: se captura v_previous_estado := v_order.estado ANTES del UPDATE, y
-- la auditoría usa esa variable en vez de v_order.estado. El resto de la
-- función queda BYTE A BYTE igual: mismo locking (for update), misma
-- validación de admin/rol, misma distinción Rechazar/Cancelar según
-- isOrderPaymentConfirmed, mismos guards de facturado/despachado/ya
-- cancelado, mismo cálculo de financial_status/refund_pending_at, mismo
-- reverse_customer_credit_for_order, nunca toca stock, Mercado Pago,
-- transfer_matched_payment_id, claims históricos, invoice_*/CAE ni
-- Andreani/tracking.
--
-- HARDENING (pedido explícitamente, cambio mínimo): p_reason_code ahora
-- también se valida server-side contra la MISMA lista real de
-- lib/orders/admin-order-cancellation-reasons.ts
-- (ADMIN_ORDER_CANCELLATION_REASONS) -- antes sólo se validaba en la ruta
-- TypeScript. No se inventó ningún motivo nuevo; ver
-- lib/orders/admin-order-cancellation.test.ts para el test que mantiene
-- ambas listas sincronizadas.

create or replace function public.admin_cancel_order(
  p_order_id bigint,
  p_admin_id uuid,
  p_admin_role text,
  p_action text,
  p_reason_code text,
  p_reason_text text
)
returns public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_payment_confirmed boolean;
  v_now timestamptz := now();
  v_previous_financial_status text;
  v_next_financial_status text;
  v_previous_estado text;
  v_reason_code text;
  v_reason_text text;
  v_action text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cancelar este pedido.';
  end if;

  if p_admin_id is null
     or coalesce(p_admin_role, '') not in ('operador', 'admin', 'super_admin') then
    raise exception 'Operador inválido.';
  end if;

  v_action := lower(coalesce(p_action, ''));
  if v_action not in ('reject', 'cancel') then
    raise exception 'INVALID_ACTION';
  end if;

  v_reason_code := nullif(trim(coalesce(p_reason_code, '')), '');
  v_reason_text := nullif(trim(coalesce(p_reason_text, '')), '');
  if v_reason_code is null
     -- Misma lista real que ADMIN_ORDER_CANCELLATION_REASONS en
     -- lib/orders/admin-order-cancellation-reasons.ts -- defensa en
     -- profundidad, la ruta ya la valida antes de llegar acá.
     or v_reason_code not in (
       'solicitud_cliente',
       'pago_no_recibido',
       'pago_invalido',
       'falta_stock',
       'error_administrativo',
       'otro'
     )
     or length(coalesce(v_reason_text, v_reason_code)) < 3
     or length(coalesce(v_reason_text, '')) > 600 then
    raise exception 'INVALID_REASON';
  end if;

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if lower(coalesce(v_order.estado, '')) = 'cancelado' then
    raise exception 'ORDER_ALREADY_CANCELLED';
  end if;

  if v_order.invoice_status in ('authorized', 'processing')
     or v_order.invoice_cae is not null
     or (v_order.invoice_number is not null and v_order.invoice_point is not null) then
    raise exception 'ORDER_ALREADY_INVOICED';
  end if;

  if lower(coalesce(v_order.estado, '')) in (
       'enviado',
       'en_camino',
       'visita_fallida',
       'en_sucursal',
       'retiro_pendiente',
       'retiro_vencido',
       'en_devolucion',
       'devuelto_beyonix',
       'entregado'
     )
     or nullif(trim(v_order.tracking_number), '') is not null
     or nullif(trim(v_order.andreani_tracking), '') is not null
     or nullif(trim(v_order.andreani_envio_id), '') is not null
     or exists (
       select 1
       from unnest(array[
         'camino',
         'tránsito',
         'transito',
         'distribución',
         'distribucion',
         'reparto',
         'visita',
         'entregado'
       ]) as dispatched_status(fragment)
       where lower(coalesce(v_order.andreani_estado, '')) like '%' || fragment || '%'
     ) then
    raise exception 'ORDER_ALREADY_DISPATCHED';
  end if;

  -- Misma fórmula EXACTA que lib/orders/order-payment-status.ts
  -- isOrderPaymentConfirmed() -- sin cambios respecto a la versión anterior.
  v_payment_confirmed :=
    v_order.paid_at is not null
    or coalesce(v_order.payment_confirmed_amount, 0) > 0
    or coalesce(v_order.payment_status, '') in ('confirmado', 'approved', 'confirmed')
    or coalesce(v_order.financial_status, '') in ('payment_confirmed', 'refund_pending', 'refunded');

  if v_action = 'reject' and v_payment_confirmed then
    raise exception 'ORDER_ALREADY_PAID_USE_CANCEL';
  end if;

  if v_action = 'cancel' and not v_payment_confirmed then
    raise exception 'ORDER_NOT_PAID_USE_REJECT';
  end if;

  -- Capturado ANTES del UPDATE ... RETURNING de más abajo -- v_order se
  -- reasigna ahí, así que sin esta variable propia quedaría con el valor
  -- YA cancelado (ese era exactamente el bug).
  v_previous_estado := v_order.estado;
  v_previous_financial_status := coalesce(
    v_order.financial_status,
    v_order.payment_status,
    v_order.estado,
    'pending_payment'
  );
  v_next_financial_status := case
    when v_action = 'cancel' then 'refund_pending'
    else 'cancelled'
  end;

  update public.ordenes
  set
    estado = 'cancelado',
    cancelled_at = v_now,
    financial_status = v_next_financial_status,
    cancellation_requested_at = v_now,
    cancellation_requested_by = p_admin_id,
    refund_pending_at = case when v_action = 'cancel' then v_now else null end,
    credit_note_required = false
  where id = v_order.id
  returning * into v_order;

  if coalesce(v_order.credit_balance_used, 0) > 0 then
    perform *
    from public.reverse_customer_credit_for_order(
      v_order.id,
      case
        when v_action = 'reject' then 'Reintegro de saldo a favor por rechazo de pedido'
        else 'Reintegro de saldo a favor por cancelación de pedido'
      end,
      p_admin_id
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
  )
  values (
    v_order.id,
    'admin',
    p_admin_id,
    case
      when v_action = 'reject' then 'order_rejected_by_admin'
      else 'order_cancelled_refund_pending'
    end,
    v_previous_financial_status,
    v_next_financial_status,
    jsonb_build_object(
      'previousEstado', v_previous_estado,
      'newEstado', 'cancelado',
      'source', case
        when v_action = 'reject' then 'admin_direct_rejection'
        else 'admin_direct_cancellation'
      end,
      'reasonCode', v_reason_code,
      'reasonText', coalesce(v_reason_text, v_reason_code)
    )
  );

  return v_order;
end;
$$;

revoke all on function public.admin_cancel_order(bigint, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_cancel_order(bigint, uuid, text, text, text, text)
  to service_role;

comment on function public.admin_cancel_order(bigint, uuid, text, text, text, text) is
  'Rechaza (pago no confirmado) o cancela (pago confirmado) un pedido directamente desde Admin, sin depender de un order_claims previo. Misma transacción atómica/guardas que approve_order_claim_cancellation. Fix 20260915130000: metadata.previousEstado ya no se pisa con el valor post-UPDATE; p_reason_code validado también server-side.';

notify pgrst, 'reload schema';
