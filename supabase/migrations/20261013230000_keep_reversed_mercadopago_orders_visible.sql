-- Un pedido de Mercado Pago con pago confirmado nunca puede desaparecer de
-- Admin > Pedidos por un cambio posterior de payment_status.
--
-- BUG CONFIRMADO CONTRA LA BASE REAL (pedido BX-1002, 2026-10-13):
-- el pedido se pagó, se canceló y BEYONIX reintegró el pago por Mercado Pago.
-- Segundos después llegó el webhook de MP del reintegro y la rama de
-- "reversa post-confirmación" persistió payment_status='refunded'.
-- set_order_admin_visibility() (20260903160000) sólo conserva la visibilidad
-- con payment_status='approved' o un conflicto post-aprobación; para
-- cualquier otro valor fuerza admin_visible_at := null. Resultado: el pedido
-- quedó fuera del listado y de search_admin_orders (ambos filtran
-- admin_visible_at is not null), aun con "Todos los estados".
-- Lo mismo pasaba con un contracargo ('charged_back') y con un pago real
-- recibido después de cancelar ('approved_after_cancellation').
--
-- CORRECCIÓN (sólo agrega visibilidad; un intento técnico sin pago sigue
-- fuera del panel):
--   * refunded / charged_back con pago ya confirmado (payment_confirmed_at y
--     payment_id) conservan o recuperan su fecha de visibilidad.
--   * approved_after_cancellation con payment_id queda visible (dinero real
--     que requiere resolución), igual que los conflictos post-aprobación.
--   * El constraint acepta exactamente esos casos.
--   * Backfill acotado a esas mismas condiciones.

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
    elsif new.payment_status in ('refunded', 'charged_back')
      and new.payment_confirmed_at is not null
      and new.payment_id is not null then
      -- Reversa notificada por MP sobre un pago que ya se había confirmado:
      -- el pedido es historia real (pago, cancelación, reintegro) y sigue
      -- visible con su fecha original.
      new.admin_visible_at := coalesce(
        new.admin_visible_at,
        new.payment_confirmed_at,
        new.paid_at,
        now()
      );
    elsif new.payment_status in (
        'approved_amount_mismatch',
        'approved_currency_mismatch',
        'approved_stock_conflict',
        'approved_after_cancellation'
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
  'Impide que intentos MP sin pago entren al flujo admin, fija una única fecha al confirmarse el pago, expone los pagos cobrados que quedaron trabados y nunca oculta un pedido confirmado por una reversa posterior (refunded/charged_back).';

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
      payment_status in ('refunded', 'charged_back')
      and payment_confirmed_at is not null
      and payment_id is not null
    )
    or (
      payment_status in (
        'approved_amount_mismatch',
        'approved_currency_mismatch',
        'approved_stock_conflict',
        'approved_after_cancellation'
      )
      and payment_id is not null
    )
  );

comment on constraint ordenes_admin_visibility_payment_check on public.ordenes is
  'admin_visible_at para una orden mercadopago exige: pago approved confirmado; una reversa (refunded/charged_back) de un pago ya confirmado; o un pago cobrado trabado (conflictos post-aprobación o approved_after_cancellation) con payment_id -- mismas condiciones que set_order_admin_visibility().';

-- Backfill: sólo pedidos MP ocultos que cumplen exactamente las condiciones
-- nuevas. El trigger recalcula el valor final con las mismas reglas.
update public.ordenes
set admin_visible_at = coalesce(payment_confirmed_at, paid_at, now())
where payment_method_id = 'mercadopago'
  and admin_visible_at is null
  and payment_id is not null
  and (
    (payment_status in ('refunded', 'charged_back') and payment_confirmed_at is not null)
    or payment_status = 'approved_after_cancellation'
  );

notify pgrst, 'reload schema';

commit;
