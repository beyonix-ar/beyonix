-- Órdenes con pago APROBADO que no se pudieron confirmar deben verse en Admin.
--
-- `set_order_admin_visibility` (20260815150000) fuerza admin_visible_at = null
-- para cualquier orden de Mercado Pago que no esté confirmada. La intención es
-- correcta -- que los intentos técnicos de checkout no contaminen el panel --
-- pero deja fuera tres casos donde Mercado Pago SÍ cobró y la orden quedó
-- trabada esperando una decisión humana:
--
--   approved_amount_mismatch    el monto pagado no coincide con el esperado
--   approved_currency_mismatch  moneda distinta de ARS
--   approved_stock_conflict     el inventario ya no permite confirmar la orden
--                               (la reserva venció y otra compra se llevó las
--                               unidades)
--
-- En los tres hay dinero real del cliente y nadie los veía. Esta migración
-- sólo AGREGA visibilidad: ninguna orden que hoy se ve deja de verse, y un
-- intento sin pago sigue sin entrar al panel.

begin;

create or replace function public.set_order_admin_visibility()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.payment_method_id = 'mercadopago' then
    if new.payment_status = 'approved'
       and new.financial_status in (
         'payment_confirmed',
         'cancellation_requested',
         'refund_pending',
         'refunded'
       )
       and new.payment_confirmed_at is not null
       and new.payment_id is not null then
      new.admin_visible_at := coalesce(
        new.admin_visible_at,
        new.payment_confirmed_at,
        new.paid_at,
        now()
      );
    elsif new.payment_status in (
        'approved_amount_mismatch',
        'approved_currency_mismatch',
        'approved_stock_conflict'
      )
      and new.payment_id is not null then
      -- Pago cobrado que no pudo confirmarse: requiere resolución manual, así
      -- que tiene que estar visible aunque no llegue a payment_confirmed.
      new.admin_visible_at := coalesce(new.admin_visible_at, now());
    else
      new.admin_visible_at := null;
    end if;
  else
    new.admin_visible_at := coalesce(
      new.admin_visible_at,
      new.created_at,
      now()
    );
  end if;

  return new;
end;
$$;

revoke all on function public.set_order_admin_visibility() from public;

comment on function public.set_order_admin_visibility() is
  'Impide que intentos MP pendientes entren al flujo admin, fija una única fecha al confirmarse el pago y expone los pagos aprobados que quedaron trabados (monto, moneda o inventario) para resolución manual.';

commit;
