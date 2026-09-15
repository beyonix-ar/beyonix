-- Permite a un admin/operador RECHAZAR o CANCELAR un pedido directamente
-- desde el detalle de pedido, sin depender de un order_claims previo del
-- cliente. Es la contraparte "sin claim" de public.approve_order_claim_cancellation
-- (20260816120000_atomic_order_claim_cancellation.sql): reutiliza EXACTAMENTE
-- las mismas guardas de seguridad ya probadas ahí (bloquea si ya está
-- cancelado, ya facturado o ya despachado) y el mismo mecanismo de auditoría/
-- reversa de saldo -- nunca toca stock (se libera solo, vía el mismo
-- mecanismo derivado que ya usa esa función: estado = 'cancelado' es el único
-- valor que la view pública inventory_movements interpreta como "libera
-- stock" a través de inventory_order_consumes_stock(), por eso esta función
-- también fija literalmente estado = 'cancelado' para ambas acciones, nunca
-- un estado nuevo), nunca dispara un refund de Mercado Pago (eso sigue
-- siendo un botón aparte que exige financial_status = 'refund_pending'), y
-- nunca toca transfer_matched_payment_id (columna con índice único parcial,
-- nunca se limpia acá).
--
-- Diferencia entre 'reject' y 'cancel': el modelo real de BEYONIX no tiene
-- (ni necesita) un estado='rechazado' de pedido -- "Rechazar" y "Cancelar"
-- terminan en el mismo estado final ('cancelado'), la única distinción real
-- y segura es si YA hubo evidencia financiera de pago (misma fórmula que
-- isOrderPaymentConfirmed en TS). 'reject' sólo se permite si el pedido
-- NUNCA tuvo pago confirmado (transferencia inválida/en revisión, MP no
-- aprobado, pedido pendiente); 'cancel' sólo se permite si el pago SÍ está
-- confirmado. Esto evita que un mismo botón pueda usarse para dos
-- situaciones financieras distintas.

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
  -- isOrderPaymentConfirmed() (fuente única de verdad ya usada por el resto
  -- del sistema, incluida la elegibilidad client-side de este mismo botón:
  -- lib/orders/admin-order-cancellation-reasons.ts). Deliberadamente más
  -- angosta que la de approve_order_claim_cancellation (que además da por
  -- confirmado el pago sólo por estado='pagado'/despachado): esa diferencia
  -- ya existía entre ese RPC y el resto del código, y esta función nueva no
  -- la repite -- alinearse con el resto evita que el botón mostrado en el
  -- cliente (que sí usa isOrderPaymentConfirmed) difiera de lo que esta RPC
  -- termina permitiendo.
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
      'previousEstado', v_order.estado,
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
  'Rechaza (pago no confirmado) o cancela (pago confirmado) un pedido directamente desde Admin, sin depender de un order_claims previo. Misma transacción atómica/guardas que approve_order_claim_cancellation.';

notify pgrst, 'reload schema';
