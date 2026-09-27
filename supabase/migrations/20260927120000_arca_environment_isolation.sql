-- ARCA: aislamiento entre homologación y producción.
--
-- PROBLEMA
-- Facturas C (ordenes.invoice_*) y Notas de Crédito C (order_credit_notes)
-- se guardaban por punto de venta + tipo + número, sin ambiente. ARCA numera
-- cada ambiente por separado: el comprobante 1-73 de homologación y el 1-73
-- de producción son distintos. Con los índices únicos anteriores:
--   * la numeración real de producción chocaría contra los comprobantes de
--     prueba ya guardados (pedidos 11 y 12: Facturas C 1-73 y 1-74 de
--     homologación);
--   * nada distinguía un CAE de prueba de uno fiscal real;
--   * una conciliación podía consultar en un ambiente un número pedido en el
--     otro.
--
-- QUÉ AGREGA
-- 1. ordenes.invoice_arca_environment y order_credit_notes.arca_environment
--    ('homologation' | 'production'). Se fija al registrar el número pedido
--    (antes de FECAESolicitar), con el ambiente REAL del gateway (ARCA_ENV), y
--    se exige igual al guardar el CAE. Un número liberado lo limpia.
-- 2. Obligatorio siempre que haya número pedido o comprobante autorizado.
-- 3. Índices únicos por ambiente + punto + tipo + número: el mismo número
--    puede existir una vez en cada ambiente; dos veces en el mismo, nunca.
-- 4. Una NC sólo puede pedirse en el ambiente de su Factura C asociada
--    (CREDIT_NOTE_ENVIRONMENT_MISMATCH): producción nunca emite una NC real
--    sobre una factura de prueba, ni al revés.
-- 5. Las RPCs de registro/cierre cambian de firma (p_environment
--    obligatorio); las firmas anteriores se eliminan para que ningún código
--    viejo pueda registrar un comprobante sin ambiente. Todo sigue siendo
--    service_role.
--
-- DATOS EXISTENTES
-- Todo comprobante guardado hasta hoy se emitió en HOMOLOGACIÓN: la
-- aplicación sólo usa producción con ARCA_ENV=production explícito, el
-- certificado configurado es de la CA "Computadores Test" y los CAE de los
-- pedidos 11/12 coinciden con los comprobantes 1-73/1-74 que devuelve
-- FECompConsultar en homologación. Se marcan 'homologation'; no se borra ni
-- se modifica ningún otro dato.

begin;

alter table public.ordenes
  add column if not exists invoice_arca_environment text;
alter table public.order_credit_notes
  add column if not exists arca_environment text;

alter table public.ordenes
  drop constraint if exists ordenes_invoice_arca_environment_check;
alter table public.ordenes
  add constraint ordenes_invoice_arca_environment_check
  check (invoice_arca_environment is null or invoice_arca_environment in ('homologation', 'production'));
alter table public.order_credit_notes
  drop constraint if exists order_credit_notes_arca_environment_check;
alter table public.order_credit_notes
  add constraint order_credit_notes_arca_environment_check
  check (arca_environment is null or arca_environment in ('homologation', 'production'));

comment on column public.ordenes.invoice_arca_environment is
  'Ambiente ARCA de la Factura C pedida/autorizada. homologation = comprobante de prueba sin validez fiscal.';
comment on column public.order_credit_notes.arca_environment is
  'Ambiente ARCA de la Nota de Crédito C pedida/autorizada. homologation = comprobante de prueba sin validez fiscal.';

-- Backfill: comprobantes existentes = homologación (ver cabecera).
do $$
declare
  v_orders integer;
  v_notes integer;
begin
  update public.ordenes
  set invoice_arca_environment = 'homologation'
  where invoice_arca_environment is null
    and (invoice_cae is not null or invoice_number is not null or invoice_requested_number is not null);
  get diagnostics v_orders = row_count;

  update public.order_credit_notes
  set arca_environment = 'homologation'
  where arca_environment is null
    and (voucher_number is not null or cae is not null);
  get diagnostics v_notes = row_count;

  raise notice 'ARCA: % factura(s) y % nota(s) de crédito existentes marcadas como homologation.', v_orders, v_notes;
end;
$$;

alter table public.ordenes
  drop constraint if exists ordenes_invoice_arca_environment_required;
alter table public.ordenes
  add constraint ordenes_invoice_arca_environment_required
  check (
    invoice_arca_environment is not null
    or (invoice_cae is null and invoice_number is null and invoice_requested_number is null)
  );
