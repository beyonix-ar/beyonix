-- Cancelación por Super Admin = cancelación directa de Admin para el circuito
-- financiero. super_admin_cancel_order (20261017110000) audita
-- 'order_force_cancelled_by_super_admin' y nunca 'order_cancelled_refund_pending',
-- así que la NC de cancelación sin reclamo quedaba bloqueada (CLAIM_REQUIRED) y
-- el orquestador caía en conflicto fiscal (modo avanzado / ajuste manual).
-- Una única regla reconoce ambas cancelaciones; begin_partial_credit_note, la
-- ruta de NC y loadFinancialResolution ya la consumen.
-- Queda afuera la cancelación de una venta ya entregada a Andreani
-- (stock retenido hasta el retorno): eso es una devolución, no una NC
-- "antes del despacho", y sigue su propio circuito.
create or replace function public.order_has_admin_direct_cancellation(p_order_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.order_audit_events e
    where e.order_id = p_order_id
      and e.actor_type = 'admin'
      and (
        (e.action = 'order_cancelled_refund_pending'
          and e.metadata->>'source' = 'admin_direct_cancellation')
        or (e.action = 'order_force_cancelled_by_super_admin'
          and e.metadata->>'newEstado' = 'cancelado'
          and coalesce(e.metadata->'stock'->>'dispatchedRetention', 'false') <> 'true')
      )
  )
$$;

revoke all on function public.order_has_admin_direct_cancellation(bigint) from public, anon, authenticated;
grant execute on function public.order_has_admin_direct_cancellation(bigint) to service_role;
