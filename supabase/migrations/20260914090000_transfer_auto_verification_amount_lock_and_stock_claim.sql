-- Corrige dos bloqueantes críticos detectados en auditoría sobre
-- 20260913120000_transfer_auto_verification.sql (aplicada, no se modifica):
--
-- 1) RACE CONDITION DE MONTO: confirm_transfer_auto_verification nunca
--    revalidaba el monto esperado vigente DENTRO de la transacción bajo
--    "for update". El monto se comparaba únicamente en TypeScript, contra
--    una lectura de la orden hecha ANTES de consultar a Mercado Pago (que
--    puede tardar). Si el monto esperado del pedido cambia entre esa
--    lectura previa y esta RPC (ejemplo: un admin corrige el precio
--    mientras el backend consulta Mercado Pago), la RPC podía confirmar
--    igual contra un monto que ya no es el vigente. Ahora relee
--    external_amount_due/total bajo el mismo lock ya tomado por el
--    "for update" de arriba y rechaza (AMOUNT_MISMATCH) si no coincide en
--    centavos exactos con el monto de la transferencia (p_matched_amount) ni
--    con el monto declarado por el cliente (transfer_amount_declared, si ya
--    fue persistido). La base de datos, bajo lock, es la única fuente de
--    verdad.
--
-- 2) PAYMENT.ID SIN RESERVAR ANTE CONFLICTO DE STOCK: cuando el guardián de
--    inventario (validate_inventory_order_confirmation, 20260904090000)
--    rechaza la confirmación por falta de stock, TODA la transacción de la
--    RPC se revertía -- incluido el UPDATE que iba a fijar
--    transfer_matched_payment_id. El resultado real era que una
--    transferencia YA IDENTIFICADA contra Mercado Pago quedaba sin ningún
--    registro en la orden, dejando la puerta abierta a reutilizar ese mismo
--    payment.id (para el mismo pedido u otro) sin protección real. Ahora,
--    dentro de la MISMA transacción y bajo el mismo lock de fila, si la
--    confirmación completa falla puntualmente por CHECKOUT_STOCK_INSUFFICIENT
--    se hace un segundo UPDATE más angosto que sólo reclama
--    transfer_matched_payment_id (protegido además por el índice único
--    parcial ya existente) y dos campos de estado. A propósito NO toca
--    estado/financial_status: así inventory_order_consumes_stock(new.estado,
--    new.payment_status) sigue dando false para esa fila (ver
--    supabase/sql/093_unified_inventory_source.sql) y el guardián de
--    inventario no se vuelve a disparar sobre este UPDATE angosto. La
--    función deja de LANZAR una excepción para este caso: devuelve la orden
--    actualizada con payment_status='auto_verified_stock_conflict' como
--    resultado normal, y el caller (lib/orders/transfer-verification-service.ts)
--    ya no necesita hacer ese UPDATE por separado (que antes corría FUERA
--    del lock, sin protección real ante una carrera, y ni siquiera fijaba
--    transfer_matched_payment_id).
--
--    La resolución manual de este estado reutiliza el mecanismo ya existente
--    de aprobación manual de transferencias
--    (app/api/admin/pedidos/[id]/payment-status/route.ts +
--    lib/orders/transfer-payment-status.ts): un admin puede confirmar (si
--    repuso stock) o rechazar directamente desde
--    auto_verified_stock_conflict, sin depender de que el cliente suba un
--    comprobante (la plata ya fue identificada). Eso se implementa en
--    TypeScript, no en esta migración.
--
-- No reemplaza ninguna migración aplicada: crea una nueva revisión de la
-- función existente con CREATE OR REPLACE (mismo patrón ya usado en todo el
-- proyecto para iterar funciones ya aplicadas). No modifica columnas,
-- constraints, índices ni triggers existentes. claim_transfer_verification_attempt
-- no cambia.

begin;

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
  v_expected_amount numeric;
  v_expected_cents bigint;
  v_matched_cents bigint;
  v_declared_cents bigint;
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

  -- P0: monto esperado BAJO EL LOCK ya tomado arriba -- nunca el monto que
  -- el caller haya leído antes de invocar esta RPC (puede quedar
  -- desactualizado durante el tiempo que tarda la consulta a Mercado Pago).
  -- Mismo criterio de columnas que usa el resto del proyecto:
  -- external_amount_due si existe, si no total.
  v_expected_amount := coalesce(v_order.external_amount_due, v_order.total);
  v_expected_cents := round(coalesce(v_expected_amount, -1) * 100);
  v_matched_cents := round(coalesce(p_matched_amount, -1) * 100);

  if v_expected_cents is null or v_expected_cents <= 0
     or v_matched_cents is null or v_matched_cents <> v_expected_cents then
    raise exception 'AMOUNT_MISMATCH: el monto vigente del pedido no coincide con el importe de la transferencia.';
  end if;

  if v_order.transfer_amount_declared is not null then
    v_declared_cents := round(v_order.transfer_amount_declared * 100);
    if v_declared_cents <> v_matched_cents then
      raise exception 'AMOUNT_MISMATCH: el monto declarado no coincide con el importe vigente del pedido.';
    end if;
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
    when others then
      if sqlerrm !~* 'CHECKOUT_STOCK_INSUFFICIENT' then
        raise;
      end if;

      -- El dinero YA fue identificado contra Mercado Pago: aunque el stock
      -- ya no alcance para confirmar la orden, el payment.id tiene que
      -- quedar reservado para ESTE pedido de forma atómica (mismo lock de
      -- fila tomado arriba por el "for update"), para que nunca pueda
      -- reutilizarse en otro intento ni en otro pedido. A propósito no toca
      -- estado/financial_status: eso evita que este UPDATE angosto dispare
      -- de nuevo el guardián de inventario.
      begin
        update public.ordenes
        set
          payment_status = 'auto_verified_stock_conflict',
          transfer_verification_status = 'manual_review',
          transfer_verification_failure_reason = 'stock_conflict',
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
        order_id, actor_type, actor_id, action, previous_status, new_status, metadata
      )
      values (
        v_order.id, 'system', null, 'transfer_auto_verification_stock_conflict',
        v_previous_financial_status, v_previous_financial_status,
        jsonb_build_object(
          'provider', 'mercadopago',
          'matchedPaymentId', p_matched_payment_id,
          'matchedAmount', p_matched_amount,
          'reason', 'inventory_unavailable_at_confirmation'
        )
      );

      return v_order;
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
  'Confirma automáticamente un pedido por transferencia ya conciliado contra Mercado Pago. Revalida el monto esperado vigente BAJO LOCK (for update) contra el monto de la transferencia y el monto declarado -- nunca confía en el monto leído por el caller antes de esta llamada (AMOUNT_MISMATCH si no coincide). Si el guardián de inventario rechaza la confirmación por falta de stock, reclama igual transfer_matched_payment_id de forma atómica (payment_status=auto_verified_stock_conflict) para que ese payment.id nunca quede sin reservar. Idempotente ante payment.id repetido.';

commit;
