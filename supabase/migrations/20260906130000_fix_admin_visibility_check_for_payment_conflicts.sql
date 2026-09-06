-- BUG CONFIRMADO CONTRA LA BASE REAL (auditoría Mercado Pago):
--
-- `ordenes_admin_visibility_payment_check` (20260815140000) exige, para
-- cualquier orden mercadopago con admin_visible_at no nulo, que
-- payment_status sea EXACTAMENTE 'approved'. La migración posterior
-- 20260903160000 actualizó `set_order_admin_visibility()` para que también
-- fije admin_visible_at cuando payment_status está en
-- ('approved_amount_mismatch','approved_currency_mismatch',
-- 'approved_stock_conflict') -- pero NUNCA actualizó este constraint.
--
-- Consecuencia real: cuando el webhook de Mercado Pago detecta
-- approved_stock_conflict (pago aprobado que el guardián de inventario
-- rechaza) e intenta persistir payment_status='approved_stock_conflict', el
-- trigger BEFORE UPDATE fija admin_visible_at a un timestamp no nulo y el
-- constraint CHECK subsiguiente lo rechaza de inmediato (payment_status ya no
-- es 'approved'). El UPDATE completo falla -- y como ese código no revisa el
-- error de esa escritura puntual, la falla es totalmente silenciosa: Mercado
-- Pago recibe 200 OK, se guarda un evento de auditoría aparte, pero la propia
-- fila de la orden NUNCA refleja el conflicto ni se vuelve visible en Admin.
-- Verificado en una transacción de prueba aislada (fila sintética, sin datos
-- de cliente reales, insertada y eliminada en el momento) contra la base real:
-- el UPDATE a payment_status='approved_stock_conflict' viola el constraint
-- exactamente como se describe.
--
-- CORRECCIÓN: el constraint pasa a aceptar también los tres payment_status
-- de conflicto post-aprobación, con la MISMA condición mínima que ya usa el
-- trigger para esos casos (sólo payment_id no nulo -- financial_status y
-- payment_confirmed_at pueden no estar seteados todavía, porque el pago se
-- aprobó pero la orden nunca llegó a confirmarse).

begin;

alter table public.ordenes
  drop constraint if exists ordenes_admin_visibility_payment_check;

alter table public.ordenes
  add constraint ordenes_admin_visibility_payment_check check (
    payment_method_id is distinct from 'mercadopago'
    or admin_visible_at is null
    or (
      payment_status = 'approved'
      and financial_status in (
        'payment_confirmed',
        'cancellation_requested',
        'refund_pending',
        'refunded'
      )
      and payment_confirmed_at is not null
      and payment_id is not null
    )
    or (
      payment_status in (
        'approved_amount_mismatch',
        'approved_currency_mismatch',
        'approved_stock_conflict'
      )
      and payment_id is not null
    )
  );

comment on constraint ordenes_admin_visibility_payment_check on public.ordenes is
  'admin_visible_at para una orden mercadopago exige payment_status=approved (con financial_status/payment_confirmed_at/payment_id completos) o uno de los tres estados de conflicto post-aprobación (approved_amount_mismatch/approved_currency_mismatch/approved_stock_conflict) con payment_id -- mismas condiciones que set_order_admin_visibility().';

notify pgrst, 'reload schema';

commit;
