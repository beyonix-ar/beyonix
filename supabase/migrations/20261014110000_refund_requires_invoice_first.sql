-- Ningún camino devuelve dinero de una venta cobrada antes de su Factura C.
--
-- Regla: pago confirmado → Factura C → NC C → mover/devolver dinero.
--
-- HUECO (auditoría de caminos de reintegro, 2026-10-14): con la Factura C
-- todavía pendiente (obligación nacida con el pago, 20261014100000) el pedido
-- tiene credit_note_required=false, así que:
--   * begin_mercadopago_order_refund (refund real de MP, también desde
--     reclamos) no exigía NC y llamaba a Mercado Pago;
--   * commit_order_refund_proof (comprobante manual de Admin, modo avanzado
--     y reclamos) registraba el reintegro "sin NC";
--   * complete_manual_order_financial_refund idem.
-- Una vez facturado, credit_note_required=true y esas RPCs ya exigen la NC
-- (CREDIT_NOTE_REQUIRED / rama con NC): sólo faltaba cubrir la factura.
--
-- CORRECCIÓN (sin copiar ni cambiar las RPCs): un guard BEFORE en las dos
-- tablas donde se registra dinero devuelto. Se dispara dentro de la misma
-- transacción de la RPC, ANTES de que el código llame a Mercado Pago (el
-- intento 'processing' se inserta primero), así que un reintegro bloqueado
-- no mueve nada y puede reintentarse cuando exista la factura (idempotente:
-- no deja filas a medias). Sin pago confirmado nunca hay obligación: el guard
-- no aplica.

begin;

-- Misma definición que hasPendingInvoiceObligation (lib/orders/fiscal-sequencing.ts).
create or replace function public.order_has_pending_invoice_obligation(p_order_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.ordenes o
    where o.id = p_order_id
      and o.invoice_queued_at is not null
      and o.invoice_cae is null
      and coalesce(o.invoice_status, '') <> 'authorized'
      and coalesce(o.total, 0) > 0
  )
$$;

revoke all on function public.order_has_pending_invoice_obligation(bigint) from public, anon, authenticated;
grant execute on function public.order_has_pending_invoice_obligation(bigint) to service_role;

create or replace function public.guard_refund_requires_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Refund de MP: sólo al pasar a 'processing' (antes de llamar a MP). La
  -- conciliación de un intento ya en curso no se bloquea.
  if tg_table_name = 'mercadopago_order_refunds' then
    if new.status is distinct from 'processing'
       or (tg_op = 'UPDATE' and old.status = 'processing') then
      return new;
    end if;
  end if;
  if public.order_has_pending_invoice_obligation(new.order_id) then
    raise exception 'INVOICE_REQUIRED_BEFORE_REFUND';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_refund_requires_invoice() from public, anon, authenticated;

drop trigger if exists ab_guard_mp_refund_requires_invoice on public.mercadopago_order_refunds;
create trigger ab_guard_mp_refund_requires_invoice
  before insert or update of status on public.mercadopago_order_refunds
  for each row execute function public.guard_refund_requires_invoice();

drop trigger if exists ab_guard_refund_proof_requires_invoice on public.order_refund_proofs;
create trigger ab_guard_refund_proof_requires_invoice
  before insert on public.order_refund_proofs
  for each row execute function public.guard_refund_requires_invoice();

notify pgrst, 'reload schema';

commit;
