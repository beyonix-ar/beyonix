-- Cierra una condición de carrera (TOCTOU) entre la validación del importe
-- acreditable restante de un pedido y la escritura de
-- ordenes.credit_note_amount desde el flujo de reclamos
-- (app/api/admin/order-claims/[claimId]/route.ts,
-- markOrderCreditNoteRequired). Antes, la ruta leía el remanente
-- (lib/orders/credit-note-remaining.ts), lo validaba en TypeScript y recién
-- después escribía credit_note_amount con un UPDATE simple: entre la
-- lectura y la escritura, otra nota de crédito podía pasar a
-- authorized/processing y dejar guardado un importe mayor al remanente
-- real.
--
-- Esta RPC hace la lectura, el cálculo del remanente y la escritura en una
-- sola transacción, bajo el mismo advisory lock por pedido
-- (pg_advisory_xact_lock(91091, order_id)) que ya usa
-- begin_partial_credit_note (20260729181538_formalize_partial_credit_notes.sql)
-- para reservar notas de crédito parciales. Es el mismo mecanismo de
-- exclusión, no uno paralelo: begin_partial_credit_note y esta función se
-- serializan entre sí para el mismo pedido, así que un cambio en
-- order_credit_notes disparado por una nunca queda invisible para la otra.
create or replace function public.set_pending_credit_note_amount(
  p_order_id bigint,
  p_credit_note_amount numeric
)
returns table (
  order_id bigint,
  credit_note_amount numeric,
  remaining_creditable_amount numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_committed numeric(12, 2);
  v_remaining numeric(12, 2);
  v_amount numeric(12, 2) := round(coalesce(p_credit_note_amount, 0), 2);
begin
  perform pg_advisory_xact_lock(91091, p_order_id::integer);

  select *
    into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_amount <= 0 then
    raise exception 'INVALID_CREDIT_NOTE_AMOUNT';
  end if;

  select coalesce(sum(total_amount), 0)
    into v_committed
  from public.order_credit_notes
  where order_id = p_order_id
    and status in ('processing', 'authorized');

  v_remaining := greatest(0, round(coalesce(v_order.total, 0) - v_committed, 2));

  if v_amount > v_remaining + 0.005 then
    raise exception 'CREDIT_NOTE_EXCEEDS_REMAINING';
  end if;

  -- Mismo comportamiento que el UPDATE original (.is("credit_note_cae",
  -- null)): si la orden ya tiene una nota de crédito facturada, no se pisa
  -- el importe; se devuelve sin error para no romper el flujo del wizard.
  if v_order.credit_note_cae is not null then
    return query select v_order.id, v_order.credit_note_amount, v_remaining;
    return;
  end if;

  update public.ordenes
  set credit_note_required = true,
      credit_note_status = 'pending',
      credit_note_amount = v_amount
  where id = p_order_id;

  return query select p_order_id, v_amount, v_remaining;
end;
$$;

revoke all on function public.set_pending_credit_note_amount(bigint, numeric)
  from public, anon, authenticated;

grant execute on function public.set_pending_credit_note_amount(bigint, numeric)
  to service_role;
