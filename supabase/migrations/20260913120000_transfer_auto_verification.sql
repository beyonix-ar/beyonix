-- Conciliación automática de transferencias bancarias directas (CVU/alias).
--
-- Contexto: hoy un pedido por transferencia sólo se confirma cuando un admin
-- revisa manualmente el comprobante subido por el cliente
-- (app/api/admin/pedidos/[id]/payment-status/route.ts). Esta migración agrega
-- las columnas y funciones necesarias para que el propio backend intente
-- conciliar la transferencia contra Mercado Pago (monto exacto + DNI derivado
-- de payer.identification + ventana temporal + payment.id único) ANTES de
-- pedirle un comprobante al cliente, sin tocar el mecanismo manual existente.
--
-- Aditivo y no destructivo: sólo agrega columnas nullable, un índice único
-- parcial y dos funciones nuevas. No modifica columnas, constraints,
-- triggers ni funciones existentes. El trigger
-- validate_inventory_order_confirmation (20260904090000) sigue aplicando tal
-- cual sobre cualquier UPDATE de estado/payment_status, incluido el que hace
-- confirm_transfer_auto_verification de acá abajo.

begin;

alter table public.ordenes
  add column if not exists transfer_verification_status text
    default 'pending',
  add column if not exists transfer_payer_first_name text,
  add column if not exists transfer_payer_last_name text,
  add column if not exists transfer_payer_dni text,
  add column if not exists transfer_amount_declared numeric,
  add column if not exists transfer_verification_attempts integer not null default 0,
  add column if not exists transfer_last_verification_at timestamptz,
  add column if not exists transfer_verification_failure_reason text,
  add column if not exists transfer_matched_payment_id text,
  add column if not exists transfer_match_snapshot jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ordenes_transfer_verification_status_check'
  ) then
    alter table public.ordenes
      add constraint ordenes_transfer_verification_status_check
      check (transfer_verification_status in ('pending', 'checking', 'auto_verified', 'manual_review'));
  end if;
end $$;

-- Un mismo payment.id de Mercado Pago JAMÁS puede acreditar más de un pedido.
-- No depende de transaction_details.bank_transfer_id (comprobado que puede
-- venir null en transferencias money_transfer/account_money).
create unique index if not exists ordenes_transfer_matched_payment_id_key
  on public.ordenes (transfer_matched_payment_id)
  where transfer_matched_payment_id is not null;

comment on column public.ordenes.transfer_verification_status is
  'Estado de la conciliación automática de transferencia: pending (sin intentos), checking (intento en curso, lease corto), auto_verified (conciliado automáticamente contra Mercado Pago), manual_review (requiere revisión de un admin). Independiente de payment_status: no reemplaza pendiente_comprobante/en_revision/confirmado/rechazado, sólo documenta el origen de la conciliación.';
comment on column public.ordenes.transfer_matched_payment_id is
  'payment.id de Mercado Pago usado para conciliar esta transferencia. Único en toda la tabla (ver índice ordenes_transfer_matched_payment_id_key): un mismo pago de Mercado Pago no puede acreditar dos pedidos.';
comment on column public.ordenes.transfer_match_snapshot is
  'Metadata adicional de la transferencia conciliada (operation_type, payment_method_id, identification type/number original, DNI derivado, bank_transfer_id si existe, fechas). Nunca reemplaza transfer_matched_payment_id como identificador único.';

-- Reclama de forma atómica un intento de verificación para UN pedido:
-- funciona como rate limit (intervalo mínimo entre intentos), protección
-- contra doble click/concurrencia (lease "checking" con expiración corta) y
-- tope de intentos, todo en una sola transacción con "for update".
create or replace function public.claim_transfer_verification_attempt(
  p_order_id bigint,
  p_max_attempts integer default 20,
  p_min_interval_seconds integer default 5,
  p_stale_checking_seconds integer default 60
)
returns public.ordenes
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_order public.ordenes%rowtype;
  v_now timestamptz := now();
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para esta operación.';
  end if;

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND: no encontramos el pedido.';
  end if;

  if v_order.payment_method_id is distinct from 'transferencia' then
    raise exception 'NOT_TRANSFER_ORDER: este pedido no corresponde a transferencia bancaria.';
  end if;

  if lower(coalesce(v_order.estado, '')) = 'cancelado' then
    raise exception 'ORDER_CANCELLED: el pedido está cancelado.';
  end if;

  if coalesce(v_order.payment_status, '') not in ('pendiente_comprobante', 'en_revision') then
    raise exception 'ALREADY_RESOLVED: el pago de este pedido ya no admite verificación automática.';
  end if;

  if v_order.transfer_verification_attempts >= p_max_attempts then
    raise exception 'MAX_ATTEMPTS_EXCEEDED: se alcanzó el máximo de intentos automáticos para este pedido.';
  end if;

  if v_order.transfer_verification_status = 'checking'
     and v_order.transfer_last_verification_at is not null
     and v_order.transfer_last_verification_at > v_now - make_interval(secs => p_stale_checking_seconds) then
    raise exception 'ALREADY_CHECKING: ya hay una verificación en curso para este pedido.';
  end if;

  if v_order.transfer_last_verification_at is not null
     and v_order.transfer_last_verification_at > v_now - make_interval(secs => p_min_interval_seconds) then
    raise exception 'RATE_LIMITED: esperá unos segundos antes de volver a intentar.';
  end if;

  update public.ordenes
  set
    transfer_verification_status = 'checking',
    transfer_verification_attempts = transfer_verification_attempts + 1,
    transfer_last_verification_at = v_now
  where id = v_order.id
  returning *
  into v_order;

  return v_order;
