-- Política: desde el PRIMER pickeo válido, una cancelación pasa a gestión
-- financiera manual y queda así para siempre. Corrige 20261016110000, que
-- volvía a habilitar el automático al resolver la retención física.
--
-- Marca durable: la fila de order_cancellation_holds (FK restrict, nunca se
-- borra). Activa = "requiere resolución física"; resuelta = "mercadería
-- recuperada, reintegro manual requerido". El escaneo de retiro confirma sólo
-- recuperación física, stock y salida del circuito de despacho: NO autoriza
-- dinero automático.
--
-- Se reutiliza la política existente de corte de preparación
-- (order_was_prepared_for_dispatch: lote cerrado ⇒ sólo reintegro manual): el
-- corte ahora también nace con el pickeo. Así, sin caminos nuevos:
--   * reserve_order_financial_resolution sólo admite 'manual_refund';
--   * guard_claim_mercadopago_refund rechaza el refund MP (REFUND_PREPARED_BATCH);
--   * claim_auto_cancellation (worker) nunca toma el pedido;
--   * la NC automática del worker (p_created_by NULL) se rechaza.
-- El circuito fiscal no cambia: Factura C → NC C (emitida por Admin) →
-- reintegro registrado por Admin; el saldo usado vuelve con la NC autorizada.

begin;

create or replace function public.order_cancelled_after_picking(p_order_id bigint)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.order_cancellation_holds h where h.order_id = p_order_id)
$$;
revoke all on function public.order_cancelled_after_picking(bigint) from public, anon, authenticated;
grant execute on function public.order_cancelled_after_picking(bigint) to service_role;

-- Definición original (20261005130000) + cancelación con pickeo. Se quita la
-- excepción de 20261016110000 (retiro por escaneo ya no levanta el corte).
create or replace function public.order_was_prepared_for_dispatch(p_order_id bigint)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1 from public.dispatch_batch_items i
    join public.dispatch_batches b on b.id=i.batch_id
    where i.order_id=p_order_id and b.prepared_at is not null
      and (i.removed_at is null or i.removed_at >= b.closed_at)
  ) or public.order_cancelled_after_picking(p_order_id);
$$;
revoke all on function public.order_was_prepared_for_dispatch(bigint) from public,anon,authenticated;
grant execute on function public.order_was_prepared_for_dispatch(bigint) to service_role;

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
    -- Gestión manual: cancelación con pickeo (retención activa o resuelta),
    -- pedido todavía en un lote o corte de lote cerrado.
    and not exists (select 1 from public.order_cancellation_holds h where h.order_id = o.id)
    and not exists (select 1 from public.dispatch_batch_items i
      where i.order_id = o.id and i.removed_at is null)
    and not public.order_was_prepared_for_dispatch(o.id)
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

-- NC automática (identidad NULL del worker): igual que 20261015190000 más el
-- rechazo explícito con corte de preparación. La NC emitida por Admin sigue.
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
    if public.order_was_prepared_for_dispatch(p_order_id) then raise exception 'AUTO_CREDIT_NOTE_MANUAL_REQUIRED'; end if;
  elsif not exists(select 1 from public.profiles where id=p_created_by and rol in ('admin','super_admin')) then
    raise exception 'CREDIT_NOTE_ACTOR_FORBIDDEN';
  end if;
  perform pg_advisory_xact_lock(91091,p_order_id::integer);
  perform id from public.ordenes where id=p_order_id for update;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into v_ids from public.order_credit_notes where order_id=p_order_id and status in ('processing','authorized');
  if p_expected_note_ids is null or v_ids is distinct from (select coalesce(array_agg(x order by x),'{}'::uuid[]) from unnest(p_expected_note_ids) x) then raise exception 'CREDIT_NOTE_SNAPSHOT_CONFLICT'; end if;
  select * into v_note from public.begin_partial_credit_note(p_order_id,p_claim_id,p_destination,p_reason,p_items_amount,p_manual_amount,p_total_amount,p_invoice_point,p_invoice_number,p_created_by,p_items,p_operation_type);
  return v_note;
end $$;
revoke all on function public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text,uuid[]) from public, anon, authenticated;
grant execute on function public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text,uuid[]) to service_role;

notify pgrst, 'reload schema';

commit;
