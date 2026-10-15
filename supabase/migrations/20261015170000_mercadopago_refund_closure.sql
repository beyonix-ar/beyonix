-- Cierre del circuito de reintegros de Mercado Pago.
--
-- 1. Incidentes de pago idempotentes. El webhook compara los refunds que
--    informa MP contra los que registró BEYONIX (también con el pago todavía
--    en "approved": un reintegro externo PARCIAL no cambia payment.status) y
--    alerta cada refund desconocido por su importe. Cada alerta lleva una
--    clave estable (incidentKey: id del refund en MP, o pago+importe si MP no
--    trae detalle): webhooks repetidos, reintentos o dos instancias a la vez
--    nunca duplican la alerta. Los eventos previos (sin clave) no cambian.
--
-- 2. Intentos 'processing' colgados. La conciliación por lote sólo tomaba
--    'needs_reconciliation': un intento que quedó en 'processing' (proceso
--    caído entre el POST a MP y el guardado, o fallo al persistir la
--    respuesta) no se recuperaba nunca solo. Ahora entra en la cola pasado un
--    umbral (el POST de MP tiene timeout de segundos). La conciliación es
--    siempre un GET: nunca repite el POST.
--
-- 3. Liquidación NC ↔ reintegro MP por orden. Antes era todo-o-nada: si los
--    refunds cubrían la primera NC pero no la segunda, ninguna se liquidaba.
--    Ahora se liquidan en orden de autorización mientras el dinero confirmado
--    (no usado ya por otra NC) cubra cada una completa. Una NC nunca se
--    liquida con dinero insuficiente y el mismo dinero nunca liquida dos NC.

begin;

-- 1. Incidentes de pago --------------------------------------------------

create unique index if not exists order_audit_events_payment_incident_key_idx
  on public.order_audit_events ((metadata->>'incidentKey'))
  where action in ('mp_external_refund_detected', 'mp_chargeback_detected')
    and metadata ? 'incidentKey';

create or replace function public.record_mercadopago_payment_incident(
  p_order_id bigint,
  p_action text,
  p_incident_key text,
  p_metadata jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_id bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN';
  end if;
  if p_action not in ('mp_external_refund_detected', 'mp_chargeback_detected') then
    raise exception 'NOT_A_PAYMENT_INCIDENT';
  end if;
  if length(btrim(coalesce(p_incident_key, ''))) = 0 then
    raise exception 'INCIDENT_KEY_REQUIRED';
  end if;

  select coalesce(financial_status, 'payment_confirmed') into v_status
  from public.ordenes where id = p_order_id;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (
    p_order_id, 'system', p_action, v_status, v_status,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('incidentKey', p_incident_key)
  )
  on conflict ((metadata->>'incidentKey'))
    where action in ('mp_external_refund_detected', 'mp_chargeback_detected') and metadata ? 'incidentKey'
  do nothing
  returning id into v_id;

  return v_id is not null;
end;
$$;

revoke all on function public.record_mercadopago_payment_incident(bigint, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_mercadopago_payment_incident(bigint, text, text, jsonb) to service_role;

comment on function public.record_mercadopago_payment_incident(bigint, text, text, jsonb) is
  'Registra un incidente de pago (reintegro externo / contracargo) una sola vez por incidentKey. Devuelve false si ya existía.';

-- 2. Conciliación de intentos colgados ----------------------------------

create or replace function public.claim_mercadopago_refunds_for_reconciliation(
  p_batch_size integer default 10,
  p_lock_timeout_seconds integer default 300
)
returns setof public.mercadopago_order_refunds
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  return query
  update public.mercadopago_order_refunds
  set reconciliation_locked_at = now()
  where id in (
    select id
    from public.mercadopago_order_refunds
    where (
        status = 'needs_reconciliation'
        -- NUEVO: un 'processing' sin novedades hace 10 minutos ya no es un
        -- POST en vuelo (timeout de 15 s): su resultado se consulta por GET.
        or (status = 'processing' and updated_at < now() - interval '10 minutes')
      )
      and (
        reconciliation_locked_at is null
        or reconciliation_locked_at < now() - make_interval(secs => greatest(p_lock_timeout_seconds, 1))
      )
    order by updated_at asc
    limit greatest(least(coalesce(p_batch_size, 10), 50), 1)
    for update skip locked
  )
  returning *;
end;
$$;

revoke all on function public.claim_mercadopago_refunds_for_reconciliation(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_mercadopago_refunds_for_reconciliation(integer, integer) to service_role;

create index if not exists mercadopago_order_refunds_stale_processing_idx
  on public.mercadopago_order_refunds (updated_at)
  where status = 'processing';

-- 3. Liquidación NC ↔ reintegro MP --------------------------------------

create or replace function public.settle_credit_notes_after_mercadopago_refund(p_order_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available_cents bigint;
  v_note_cents bigint;
  v_reference text;
  v_settled integer := 0;
  v_note record;
begin
  -- Serializa con la reserva/finalización de NC del mismo pedido.
  perform pg_advisory_xact_lock(91091, p_order_id::integer);

  select
    coalesce(sum(round(amount * 100)), 0)::bigint,
    'mp_refund:' || coalesce(string_agg(coalesce(mp_refund_id, id::text), ',' order by completed_at, id), '')
  into v_available_cents, v_reference
  from public.mercadopago_order_refunds
  where order_id = p_order_id
    and status = 'confirmed';

  if v_available_cents <= 0 then
    return 0;
  end if;

  -- El mismo dinero no liquida dos veces.
  v_available_cents := v_available_cents - (
    select coalesce(sum(round(coalesce(external_amount, total_amount) * 100)), 0)::bigint
    from public.order_credit_notes
    where order_id = p_order_id
      and status = 'authorized'
      and destination = 'external_refund'
      and settlement_status = 'completado'
      and settlement_reference like 'mp_refund:%'
  );

  -- En orden de autorización; se detiene en la primera NC que el dinero
  -- disponible no cubre completa (nunca se liquida con dinero insuficiente).
  for v_note in
    select id, total_amount, external_amount
    from public.order_credit_notes
    where order_id = p_order_id
      and status = 'authorized'
      and destination = 'external_refund'
      and settlement_status is distinct from 'completado'
    order by authorized_at nulls last, created_at, id
    for update
  loop
    v_note_cents := round(coalesce(v_note.external_amount, v_note.total_amount) * 100)::bigint;
    exit when v_note_cents > v_available_cents;
    v_available_cents := v_available_cents - v_note_cents;

    update public.order_credit_notes
    set
      management_status = 'finalizada',
      settlement_status = 'completado',
      settlement_date = coalesce(settlement_date, (now() at time zone 'America/Argentina/Buenos_Aires')::date),
      settlement_reference = coalesce(settlement_reference, left(v_reference, 200)),
      updated_at = now()
    where id = v_note.id;

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
        'amount', v_note_cents / 100.0,
        'reference', left(v_reference, 200)
      )
    );
  end loop;

  return v_settled;
end;
$$;

revoke all on function public.settle_credit_notes_after_mercadopago_refund(bigint) from public, anon, authenticated;
grant execute on function public.settle_credit_notes_after_mercadopago_refund(bigint) to service_role;

notify pgrst, 'reload schema';

commit;