alter table public.order_credit_notes
  drop constraint if exists order_credit_notes_arca_environment_required;
alter table public.order_credit_notes
  add constraint order_credit_notes_arca_environment_required
  check (arca_environment is not null or (voucher_number is null and cae is null));

-- Índices únicos por ambiente. Si hubiera duplicados dentro de un mismo
-- ambiente la migración falla completa (no se crea en silencio sin índice).
drop index if exists public.ordenes_invoice_requested_voucher_unique;
create unique index ordenes_invoice_requested_voucher_unique
  on public.ordenes (invoice_arca_environment, invoice_requested_point, invoice_requested_type, invoice_requested_number)
  where invoice_requested_number is not null;

drop index if exists public.ordenes_invoice_authorized_voucher_unique;
create unique index ordenes_invoice_authorized_voucher_unique
  on public.ordenes (invoice_arca_environment, invoice_point, coalesce(invoice_voucher_type, 11), invoice_number)
  where invoice_cae is not null and invoice_number is not null;

drop index if exists public.order_credit_notes_voucher_unique;
create unique index order_credit_notes_voucher_unique
  on public.order_credit_notes (arca_environment, voucher_point, voucher_number)
  where voucher_point is not null and voucher_number is not null;

-- ---------------------------------------------------------------------------
-- Factura C
-- ---------------------------------------------------------------------------

drop function if exists public.record_arca_invoice_request(bigint, integer, integer, bigint, numeric, text);
create or replace function public.record_arca_invoice_request(
  p_order_id bigint,
  p_point integer,
  p_type integer,
  p_number bigint,
  p_total numeric,
  p_date text,
  p_environment text
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
     or p_total is null or p_total <= 0 or coalesce(p_date, '') !~ '^\d{8}$'
     or p_environment is null or p_environment not in ('homologation', 'production') then
    raise exception 'INVALID_INVOICE_REQUEST';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found or v_order.invoice_status is distinct from 'processing' then
    raise exception 'INVOICE_NOT_PROCESSING';
  end if;
  if v_order.invoice_requested_number is not null then
    if v_order.invoice_requested_point = p_point and v_order.invoice_requested_type = p_type
       and v_order.invoice_requested_number = p_number
       and v_order.invoice_arca_environment = p_environment then
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
      invoice_requested_at = clock_timestamp(),
      invoice_arca_environment = p_environment
  where id = p_order_id
  returning * into v_order;
  return v_order;
exception
  when unique_violation then
    raise exception 'INVOICE_NUMBER_ALREADY_REQUESTED';
end;
$$;

revoke all on function public.record_arca_invoice_request(bigint, integer, integer, bigint, numeric, text, text) from public, anon, authenticated;
grant execute on function public.record_arca_invoice_request(bigint, integer, integer, bigint, numeric, text, text) to service_role;

drop function if exists public.complete_arca_invoice(bigint, integer, integer, bigint, text, date, timestamptz, boolean);
create or replace function public.complete_arca_invoice(
  p_order_id bigint,
  p_point integer,
  p_type integer,
  p_number bigint,
  p_cae text,
  p_cae_due date,
  p_issued_at timestamptz,
  p_reconciled boolean,
  p_environment text
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
  if coalesce(trim(p_cae), '') = '' or p_cae_due is null or p_number is null
     or p_environment is null or p_environment not in ('homologation', 'production') then
    raise exception 'INVALID_INVOICE_AUTHORIZATION';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  if v_order.invoice_cae is not null then
    if v_order.invoice_cae = p_cae and v_order.invoice_number = p_number
       and v_order.invoice_point = p_point
       and v_order.invoice_arca_environment = p_environment then
      return v_order;
    end if;
    raise exception 'INVOICE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER';
  end if;
  if v_order.invoice_requested_number is distinct from p_number
     or v_order.invoice_requested_point is distinct from p_point
     or v_order.invoice_requested_type is distinct from p_type
     or v_order.invoice_arca_environment is distinct from p_environment then
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
      'environment', p_environment, 'creditNoteRequired', v_cancellation_flow));
  return v_order;
end;
$$;

revoke all on function public.complete_arca_invoice(bigint, integer, integer, bigint, text, date, timestamptz, boolean, text) from public, anon, authenticated;
grant execute on function public.complete_arca_invoice(bigint, integer, integer, bigint, text, date, timestamptz, boolean, text) to service_role;

