-- Guardas definitivas de la obligación fiscal.
--
-- 1. Una vez que nace la obligación de Factura C (invoice_queued_at, al
--    confirmarse el pago) no puede desaparecer por ningún camino: cancelación,
--    reintegro, error de ARCA, reintento o un UPDATE manual. Hoy ningún código
--    la borra; esto lo vuelve imposible.
-- 2. Un CAE nunca se reemplaza: ni el de la factura ni el de una NC. Una NC
--    autorizada nunca vuelve a otro estado.
-- 3. order_requires_invoice excluía las ventas con un cambio de pedido en
--    curso también cuando ya estaban canceladas: la obligación quedaba fuera
--    de la cola (invoice_status NULL), la emisión manual respondía
--    ORDER_NOT_INVOICEABLE y el reintegro quedaba bloqueado para siempre por
--    INVOICE_REQUIRED_BEFORE_REFUND. Cancelada la venta, el cambio ya no puede
--    completarse: la obligación nacida con el pago manda.

begin;

create or replace function public.guard_fiscal_obligation_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.invoice_queued_at is not null and new.invoice_queued_at is null then
    raise exception 'INVOICE_OBLIGATION_IMMUTABLE';
  end if;
  if old.invoice_cae is not null and new.invoice_cae is distinct from old.invoice_cae then
    raise exception 'INVOICE_CAE_IMMUTABLE';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_fiscal_obligation_immutable() from public, anon, authenticated;

drop trigger if exists aa_guard_fiscal_obligation_immutable on public.ordenes;
create trigger aa_guard_fiscal_obligation_immutable
  before update of invoice_queued_at, invoice_cae on public.ordenes
  for each row execute function public.guard_fiscal_obligation_immutable();

create or replace function public.guard_credit_note_cae_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.cae is not null and new.cae is distinct from old.cae then
    raise exception 'CREDIT_NOTE_CAE_IMMUTABLE';
  end if;
  if old.status = 'authorized' and new.status is distinct from 'authorized' then
    raise exception 'CREDIT_NOTE_AUTHORIZED_IMMUTABLE';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_credit_note_cae_immutable() from public, anon, authenticated;

drop trigger if exists aa_guard_credit_note_cae_immutable on public.order_credit_notes;
create trigger aa_guard_credit_note_cae_immutable
  before update of cae, status on public.order_credit_notes
  for each row execute function public.guard_credit_note_cae_immutable();

create or replace function public.order_requires_invoice(p_order public.ordenes)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    public.order_is_invoiceable(p_order)
    or (
      p_order.invoice_queued_at is not null
      and coalesce(p_order.total, 0) > 0
      and (
        -- NUEVO: venta cancelada/reintegrada → la obligación sigue aunque
        -- hubiera un cambio de pedido pendiente (ya no puede completarse).
        coalesce(p_order.estado, '') = 'cancelado'
        or p_order.cancelled_at is not null
        or coalesce(p_order.financial_status, '') in ('refund_pending', 'refunded', 'cancelled')
        or coalesce(p_order.payment_status, '') in ('refunded', 'charged_back')
        or (
          coalesce(p_order.order_change_status, '') not in ('change_requested', 'extra_payment_pending')
          and (
            p_order.cancellation_requested_at is not null
            or coalesce(p_order.financial_status, '') = 'cancellation_requested'
          )
        )
      )
    )
$$;

-- 4. Saldo de una venta con obligación fiscal: vuelve sólo por NC.
--    Admin → Saldo → "Reversar movimiento" podía revertir el débito de saldo
--    de una compra facturada (o por facturar) sin NC; después la NC de la
--    cancelación lo habría restaurado otra vez. Toda acreditación ligada a
--    una venta con obligación fiscal debe venir de una NC: la acreditación
--    a saldo de la NC (source_type 'credit_note') o la restauración del saldo
--    usado (source_key 'credit-note:%'). Débitos y movimientos sin pedido no
--    cambian; las ventas sin obligación (pago nunca confirmado) tampoco.
create or replace function public.guard_order_credit_requires_credit_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.order_id is not null
     and public.customer_credit_movement_effect(new.movement_type) > 0
     and new.source_type is distinct from 'credit_note'
     and coalesce(new.source_key, '') not like 'credit-note:%'
     and public.order_customer_credit_reversal_on_hold(new.order_id) then
    raise exception 'CREDIT_NOTE_REQUIRED_BEFORE_REFUND';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_order_credit_requires_credit_note() from public, anon, authenticated;

drop trigger if exists aa_guard_order_credit_requires_credit_note on public.customer_credit_movements;
create trigger aa_guard_order_credit_requires_credit_note
  before insert on public.customer_credit_movements
  for each row execute function public.guard_order_credit_requires_credit_note();

notify pgrst, 'reload schema';

commit;
