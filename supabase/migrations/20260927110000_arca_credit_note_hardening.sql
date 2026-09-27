-- ARCA: hardening de Notas de Crédito C (mismo principio que la Factura C,
-- 20260927100000).
--
-- QUÉ HABÍA
-- * begin_partial_credit_note reserva la NC ('processing') bajo lock por
--   pedido y el índice order_credit_notes_single_processing admite UNA sola
--   NC 'processing' en toda la tienda: la numeración ya estaba serializada.
-- * La ruta guardaba voucher_point/voucher_number ANTES de FECAESolicitar.
-- PERO:
-- * si la respuesta se perdía (timeout, reinicio) la NC quedaba 'processing'
--   para siempre ("pendiente de conciliación") sin ningún camino para
--   conciliarla, y por el índice global bloqueaba TODAS las NC;
-- * un rechazo definitivo de ARCA tras enviar el pedido quedaba igual;
-- * si algo fallaba DESPUÉS de autorizar (stock, saldo, resumen del pedido)
--   no había forma segura de completar esos pasos.
--
-- QUÉ AGREGA (sin cambiar begin_partial_credit_note ni el flujo de reclamos)
-- * Lease por NC (arca_claimed_until): dos clicks/procesos -> uno solo avanza.
-- * El pedido a ARCA queda persistido con importe y fecha
--   (voucher_point/voucher_number + requested_total/requested_date).
-- * complete_credit_note_authorization: idempotente; nunca pisa otro CAE.
-- * fail_credit_note_arca_attempt:
--     rejected      -> ARCA confirmó que NO autorizó: 'error', se libera el
--                      número y la reserva de importes (como hoy);
--     unknown       -> resultado desconocido: sigue 'processing' con el
--                      número, para conciliar (fail-closed);
--     manual_review -> ARCA tiene ese número con otros datos: sigue
--                      'processing', jamás se adopta ni se re-emite solo.
-- * finalized_at: los pasos posteriores a la autorización (reingreso de
--   stock, saldo a favor, resumen del pedido) son reanudables e
--   idempotentes; finish_credit_note_finalization los cierra una vez.
-- * conditioned_discount_percent: se guarda en la NC para poder reanudar el
--   reingreso a "stock con observaciones" sin depender del request original.
-- * Todo es service_role.

begin;

alter table public.order_credit_notes
  add column if not exists requested_total numeric(12, 2),
  add column if not exists requested_date text,
  add column if not exists requested_at timestamptz,
  add column if not exists arca_attempts integer not null default 0,
  add column if not exists arca_claimed_until timestamptz,
  add column if not exists finalized_at timestamptz,
  add column if not exists conditioned_discount_percent numeric(5, 2);

-- Las NC autorizadas antes de esta migración ya completaron su flujo.
update public.order_credit_notes
set finalized_at = coalesce(authorized_at, updated_at, now())
where status = 'authorized' and finalized_at is null;

-- Toma una NC para hablar con ARCA o para completar sus pasos posteriores.
create or replace function public.claim_credit_note_arca(
  p_note_id uuid,
  p_lease interval default interval '10 minutes'
)
returns public.order_credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note public.order_credit_notes%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_note from public.order_credit_notes where id = p_note_id for update;
  if not found then raise exception 'CREDIT_NOTE_NOT_FOUND'; end if;
  if v_note.status = 'authorized' and v_note.finalized_at is not null then
    raise exception 'CREDIT_NOTE_ALREADY_FINALIZED';
  end if;
  if v_note.status not in ('processing', 'authorized') then
    raise exception 'CREDIT_NOTE_NOT_PROCESSING';
  end if;
  if v_note.arca_claimed_until is not null and v_note.arca_claimed_until > v_now then
    raise exception 'CREDIT_NOTE_ALREADY_PROCESSING';
  end if;

  -- NC colgada por la versión anterior de la ruta: su número pedido quedó en
  -- voucher_* sin importe; el importe pedido era el total de la NC.
  update public.order_credit_notes
  set arca_claimed_until = v_now + p_lease,
      arca_attempts = coalesce(arca_attempts, 0) + 1,
      requested_total = case
        when status = 'processing' and voucher_number is not null and requested_total is null
          then total_amount else requested_total end,
      updated_at = v_now
  where id = p_note_id
  returning * into v_note;
  return v_note;
