-- ARCA: facturación automática post-pago confirmado (Factura C, WSFEv1).
--
-- QUÉ EXISTÍA
-- Emisión MANUAL desde Admin (POST /api/admin/orders/[id]/invoice) con
-- begin_arca_invoice_processing (sólo en producción, ver baseline 2026-09-21):
--   * un único pedido en 'processing' a la vez (numeración serializada);
--   * pero si ARCA autorizaba y la respuesta se perdía (timeout, reinicio,
--     fallo al guardar), el pedido quedaba 'error' y el reintento pedía el
--     SIGUIENTE número: dos Facturas C para la misma venta;
--   * un 'processing' colgado (servidor reiniciado) bloqueaba TODA la
--     facturación para siempre;
--   * la función era SECURITY DEFINER sin chequeo de rol y estaba otorgada a
--     anon/authenticated: cualquiera podía marcar pedidos en 'processing'.
--
-- QUÉ AGREGA
-- 1. order_is_invoiceable(): ÚNICA definición de "venta facturable": el
--    stock ya se consumió (inventory_order_consumes_stock, la misma regla del
--    inventario), pago confirmado por BEYONIX (financial_status =
--    'payment_confirmed'), sin cancelación/reintegro/conflicto y total > 0.
-- 2. Trigger zz_queue_arca_invoice: cuando un pedido pasa a facturable queda
--    en invoice_status='pending' (cola). Corre después de todos los guardianes
--    BEFORE (orden alfabético): si la confirmación se rechaza, no se encola.
--    Cubre Mercado Pago, transferencia (automática o manual) y saldo a favor
--    sin tocar ninguno de esos flujos.
-- 3. Máquina de estados fiscal SEPARADA del pago:
--      null        -> no facturable (todavía)
--      pending     -> pendiente de facturación
--      processing  -> facturando (con lease: invoice_processing_started_at)
--      authorized  -> facturada (CAE)
--      error       -> error, se reintenta con backoff (invoice_next_attempt_at)
-- 4. Idempotencia fuerte ante "ARCA autorizó pero no nos enteramos": ANTES de
--    llamar a FECAESolicitar se persiste el número pedido
--    (invoice_requested_*). Todo reintento primero reconcilia contra ARCA
--    (FECompUltimoAutorizado / FECompConsultar) y ADOPTA ese comprobante en
--    vez de pedir otro número. Sólo un rechazo definitivo de ARCA libera el
--    número pedido.
-- 5. Serialización: un solo pedido 'processing' a la vez (lease vencido =
--    reintentable), índice único sobre el número pedido y sobre el
--    comprobante autorizado: dos pedidos nunca comparten número.
-- 6. Seguridad: todo es service_role; begin_arca_invoice_processing se revoca
--    de anon/authenticated.
--
-- No emite notas de crédito: un pedido facturado que luego se cancela queda
-- con credit_note_required=true para el flujo de NC existente.

begin;

alter table public.ordenes
  add column if not exists invoice_voucher_type integer,
  add column if not exists invoice_queued_at timestamptz,
  add column if not exists invoice_attempts integer not null default 0,
  add column if not exists invoice_next_attempt_at timestamptz,
  add column if not exists invoice_processing_started_at timestamptz,
  add column if not exists invoice_last_attempt_at timestamptz,
  add column if not exists invoice_requested_point integer,
  add column if not exists invoice_requested_type integer,
  add column if not exists invoice_requested_number bigint,
  add column if not exists invoice_requested_total numeric(12, 2),
  add column if not exists invoice_requested_date text,
  add column if not exists invoice_requested_at timestamptz;

-- Dos pedidos nunca pueden reservar ni guardar el mismo comprobante.
create unique index if not exists ordenes_invoice_requested_voucher_unique
  on public.ordenes (invoice_requested_point, invoice_requested_type, invoice_requested_number)
  where invoice_requested_number is not null;
-- Si la emisión manual anterior ya dejó un comprobante repetido en dos
-- pedidos, el índice no se puede crear: se informa (hay que revisarlo a mano)
-- sin bloquear el resto de la migración.
do $$
begin
  if exists (
    select 1 from public.ordenes
    where invoice_cae is not null and invoice_number is not null
    group by invoice_point, coalesce(invoice_voucher_type, 11), invoice_number
    having count(*) > 1
  ) then
    raise warning 'ARCA: hay comprobantes autorizados repetidos entre pedidos; no se creó ordenes_invoice_authorized_voucher_unique. Revisar antes de habilitar la facturación automática.';
  else
    create unique index if not exists ordenes_invoice_authorized_voucher_unique
      on public.ordenes (invoice_point, coalesce(invoice_voucher_type, 11), invoice_number)
      where invoice_cae is not null and invoice_number is not null;
  end if;
