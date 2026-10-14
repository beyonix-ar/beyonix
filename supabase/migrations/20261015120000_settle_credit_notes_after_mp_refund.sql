-- Una NC con destino "reintegro externo" queda liquidada cuando Mercado Pago
-- confirma el reintegro del pedido. Antes sólo se liquidaba con un comprobante
-- de transferencia (commit_order_refund_proof): un pedido reintegrado por MP
-- quedaba con su NC en settlement_status = 'pendiente' para siempre.
--
-- Se dispara desde mercadopago_order_refunds (fuente de verdad del refund),
-- así cubre la respuesta del POST, la reconciliación y el webhook. Nunca
-- cambia importes, nunca crea otra NC y nunca inicia otro reintegro: sólo
-- cierra la liquidación de NCs ya autorizadas.
--
-- Esta migración NO toca datos existentes: para cerrar una NC ya reintegrada
-- antes de esta migración se usa settle_credit_notes_after_mercadopago_refund
-- de forma explícita.

create or replace function public.settle_credit_notes_after_mercadopago_refund(p_order_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_confirmed_cents bigint;
  v_pending_cents bigint;
  v_reference text;
  v_settled integer := 0;
  v_note record;
begin
  -- Serializa con la reserva/finalización de NC del mismo pedido.
  perform pg_advisory_xact_lock(91091, p_order_id::integer);

  select
    coalesce(sum(round(amount * 100)), 0)::bigint,
    'mp_refund:' || coalesce(string_agg(coalesce(mp_refund_id, id::text), ',' order by completed_at, id), '')
  into v_confirmed_cents, v_reference
  from public.mercadopago_order_refunds
  where order_id = p_order_id
    and status = 'confirmed';

  if v_confirmed_cents <= 0 then
    return 0;
  end if;

  -- El mismo dinero no liquida dos veces: se descuenta lo que reintegros MP
  -- ya liquidaron en NC anteriores del pedido.
  v_confirmed_cents := v_confirmed_cents - (
    select coalesce(sum(round(coalesce(external_amount, total_amount) * 100)), 0)::bigint
    from public.order_credit_notes
    where order_id = p_order_id
      and status = 'authorized'
      and destination = 'external_refund'
      and settlement_status = 'completado'
      and settlement_reference like 'mp_refund:%'
  );

  select coalesce(sum(round(coalesce(external_amount, total_amount) * 100)), 0)::bigint
  into v_pending_cents
  from public.order_credit_notes
  where order_id = p_order_id
    and status = 'authorized'
    and destination = 'external_refund'
    and settlement_status is distinct from 'completado';

  -- Un reintegro parcial que no cubre el dinero de las NC pendientes no las
  -- liquida: lo que falta devolver sigue visible como pendiente.
  if v_pending_cents = 0 or v_confirmed_cents < v_pending_cents then
    return 0;
  end if;

  for v_note in
    update public.order_credit_notes
    set
      management_status = 'finalizada',
      settlement_status = 'completado',
      settlement_date = coalesce(settlement_date, (now() at time zone 'America/Argentina/Buenos_Aires')::date),
      settlement_reference = coalesce(settlement_reference, left(v_reference, 200)),
      updated_at = now()
    where order_id = p_order_id
      and status = 'authorized'
      and destination = 'external_refund'
      and settlement_status is distinct from 'completado'
    returning id, total_amount, external_amount
  loop
    v_settled := v_settled + 1;
    insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
    values (
      p_order_id,
      'system',
      'credit_note_settled_by_mp_refund',
      'pendiente',
      'completado',
      jsonb_build_object(
        'orderCreditNoteId', v_note.id,
        'amount', coalesce(v_note.external_amount, v_note.total_amount),
        'reference', left(v_reference, 200)
      )
    );
  end loop;

  return v_settled;
end;
$$;

revoke all on function public.settle_credit_notes_after_mercadopago_refund(bigint) from public, anon, authenticated;
grant execute on function public.settle_credit_notes_after_mercadopago_refund(bigint) to service_role;

create or replace function public.settle_credit_notes_on_mercadopago_refund_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.settle_credit_notes_after_mercadopago_refund(new.order_id);
  return new;
end;
$$;

revoke all on function public.settle_credit_notes_on_mercadopago_refund_confirmed() from public, anon, authenticated;

drop trigger if exists settle_credit_notes_on_mp_refund_confirmed_insert on public.mercadopago_order_refunds;
create trigger settle_credit_notes_on_mp_refund_confirmed_insert
after insert on public.mercadopago_order_refunds
for each row
when (new.status = 'confirmed')
execute function public.settle_credit_notes_on_mercadopago_refund_confirmed();

drop trigger if exists settle_credit_notes_on_mp_refund_confirmed_update on public.mercadopago_order_refunds;
create trigger settle_credit_notes_on_mp_refund_confirmed_update
after update of status on public.mercadopago_order_refunds
for each row
when (new.status = 'confirmed' and old.status is distinct from 'confirmed')
execute function public.settle_credit_notes_on_mercadopago_refund_confirmed();

-- Caso inverso: la NC estaba procesándose en ARCA cuando MP confirmó el
-- reintegro y se autoriza después. Sólo reacciona al cambio de status (la
-- liquidación no toca status, así que no hay recursión).
create or replace function public.settle_credit_notes_on_credit_note_authorized()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.destination = 'external_refund' then
    perform public.settle_credit_notes_after_mercadopago_refund(new.order_id);
  end if;
  return new;
end;
$$;

revoke all on function public.settle_credit_notes_on_credit_note_authorized() from public, anon, authenticated;

drop trigger if exists settle_credit_notes_on_credit_note_authorized on public.order_credit_notes;
create trigger settle_credit_notes_on_credit_note_authorized
after update of status on public.order_credit_notes
for each row
when (new.status = 'authorized' and old.status is distinct from 'authorized')
execute function public.settle_credit_notes_on_credit_note_authorized();

comment on function public.settle_credit_notes_after_mercadopago_refund(bigint) is
  'Liquida (settlement completado) las NC de reintegro externo autorizadas cuando los refunds MP confirmados cubren su importe. Idempotente; no cambia importes.';