end;
$$;

revoke all on function public.claim_credit_note_arca(uuid, interval) from public, anon, authenticated;
grant execute on function public.claim_credit_note_arca(uuid, interval) to service_role;

-- Persiste el número a pedir ANTES de FECAESolicitar.
create or replace function public.record_credit_note_request(
  p_note_id uuid,
  p_point integer,
  p_number bigint,
  p_total numeric,
  p_date text
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
  if p_point is null or p_point <= 0 or p_number is null or p_number <= 0
     or p_total is null or p_total <= 0 or coalesce(p_date, '') !~ '^\d{8}$' then
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
  if v_note.voucher_number is not null then
    if v_note.voucher_point = p_point and v_note.voucher_number = p_number then
      return v_note;
    end if;
    raise exception 'CREDIT_NOTE_REQUEST_PENDING_RECONCILIATION';
  end if;

  update public.order_credit_notes
  set voucher_point = p_point,
      voucher_number = p_number,
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

revoke all on function public.record_credit_note_request(uuid, integer, bigint, numeric, text) from public, anon, authenticated;
grant execute on function public.record_credit_note_request(uuid, integer, bigint, numeric, text) to service_role;

-- Guarda el CAE de la NC. Idempotente; nunca pisa otro comprobante.
create or replace function public.complete_credit_note_authorization(
  p_note_id uuid,
  p_point integer,
  p_number bigint,
  p_cae text,
  p_cae_due date,
  p_authorized_at timestamptz,
  p_reconciled boolean default false
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
  if coalesce(trim(p_cae), '') = '' or p_cae_due is null or p_number is null then
    raise exception 'INVALID_CREDIT_NOTE_AUTHORIZATION';
  end if;

  select * into v_note from public.order_credit_notes where id = p_note_id for update;
  if not found then raise exception 'CREDIT_NOTE_NOT_FOUND'; end if;

  if v_note.status = 'authorized' then
    if v_note.cae = p_cae and v_note.voucher_number = p_number and v_note.voucher_point = p_point then
      return v_note;
    end if;
    raise exception 'CREDIT_NOTE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER';
  end if;
  if v_note.status is distinct from 'processing'
     or v_note.voucher_number is distinct from p_number
     or v_note.voucher_point is distinct from p_point then
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
      'associatedInvoicePoint', v_note.invoice_point, 'associatedInvoiceNumber', v_note.invoice_number));
  return v_note;
end;
$$;

revoke all on function public.complete_credit_note_authorization(uuid, integer, bigint, text, date, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.complete_credit_note_authorization(uuid, integer, bigint, text, date, timestamptz, boolean) to service_role;

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
    -- ARCA confirmó que no autorizó: se libera el número y la reserva.
    update public.order_credit_notes
    set status = 'error',
        error = v_message,
        voucher_point = null,
        voucher_number = null,
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
      'pendingVoucherNumber', v_note.voucher_number));
  return v_note;
end;
$$;

revoke all on function public.fail_credit_note_arca_attempt(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_credit_note_arca_attempt(uuid, text, text) to service_role;

-- Cierra los pasos posteriores a la autorización. Devuelve true sólo la
-- primera vez (auditoría y avisos no se repiten en un reintento).
create or replace function public.finish_credit_note_finalization(p_note_id uuid)
returns boolean
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
  select * into v_note from public.order_credit_notes where id = p_note_id for update;
  if not found or v_note.status is distinct from 'authorized' then
    raise exception 'CREDIT_NOTE_NOT_AUTHORIZED';
  end if;
  if v_note.finalized_at is not null then
    return false;
  end if;
  update public.order_credit_notes
  set finalized_at = clock_timestamp(), arca_claimed_until = null, updated_at = clock_timestamp()
  where id = p_note_id;
  return true;
end;
$$;

revoke all on function public.finish_credit_note_finalization(uuid) from public, anon, authenticated;
grant execute on function public.finish_credit_note_finalization(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