end;
$$;
-- Cola del worker.
create index if not exists ordenes_invoice_queue_idx
  on public.ordenes (invoice_next_attempt_at, id)
  where invoice_status in ('pending', 'error', 'processing');

create or replace function public.order_is_invoiceable(p_order public.ordenes)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    public.inventory_order_consumes_stock(p_order.estado, p_order.payment_status)
    and coalesce(p_order.estado, '') <> 'cancelado'
    and p_order.financial_status = 'payment_confirmed'
    and p_order.cancelled_at is null
    and p_order.cancellation_requested_at is null
    and coalesce(p_order.payment_status, '') not in (
      'approved_after_cancellation',
      'auto_verified_stock_conflict',
      'approved_stock_conflict',
      'approved_amount_mismatch',
      'approved_currency_mismatch'
    )
    and coalesce(p_order.order_change_status, '') not in ('change_requested', 'extra_payment_pending')
    and coalesce(p_order.total, 0) > 0
$$;

revoke all on function public.order_is_invoiceable(public.ordenes) from public, anon, authenticated;
grant execute on function public.order_is_invoiceable(public.ordenes) to service_role;

create or replace function public.queue_arca_invoice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Ya facturado o con un pedido de CAE en curso/pendiente de reconciliar:
  -- nunca se toca desde acá.
  if new.invoice_cae is not null or new.invoice_status in ('authorized', 'processing')
     or new.invoice_requested_number is not null then
    return new;
  end if;

  if public.order_is_invoiceable(new) then
    -- Sólo la TRANSICIÓN a facturable encola: una venta vieja que ya era
    -- facturable antes de esta migración no se encola por cualquier UPDATE.
    if new.invoice_status is null
       and (tg_op = 'INSERT' or not public.order_is_invoiceable(old)) then
      new.invoice_status := 'pending';
      new.invoice_error := null;
      new.invoice_queued_at := coalesce(new.invoice_queued_at, now());
      new.invoice_next_attempt_at := coalesce(new.invoice_next_attempt_at, now());
    end if;
  elsif new.invoice_status in ('pending', 'error') then
    -- Dejó de ser facturable (cancelación, reintegro, conflicto) antes de
    -- pedir ningún CAE: sale de la cola sin haber emitido nada.
    new.invoice_status := null;
    new.invoice_next_attempt_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.queue_arca_invoice() from public, anon, authenticated;

drop trigger if exists zz_queue_arca_invoice on public.ordenes;
create trigger zz_queue_arca_invoice
  before insert or update on public.ordenes
  for each row execute function public.queue_arca_invoice();

-- Toma un pedido para facturar. p_order_id null = el próximo de la cola.
-- Un solo 'processing' a la vez; un lease vencido se retoma (reconciliando).
create or replace function public.claim_arca_invoice(
  p_order_id bigint default null,
  p_lease interval default interval '10 minutes',
  p_manual boolean default false
)
returns setof public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('beyonix-arca-invoice-processing'));

  if exists (
    select 1 from public.ordenes
    where invoice_status = 'processing'
      and invoice_processing_started_at > v_now - p_lease
      and (p_order_id is null or id <> p_order_id)
  ) then
    if p_manual then raise exception 'INVOICE_PROCESSING_IN_PROGRESS'; end if;
    return;
  end if;

  if p_order_id is not null then
    select * into v_order from public.ordenes where id = p_order_id for update;
    if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  else
    select * into v_order from public.ordenes
    where (invoice_status in ('pending', 'error') and invoice_next_attempt_at <= v_now)
       or (invoice_status = 'processing' and invoice_processing_started_at <= v_now - p_lease)
    order by invoice_next_attempt_at nulls first, id
    limit 1
    for update skip locked;
    if not found then return; end if;
  end if;

  if v_order.invoice_status = 'authorized' and v_order.invoice_cae is not null then
    if p_manual then raise exception 'INVOICE_ALREADY_AUTHORIZED'; end if;
    return;
  end if;
  if v_order.invoice_status = 'processing'
     and v_order.invoice_processing_started_at > v_now - p_lease then
    if p_manual then raise exception 'INVOICE_ALREADY_PROCESSING'; end if;
    return;
  end if;

  -- Sin CAE pedido: sólo una venta facturable. Con un número ya pedido hay
  -- que reconciliar siempre (ARCA pudo haberlo autorizado), aunque el pedido
  -- se haya cancelado después: ese comprobante existe y pide nota de crédito.
  if v_order.invoice_requested_number is null and not public.order_is_invoiceable(v_order) then
    if p_manual then raise exception 'ORDER_NOT_INVOICEABLE'; end if;
    update public.ordenes
    set invoice_status = null, invoice_next_attempt_at = null
    where id = v_order.id and invoice_status in ('pending', 'error');
    return;
  end if;

  update public.ordenes
  set invoice_status = 'processing',
      invoice_processing_started_at = v_now,
      invoice_last_attempt_at = v_now,
      invoice_attempts = coalesce(invoice_attempts, 0) + 1,
      invoice_queued_at = coalesce(invoice_queued_at, v_now)
  where id = v_order.id
  returning * into v_order;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (v_order.id, 'system', 'arca_invoice_attempt_started', null, 'processing',
    jsonb_build_object('attempt', v_order.invoice_attempts, 'manual', p_manual,
      'reconciling', v_order.invoice_requested_number is not null,
      'requestedNumber', v_order.invoice_requested_number));

  return next v_order;