end;
$$;

revoke all on function public.claim_transfer_verification_attempt(bigint, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_transfer_verification_attempt(bigint, integer, integer, integer)
  to service_role;

comment on function public.claim_transfer_verification_attempt(bigint, integer, integer, integer) is
  'Reclama de forma atómica un intento de verificación automática de transferencia. Sirve como rate limit, lock anti doble-click/concurrencia y tope de intentos. No confirma nada por sí sola.';

-- Confirma de forma atómica una transferencia conciliada automáticamente
-- contra Mercado Pago. Reutiliza el mismo esquema de campos "confirmado" que
-- ya usa la aprobación manual (payment_confirmed_at/by/amount,
-- order_change_status) para no duplicar el significado de esos campos, y
-- deja que el trigger validate_inventory_order_confirmation (existente,
-- 20260904090000) siga siendo el único guardián de stock.
create or replace function public.confirm_transfer_auto_verification(
  p_order_id bigint,
  p_matched_payment_id text,
  p_matched_operation_type text,
  p_matched_payment_method_id text,
  p_matched_amount numeric,
  p_matched_identification_type text,
  p_matched_identification_number text,
  p_matched_dni_derived text,
  p_matched_bank_transfer_id text,
  p_matched_date_created timestamptz,
  p_matched_date_approved timestamptz
)
returns public.ordenes
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_order public.ordenes%rowtype;
  v_now timestamptz := now();
  v_previous_financial_status text;
  v_snapshot jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para esta operación.';
  end if;

  if coalesce(trim(p_matched_payment_id), '') = '' then
    raise exception 'INVALID_PAYMENT_ID: falta el identificador de Mercado Pago.';
  end if;

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND: no encontramos el pedido.';
  end if;

  if v_order.payment_method_id is distinct from 'transferencia' then
    raise exception 'NOT_TRANSFER_ORDER: este pedido no corresponde a transferencia bancaria.';
  end if;

  if lower(coalesce(v_order.estado, '')) = 'cancelado' then
    raise exception 'ORDER_CANCELLED: el pedido está cancelado.';
  end if;

  if coalesce(v_order.payment_status, '') not in ('pendiente_comprobante', 'en_revision') then
    raise exception 'ALREADY_RESOLVED: el pago de este pedido ya no admite verificación automática.';
  end if;

  if exists (
    select 1 from public.ordenes
    where transfer_matched_payment_id = p_matched_payment_id
      and id <> p_order_id
  ) then
    raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
  end if;

  v_previous_financial_status := coalesce(
    v_order.financial_status,
    v_order.payment_status,
    'pending_payment'
  );
  v_snapshot := jsonb_build_object(
    'operationType', p_matched_operation_type,
    'paymentMethodId', p_matched_payment_method_id,
    'identificationType', p_matched_identification_type,
    'identificationNumber', p_matched_identification_number,
    'dniDerivado', p_matched_dni_derived,
    'bankTransferId', p_matched_bank_transfer_id,
    'dateCreated', p_matched_date_created,
    'dateApproved', p_matched_date_approved
  );

  begin
    update public.ordenes
    set
      payment_status = 'confirmado',
      estado = 'pagado',
      financial_status = 'payment_confirmed',
      paid_at = coalesce(v_order.paid_at, v_now),
      payment_confirmed_by = null,
      payment_confirmed_at = v_now,
      payment_confirmed_amount = p_matched_amount,
      order_change_status = 'change_approved',
      order_change_extra_amount = 0,
      transfer_verification_status = 'auto_verified',
      transfer_verification_failure_reason = null,
      transfer_last_verification_at = v_now,
      transfer_matched_payment_id = p_matched_payment_id,
      transfer_match_snapshot = v_snapshot
    where id = v_order.id
    returning *
    into v_order;
  exception
    when unique_violation then
      raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
  end;

  insert into public.order_audit_events (
    order_id,
    actor_type,
    actor_id,
    action,
    previous_status,
    new_status,
    metadata
  )
  values (
    v_order.id,
    'system',
    null,
    'transfer_auto_verified',
    v_previous_financial_status,
    'payment_confirmed',
    jsonb_build_object(
      'provider', 'mercadopago',
      'matchedPaymentId', p_matched_payment_id,
      'matchedAmount', p_matched_amount,
      'operationType', p_matched_operation_type,
      'paymentMethodId', p_matched_payment_method_id
    )
  );

  return v_order;
end;
$$;

revoke all on function public.confirm_transfer_auto_verification(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.confirm_transfer_auto_verification(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz)
  to service_role;

comment on function public.confirm_transfer_auto_verification(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz) is
  'Confirma automáticamente un pedido por transferencia ya conciliado contra Mercado Pago (monto + DNI derivado + ventana temporal ya validados en backend). Reutiliza el mismo trigger de guardián de stock que la confirmación manual. Idempotente ante payment.id repetido: nunca acredita el mismo payment.id dos veces (índice único + chequeo explícito).';

commit;
