-- Cancelación automática (NC C + reintegro), causa de BX-1005:
--   1. la reserva de la NC del worker siempre fallaba (ver la sobrecarga con
--      snapshot de begin_partial_credit_note, abajo);
--   2. la antigüedad de la compra no debe bloquear la toma.
--
-- Antes: sólo se tomaban pedidos cuya Factura C se encoló DESPUÉS del último
-- corte del control automático (invoice_queued_at > cutoff_at). Una compra de
-- ayer quedaba fuera para siempre si el control se reactivaba hoy, aunque la
-- cancelación ocurriera con el automático encendido.
--
-- Ahora: entra si la venta o su cancelación son posteriores al corte. El
-- corte sigue protegiendo el backlog histórico (ventas y cancelaciones
-- anteriores a la activación quedan para Admin), el kill switch sigue igual y
-- el lease vencido se retoma como antes. Misma firma y mismos permisos.

create or replace function public.claim_auto_cancellation(p_lease interval default interval '5 minutes')
returns setof public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare v_order public.ordenes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN'; end if;
  select * into v_order from public.ordenes o
  where o.estado = 'cancelado' and o.financial_status = 'refund_pending'
    and o.invoice_status = 'authorized' and o.invoice_cae is not null
    and o.invoice_queued_at is not null
    and exists (select 1 from public.arca_auto_invoicing_control c
      where c.id = true and c.enabled = true
        and greatest(o.invoice_queued_at, o.cancellation_requested_at, o.cancelled_at, o.refund_pending_at) > c.cutoff_at)
    and o.auto_cancellation_next_attempt_at <= clock_timestamp()
    and (o.auto_cancellation_claimed_until is null or o.auto_cancellation_claimed_until <= clock_timestamp())
  order by o.auto_cancellation_next_attempt_at, o.id
  limit 1 for update of o skip locked;
  if not found then return; end if;
  update public.ordenes set auto_cancellation_claimed_until = clock_timestamp() + p_lease,
    auto_cancellation_attempts = auto_cancellation_attempts + 1
  where id = v_order.id returning * into v_order;
  return next v_order;
end $$;

revoke all on function public.claim_auto_cancellation(interval) from public, anon, authenticated;
grant execute on function public.claim_auto_cancellation(interval) to service_role;

-- La sobrecarga con snapshot (p_expected_note_ids), que es la que usa el
-- worker, exigía un perfil Admin: con p_created_by NULL (identidad del
-- worker desde 20261014140000) fallaba siempre con CREDIT_NOTE_ACTOR_FORBIDDEN,
-- así que ninguna NC automática podía reservarse. Ahora acepta NULL sólo para
-- la cancelación antes del despacho; la versión canónica sigue validando
-- destino y elegibilidad (AUTO_CREDIT_NOTE_NOT_ELIGIBLE). El resto, igual.
create or replace function public.begin_partial_credit_note(
  p_order_id bigint, p_claim_id bigint, p_destination text, p_reason text, p_items_amount numeric,
  p_manual_amount numeric, p_total_amount numeric, p_invoice_point integer, p_invoice_number bigint,
  p_created_by uuid, p_items jsonb, p_operation_type text, p_expected_note_ids uuid[])
returns public.order_credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare v_ids uuid[]; v_note public.order_credit_notes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CREDIT_NOTE_ACTOR_FORBIDDEN'; end if;
  if p_created_by is null then
    if p_operation_type is distinct from 'cancelacion_antes_despacho' then raise exception 'CREDIT_NOTE_ACTOR_FORBIDDEN'; end if;
  elsif not exists(select 1 from public.profiles where id=p_created_by and rol in ('admin','super_admin')) then
    raise exception 'CREDIT_NOTE_ACTOR_FORBIDDEN';
  end if;
  perform pg_advisory_xact_lock(91091,p_order_id::integer);
  perform id from public.ordenes where id=p_order_id for update;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into v_ids from public.order_credit_notes where order_id=p_order_id and status in ('processing','authorized');
  if p_expected_note_ids is null or v_ids is distinct from (select coalesce(array_agg(x order by x),'{}'::uuid[]) from unnest(p_expected_note_ids) x) then raise exception 'CREDIT_NOTE_SNAPSHOT_CONFLICT'; end if;
  -- El motor canónico conserva importes, elegibilidad, cantidades y permisos.
  select * into v_note from public.begin_partial_credit_note(p_order_id,p_claim_id,p_destination,p_reason,p_items_amount,p_manual_amount,p_total_amount,p_invoice_point,p_invoice_number,p_created_by,p_items,p_operation_type);
  return v_note;
end $$;

revoke all on function public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text,uuid[]) from public, anon, authenticated;
grant execute on function public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text,uuid[]) to service_role;