end;
$$;

revoke all on function public.claim_arca_invoice(bigint, interval, boolean) from public, anon, authenticated;
grant execute on function public.claim_arca_invoice(bigint, interval, boolean) to service_role;

-- Persiste el número a pedir ANTES de llamar a FECAESolicitar.
create or replace function public.record_arca_invoice_request(
  p_order_id bigint,
  p_point integer,
  p_type integer,
  p_number bigint,
  p_total numeric,
  p_date text
)
returns public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_point is null or p_point <= 0 or p_type is null or p_number is null or p_number <= 0
     or p_total is null or p_total <= 0 or coalesce(p_date, '') !~ '^\d{8}$' then
    raise exception 'INVALID_INVOICE_REQUEST';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found or v_order.invoice_status is distinct from 'processing' then
    raise exception 'INVOICE_NOT_PROCESSING';
  end if;
  if v_order.invoice_requested_number is not null then
    if v_order.invoice_requested_point = p_point and v_order.invoice_requested_type = p_type
       and v_order.invoice_requested_number = p_number then
      return v_order;
    end if;
    raise exception 'INVOICE_REQUEST_PENDING_RECONCILIATION';
  end if;

  update public.ordenes
  set invoice_requested_point = p_point,
      invoice_requested_type = p_type,
      invoice_requested_number = p_number,
      invoice_requested_total = round(p_total, 2),
      invoice_requested_date = p_date,
      invoice_requested_at = clock_timestamp()
  where id = p_order_id
  returning * into v_order;
  return v_order;
exception
  when unique_violation then
    raise exception 'INVOICE_NUMBER_ALREADY_REQUESTED';
end;
$$;

revoke all on function public.record_arca_invoice_request(bigint, integer, integer, bigint, numeric, text) from public, anon, authenticated;
grant execute on function public.record_arca_invoice_request(bigint, integer, integer, bigint, numeric, text) to service_role;

-- Guarda el CAE. Idempotente: el mismo comprobante devuelve el pedido tal
-- cual; nunca pisa una factura distinta.
create or replace function public.complete_arca_invoice(
  p_order_id bigint,
  p_point integer,
  p_type integer,
  p_number bigint,
  p_cae text,
  p_cae_due date,
  p_issued_at timestamptz,
  p_reconciled boolean default false
)
returns public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_cancellation_flow boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(trim(p_cae), '') = '' or p_cae_due is null or p_number is null then
    raise exception 'INVALID_INVOICE_AUTHORIZATION';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  if v_order.invoice_cae is not null then
    if v_order.invoice_cae = p_cae and v_order.invoice_number = p_number
       and v_order.invoice_point = p_point then
      return v_order;
    end if;
    raise exception 'INVOICE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER';
  end if;
  if v_order.invoice_requested_number is distinct from p_number
     or v_order.invoice_requested_point is distinct from p_point
     or v_order.invoice_requested_type is distinct from p_type then
    raise exception 'INVOICE_AUTHORIZATION_DOES_NOT_MATCH_REQUEST';
  end if;

  v_cancellation_flow := coalesce(v_order.estado, '') = 'cancelado'
    or coalesce(v_order.financial_status, '') in ('cancelled', 'cancellation_requested', 'refund_pending', 'refunded');

  update public.ordenes
  set invoice_status = 'authorized',
      invoice_number = p_number,
      invoice_point = p_point,
      invoice_voucher_type = p_type,
      invoice_cae = p_cae,
      invoice_cae_due = p_cae_due,
      invoice_created_at = coalesce(p_issued_at, clock_timestamp()),
      invoice_error = null,
      invoice_next_attempt_at = null,
      invoice_processing_started_at = null,
      credit_note_required = case when v_cancellation_flow then true else credit_note_required end
  where id = p_order_id
  returning * into v_order;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (p_order_id, 'system', 'arca_invoice_authorized', 'processing', 'authorized',
    jsonb_build_object('point', p_point, 'voucherType', p_type, 'number', p_number,
      'cae', p_cae, 'caeDue', p_cae_due, 'reconciled', p_reconciled,
      'creditNoteRequired', v_cancellation_flow));
  return v_order;