-- Igual que 20260927100000; además, liberar el número limpia su ambiente.
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
      invoice_requested_at = case when p_release_request then null else invoice_requested_at end,
      invoice_arca_environment = case
        when p_release_request and invoice_cae is null and invoice_number is null then null
        else invoice_arca_environment end
  where id = p_order_id
  returning * into v_order;

  if v_order.invoice_requested_number is null and not public.order_is_invoiceable(v_order) then
    update public.ordenes set invoice_status = null, invoice_next_attempt_at = null
    where id = p_order_id returning * into v_order;
  end if;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (p_order_id, 'system', 'arca_invoice_attempt_failed', 'processing', coalesce(v_order.invoice_status, 'not_invoiceable'),
    jsonb_build_object('error', left(p_error, 1000), 'attempt', v_order.invoice_attempts,
      'requestReleased', p_release_request,
      'pendingReconciliation', v_order.invoice_requested_number,
      'environment', v_order.invoice_arca_environment,
      'nextAttemptAt', v_order.invoice_next_attempt_at));
  return v_order;
end;
$$;

revoke all on function public.fail_arca_invoice_attempt(bigint, text, interval, boolean) from public, anon, authenticated;
grant execute on function public.fail_arca_invoice_attempt(bigint, text, interval, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Nota de Crédito C
-- ---------------------------------------------------------------------------

drop function if exists public.record_credit_note_request(uuid, integer, bigint, numeric, text);
create or replace function public.record_credit_note_request(
  p_note_id uuid,
  p_point integer,
  p_number bigint,
  p_total numeric,
  p_date text,
  p_environment text
)
returns public.order_credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note public.order_credit_notes%rowtype;
  v_invoice_environment text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_point is null or p_point <= 0 or p_number is null or p_number <= 0
     or p_total is null or p_total <= 0 or coalesce(p_date, '') !~ '^\d{8}$'
     or p_environment is null or p_environment not in ('homologation', 'production') then
    raise exception 'INVALID_CREDIT_NOTE_REQUEST';
  end if;

  select * into v_note from public.order_credit_notes where id = p_note_id for update;
  if not found or v_note.status is distinct from 'processing'
     or v_note.arca_claimed_until is null or v_note.arca_claimed_until <= clock_timestamp() then
    raise exception 'CREDIT_NOTE_NOT_CLAIMED';
  end if;
  if round(p_total, 2) <> v_note.total_amount then
    raise exception 'CREDIT_NOTE_AMOUNT_MISMATCH';
  end if;

  -- La NC se emite en el ambiente de su Factura C asociada, nunca en otro.
  select invoice_arca_environment into v_invoice_environment
  from public.ordenes
  where id = v_note.order_id
    and invoice_cae is not null
    and invoice_point = v_note.invoice_point
    and invoice_number = v_note.invoice_number;
  if v_invoice_environment is distinct from p_environment then
    raise exception 'CREDIT_NOTE_ENVIRONMENT_MISMATCH';
  end if;

  if v_note.voucher_number is not null then
    if v_note.voucher_point = p_point and v_note.voucher_number = p_number
       and v_note.arca_environment = p_environment then
      return v_note;
    end if;
    raise exception 'CREDIT_NOTE_REQUEST_PENDING_RECONCILIATION';
  end if;

  update public.order_credit_notes
  set voucher_point = p_point,
      voucher_number = p_number,
      arca_environment = p_environment,
      requested_total = round(p_total, 2),
      requested_date = p_date,
      requested_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = p_note_id
  returning * into v_note;
  return v_note;
exception
  when unique_violation then
    raise exception 'CREDIT_NOTE_NUMBER_ALREADY_USED';
end;
$$;

revoke all on function public.record_credit_note_request(uuid, integer, bigint, numeric, text, text) from public, anon, authenticated;
grant execute on function public.record_credit_note_request(uuid, integer, bigint, numeric, text, text) to service_role;

drop function if exists public.complete_credit_note_authorization(uuid, integer, bigint, text, date, timestamptz, boolean);
create or replace function public.complete_credit_note_authorization(
  p_note_id uuid,
  p_point integer,
  p_number bigint,
  p_cae text,
  p_cae_due date,
  p_authorized_at timestamptz,
  p_reconciled boolean,
  p_environment text
)
returns public.order_credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note public.order_credit_notes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(trim(p_cae), '') = '' or p_cae_due is null or p_number is null
     or p_environment is null or p_environment not in ('homologation', 'production') then
    raise exception 'INVALID_CREDIT_NOTE_AUTHORIZATION';
  end if;

  select * into v_note from public.order_credit_notes where id = p_note_id for update;
  if not found then raise exception 'CREDIT_NOTE_NOT_FOUND'; end if;

  if v_note.status = 'authorized' then
    if v_note.cae = p_cae and v_note.voucher_number = p_number and v_note.voucher_point = p_point
       and v_note.arca_environment = p_environment then
      return v_note;
    end if;
    raise exception 'CREDIT_NOTE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER';
  end if;
  if v_note.status is distinct from 'processing'
     or v_note.voucher_number is distinct from p_number
     or v_note.voucher_point is distinct from p_point
     or v_note.arca_environment is distinct from p_environment then
    raise exception 'CREDIT_NOTE_AUTHORIZATION_DOES_NOT_MATCH_REQUEST';
  end if;

  update public.order_credit_notes
  set status = 'authorized',
      cae = p_cae,
      cae_due = p_cae_due,
      authorized_at = coalesce(p_authorized_at, clock_timestamp()),
      error = null,
      management_status = case when destination = 'customer_balance' then 'nota_credito_emitida' else 'reembolso_pendiente' end,
      settlement_status = case when destination = 'customer_balance' then 'procesando' else 'pendiente' end,
      updated_at = clock_timestamp()
  where id = p_note_id
  returning * into v_note;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (v_note.order_id, 'system', 'credit_note_arca_authorized', 'processing', 'authorized',
    jsonb_build_object('orderCreditNoteId', v_note.id, 'point', p_point, 'number', p_number,
      'cae', p_cae, 'reconciled', p_reconciled, 'amount', v_note.total_amount,
      'environment', p_environment,
      'associatedInvoicePoint', v_note.invoice_point, 'associatedInvoiceNumber', v_note.invoice_number));
  return v_note;
end;
$$;

revoke all on function public.complete_credit_note_authorization(uuid, integer, bigint, text, date, timestamptz, boolean, text) from public, anon, authenticated;
grant execute on function public.complete_credit_note_authorization(uuid, integer, bigint, text, date, timestamptz, boolean, text) to service_role;

-- Igual que 20260927110000; además, liberar el número limpia su ambiente.
create or replace function public.fail_credit_note_arca_attempt(
  p_note_id uuid,
  p_error text,
  p_outcome text
)
returns public.order_credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note public.order_credit_notes%rowtype;
  v_message text := left(coalesce(nullif(trim(p_error), ''), 'Error al emitir la nota de crédito.'), 1000);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_outcome not in ('rejected', 'unknown', 'manual_review') then
    raise exception 'INVALID_CREDIT_NOTE_OUTCOME';
  end if;

  select * into v_note from public.order_credit_notes where id = p_note_id for update;
  if not found then raise exception 'CREDIT_NOTE_NOT_FOUND'; end if;
  if v_note.status is distinct from 'processing' then
    return v_note;
  end if;

  if p_outcome = 'rejected' then
    update public.order_credit_notes
    set status = 'error',
        error = v_message,
        voucher_point = null,
        voucher_number = null,
        arca_environment = null,
        requested_total = null,
        requested_date = null,
        requested_at = null,
        arca_claimed_until = null,
        updated_at = clock_timestamp()
    where id = p_note_id
    returning * into v_note;
    update public.ordenes set credit_note_status = 'error', credit_note_error = v_message
    where id = v_note.order_id;
  else
    update public.order_credit_notes
    set error = case when p_outcome = 'manual_review'
          then 'Revisión manual: ' || v_message
          else 'Resultado fiscal pendiente de conciliación. No repetir la emisión. ' || v_message end,
        arca_claimed_until = null,
        updated_at = clock_timestamp()
    where id = p_note_id
    returning * into v_note;
  end if;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (v_note.order_id, 'system', 'credit_note_arca_attempt_failed', 'processing', v_note.status,
    jsonb_build_object('orderCreditNoteId', v_note.id, 'outcome', p_outcome, 'error', v_message,
      'pendingVoucherNumber', v_note.voucher_number, 'environment', v_note.arca_environment));
  return v_note;
end;
$$;

revoke all on function public.fail_credit_note_arca_attempt(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_credit_note_arca_attempt(uuid, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