end;
$$;

revoke all on function public.complete_arca_invoice(bigint, integer, integer, bigint, text, date, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.complete_arca_invoice(bigint, integer, integer, bigint, text, date, timestamptz, boolean) to service_role;

-- Registra un intento fallido. p_release_request sólo cuando ARCA RECHAZÓ de
-- forma definitiva el número pedido (o se comprobó que no existe): si la
-- respuesta se perdió, el número queda para reconciliar. p_retry_after null
-- = sin reintento automático (requiere revisión de Admin).
create or replace function public.fail_arca_invoice_attempt(
  p_order_id bigint,
  p_error text,
  p_retry_after interval,
  p_release_request boolean default false
)
returns public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.invoice_status is distinct from 'processing' then
    return v_order;
  end if;

  update public.ordenes
  set invoice_status = 'error',
      invoice_error = left(coalesce(nullif(trim(p_error), ''), 'Error de facturación.'), 1000),
      invoice_next_attempt_at = case when p_retry_after is null then null else clock_timestamp() + p_retry_after end,
      invoice_processing_started_at = null,
      invoice_requested_point = case when p_release_request then null else invoice_requested_point end,
      invoice_requested_type = case when p_release_request then null else invoice_requested_type end,
      invoice_requested_number = case when p_release_request then null else invoice_requested_number end,
      invoice_requested_total = case when p_release_request then null else invoice_requested_total end,
      invoice_requested_date = case when p_release_request then null else invoice_requested_date end,
      invoice_requested_at = case when p_release_request then null else invoice_requested_at end
  where id = p_order_id
  returning * into v_order;

  -- Si dejó de ser facturable y no queda ningún CAE por reconciliar, sale de
  -- la cola (misma regla que el trigger).
  if v_order.invoice_requested_number is null and not public.order_is_invoiceable(v_order) then
    update public.ordenes set invoice_status = null, invoice_next_attempt_at = null
    where id = p_order_id returning * into v_order;
  end if;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (p_order_id, 'system', 'arca_invoice_attempt_failed', 'processing', coalesce(v_order.invoice_status, 'not_invoiceable'),
    jsonb_build_object('error', left(p_error, 1000), 'attempt', v_order.invoice_attempts,
      'requestReleased', p_release_request,
      'pendingReconciliation', v_order.invoice_requested_number,
      'nextAttemptAt', v_order.invoice_next_attempt_at));
  return v_order;
end;
$$;

revoke all on function public.fail_arca_invoice_attempt(bigint, text, interval, boolean) from public, anon, authenticated;
grant execute on function public.fail_arca_invoice_attempt(bigint, text, interval, boolean) to service_role;

-- Seguridad: la RPC heredada de emisión manual (sin chequeo de rol) ya no se
-- usa desde la app y no puede quedar expuesta a anon/authenticated.
do $$
begin
  if to_regprocedure('public.begin_arca_invoice_processing(bigint)') is not null then
    execute 'revoke all on function public.begin_arca_invoice_processing(bigint) from public, anon, authenticated';
    execute 'grant execute on function public.begin_arca_invoice_processing(bigint) to service_role';
  end if;
end;
$$;

-- Ventas confirmadas ANTES de esta migración y sin factura: NO se encolan
-- solas (emitir de golpe comprobantes de ventas viejas es una decisión del
-- negocio). Siguen en "Facturación pendiente" de Admin para emitirlas a mano
-- con el mismo servicio idempotente. Sólo las confirmaciones posteriores
-- entran automáticamente por el trigger.

notify pgrst, 'reload schema';

commit;
