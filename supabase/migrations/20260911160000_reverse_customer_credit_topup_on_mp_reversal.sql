-- P1: una carga de saldo (customer_credit_topups) acreditada por Mercado
-- Pago (credit_customer_credit_topup_from_mercadopago) nunca se revertía si
-- MP notificaba después refunded/charged_back/cancelled sobre ese mismo
-- pago. processCustomerCreditTopupPayment (lib/mercadopago/customer-credit-topups.ts)
-- trataba cualquier estado no-aprobado igual que un rechazo pre-acreditación:
-- `status: topup.status === 'acreditado' ? 'acreditado' : nextStatus` --
-- si ya estaba acreditado, el status SE MANTENÍA 'acreditado' para siempre;
-- sólo se actualizaba mercadopago_status como dato informativo. El saldo
-- acreditado (customer_credit_movements) nunca se tocaba: quedaba disponible
-- para gastar aunque Mercado Pago ya hubiera devuelto/contracargado el dinero.
--
-- CORRECCIÓN: nueva RPC reverse_customer_credit_topup, análoga a
-- reverse_customer_credit_for_order (20260911150000). Debita el monto
-- acreditado originalmente; si el cliente ya gastó parte/todo ese saldo,
-- debita sólo lo disponible y registra la diferencia como
-- reversal_shortfall_amount + nota explícita en admin_notes (nunca lo oculta
-- ni intenta dejar el saldo en negativo). Transaccional (mismo lock
-- advisory + `for update` que el resto de las RPC de saldo), idempotente por
-- estado ('revertido' es terminal) y por source_key (contra reentregas del
-- mismo webhook o dos payment distintos del mismo topup).
--
-- Además: credit_customer_credit_topup_from_mercadopago se redefine para que
-- 'revertido' sea terminal de verdad -- un 'approved' tardío (reentrega fuera
-- de orden) ya no vuelve a poner status='acreditado' aunque
-- create_customer_credit_movement no duplique el saldo por su propio
-- source_key. Ver el segundo CREATE OR REPLACE más abajo.

begin;

alter table public.customer_credit_topups
  drop constraint if exists customer_credit_topups_status_check;

alter table public.customer_credit_topups
  add constraint customer_credit_topups_status_check
  check (status = any (array[
    'pendiente_pago', 'en_revision', 'acreditado', 'rechazado', 'cancelado', 'revertido'
  ]));

alter table public.customer_credit_topups
  add column if not exists reversed_movement_id uuid
    references public.customer_credit_movements(id) on delete set null;

alter table public.customer_credit_topups
  add column if not exists reversal_shortfall_amount numeric(12, 2);

comment on column public.customer_credit_topups.reversal_shortfall_amount is
  'Si Mercado Pago revierte (refund/chargeback) una carga ya acreditada y el cliente ya gastó parte/todo ese saldo, esta columna registra explícitamente cuánto no se pudo recuperar. NULL/0 = se recuperó todo.';

CREATE OR REPLACE FUNCTION public.reverse_customer_credit_topup(
  p_topup_id uuid,
  p_payment_id text,
  p_payment_status text,
  p_description text DEFAULT NULL::text
)
RETURNS TABLE(topup_status text, movement_id uuid, resulting_balance numeric, shortfall_amount numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_topup public.customer_credit_topups%rowtype;
  v_amount numeric(12, 2);
  v_balance numeric(12, 2);
  v_debit numeric(12, 2);
  v_shortfall numeric(12, 2);
  v_source_key text;
  v_existing public.customer_credit_movements%rowtype;
  v_movement public.customer_credit_movements%rowtype;
  v_movement_id uuid;
  v_notes text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  if p_topup_id is null
     or nullif(trim(coalesce(p_payment_id, '')), '') is null
     or nullif(trim(coalesce(p_payment_status, '')), '') is null then
    raise exception 'INVALID_TOPUP_REVERSAL_REQUEST';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer-credit-topup-reversal:' || p_topup_id::text));

  select *
  into v_topup
  from public.customer_credit_topups
  where id = p_topup_id
  for update;

  if not found then
    raise exception 'TOPUP_NOT_FOUND';
  end if;

  if v_topup.payment_method <> 'mercadopago' then
    raise exception 'INVALID_TOPUP_PAYMENT_METHOD';
  end if;

  -- Nunca llegó a acreditarse (rechazada/cancelada antes de aprobarse):
  -- no-op explícito, nada que revertir.
  if v_topup.status <> 'acreditado' and v_topup.status <> 'revertido' then
    topup_status := v_topup.status;
    movement_id := null;
    resulting_balance := public.get_customer_credit_balance(v_topup.user_id);
    shortfall_amount := 0;
    return next;
    return;
  end if;

  -- Ya revertida: idempotente ante reentregas del mismo webhook o varios
  -- eventos de reversa (refunded + charged_back) sobre el mismo topup.
  if v_topup.status = 'revertido' then
    topup_status := 'revertido';
    movement_id := v_topup.reversed_movement_id;
    resulting_balance := public.get_customer_credit_balance(v_topup.user_id);
    shortfall_amount := coalesce(v_topup.reversal_shortfall_amount, 0);
    return next;
    return;
  end if;

  v_amount := round(coalesce(v_topup.amount, 0)::numeric, 2);
  v_source_key := 'customer-credit-topup-mp-reversal:' || p_topup_id::text;

  select *
  into v_existing
  from public.customer_credit_movements
  where source_key = v_source_key
  limit 1;

  if found then
    update public.customer_credit_topups
    set
      status = 'revertido',
      mercadopago_payment_id = p_payment_id,
      mercadopago_status = p_payment_status,
      reversed_movement_id = v_existing.id,
      updated_at = now()
    where id = p_topup_id;

    topup_status := 'revertido';
    movement_id := v_existing.id;
    resulting_balance := public.get_customer_credit_balance(v_topup.user_id);
    shortfall_amount := coalesce(v_topup.reversal_shortfall_amount, 0);
    return next;
    return;
  end if;

  select public.get_customer_credit_balance(v_topup.user_id)
  into v_balance;

  -- Si el cliente ya gastó parte/todo el saldo, sólo se puede debitar lo
  -- disponible -- el resto queda como deuda/conflicto explícito, nunca
  -- oculto ni forzado a un saldo negativo.
  v_debit := least(v_amount, v_balance);
  v_shortfall := greatest(v_amount - v_balance, 0);

  if v_debit > 0 then
    insert into public.customer_credit_movements (
      user_id,
      movement_type,
      amount,
      description,
      source_type,
      source_id,
      created_by,
      related_movement_id,
      source_key,
      resulting_balance,
      metadata
    ) values (
      v_topup.user_id,
      'debit',
      v_debit,
      coalesce(
        nullif(trim(p_description), ''),
        'Reintegro/contracargo de Mercado Pago sobre carga de saldo (' || p_payment_status || ')'
      ),
      'reversal',
      p_topup_id::text,
      null,
      v_topup.credited_movement_id,
      v_source_key,
      greatest(v_balance - v_debit, 0),
      jsonb_build_object(
        'topup_id', p_topup_id,
        'mercadopago_payment_id', p_payment_id,
        'mercadopago_status', p_payment_status,
        'shortfall_amount', v_shortfall
      )
    )
    returning *
    into v_movement;

    v_movement_id := v_movement.id;
  else
    v_movement_id := null;
  end if;

  v_notes := trim(
    coalesce(v_topup.admin_notes, '') ||
    case
      when v_shortfall > 0 then
        E'\n[Reversa MP] El cliente ya había gastado el saldo: quedan $' ||
        v_shortfall::text ||
        ' sin recuperar (payment ' || p_payment_id || ', estado ' || p_payment_status || '). Requiere gestión de cobro/ajuste manual.'
      else ''
    end
  );

  update public.customer_credit_topups
  set
    status = 'revertido',
    mercadopago_payment_id = p_payment_id,
    mercadopago_status = p_payment_status,
    reversed_movement_id = v_movement_id,
    reversal_shortfall_amount = v_shortfall,
    admin_notes = nullif(v_notes, ''),
    updated_at = now()
  where id = p_topup_id;

  topup_status := 'revertido';
  movement_id := v_movement_id;
  resulting_balance := greatest(v_balance - v_debit, 0);
  shortfall_amount := v_shortfall;
  return next;
end;
$function$;

revoke execute on function public.reverse_customer_credit_topup(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.reverse_customer_credit_topup(uuid, text, text, text)
  to service_role;

-- P1 (segunda vuelta): 'revertido' debe ser terminal. Sin este guard, un
-- 'approved' que llegara DESPUÉS de una reversa (reentrega tardía de MP,
-- notificación fuera de orden) hacía que credit_customer_credit_topup_from_mercadopago
-- cayera en su rama normal de acreditación: create_customer_credit_movement
-- no duplica el saldo (mismo source_key que el crédito original), pero el
-- UPDATE final SÍ volvía a fijar customer_credit_topups.status = 'acreditado'
-- -- una carga ya devuelta por MP quedaba mostrando "acreditado" otra vez,
-- aunque el saldo real (ya debitado por la reversa) no cambiara. Idéntico
-- resto de la función: misma firma, mismos checks, mismo camino de
-- acreditación cuando corresponde.
CREATE OR REPLACE FUNCTION public.credit_customer_credit_topup_from_mercadopago(p_topup_id uuid, p_payment_id text, p_payment_status text, p_paid_amount numeric)
 RETURNS TABLE(topup_status text, movement_id uuid, resulting_balance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_topup public.customer_credit_topups%rowtype;
  v_paid_amount numeric(12, 2);
  v_movement_id uuid;
  v_resulting_balance numeric(12, 2);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select *
  into v_topup
  from public.customer_credit_topups
  where id = p_topup_id
  for update;

  if not found then
    raise exception 'TOPUP_NOT_FOUND';
  end if;

  if v_topup.payment_method <> 'mercadopago' then
    raise exception 'INVALID_TOPUP_PAYMENT_METHOD';
  end if;

  if p_payment_status <> 'approved' then
    raise exception 'PAYMENT_NOT_APPROVED';
  end if;

  if nullif(trim(coalesce(p_payment_id, '')), '') is null then
    raise exception 'PAYMENT_ID_REQUIRED';
  end if;

  -- Terminal: una carga ya revertida (refund/chargeback) NUNCA vuelve a
  -- 'acreditado' sola. Queda auditado en admin_notes (una sola vez por
  -- payment_id) y requiere reconciliación administrativa explícita para
  -- reabrirse -- no la hace esta función.
  if v_topup.status = 'revertido' then
    if position(p_payment_id in coalesce(v_topup.admin_notes, '')) = 0 then
      update public.customer_credit_topups
      set
        admin_notes = trim(
          coalesce(admin_notes, '') ||
          E'\n[Alerta] Mercado Pago informó approved (payment ' || p_payment_id ||
          ') DESPUÉS de una reversa ya aplicada -- NO se volvió a acreditar saldo. Requiere revisión manual.'
        ),
        updated_at = now()
      where id = v_topup.id;
    end if;

    topup_status := 'revertido';
    movement_id := v_topup.reversed_movement_id;
    resulting_balance := public.get_customer_credit_balance(v_topup.user_id);
    return next;
    return;
  end if;

  if v_topup.status = 'acreditado' then
    if v_topup.mercadopago_payment_id is distinct from p_payment_id then
      raise exception 'TOPUP_ALREADY_CREDITED_BY_DIFFERENT_PAYMENT';
    end if;

    topup_status := v_topup.status;
    movement_id := v_topup.credited_movement_id;
    resulting_balance := public.get_customer_credit_balance(v_topup.user_id);
    return next;
    return;
  end if;

  v_paid_amount := round(coalesce(p_paid_amount, 0)::numeric, 2);

  if v_topup.amount is null
     or v_topup.gross_amount is null
     or abs(v_paid_amount - v_topup.gross_amount) > 0.01 then
    raise exception 'PAYMENT_AMOUNT_MISMATCH';
  end if;

  select created.movement_id, created.resulting_balance
  into v_movement_id, v_resulting_balance
  from public.create_customer_credit_movement(
    p_user_id => v_topup.user_id,
    p_movement_type => 'credit',
    p_amount => v_topup.amount,
    p_description => 'Carga de saldo acreditada automáticamente por Mercado Pago',
    p_source_type => 'admin_adjustment',
    p_source_id => v_topup.id::text,
    p_created_by => null,
    p_metadata => jsonb_build_object(
      'created_from', 'mercadopago_webhook',
      'source_kind', 'balance_topup',
      'topup_id', v_topup.id,
      'mercadopago_payment_id', p_payment_id,
      'gross_amount', v_topup.gross_amount,
      'surcharge_percent', v_topup.surcharge_percent,
      'surcharge_amount', v_topup.surcharge_amount
    ),
    p_source_key => 'customer-credit-topup-mp:' || v_topup.id::text
  ) as created;

  update public.customer_credit_topups
  set
    status = 'acreditado',
    credited_movement_id = v_movement_id,
    mercadopago_payment_id = p_payment_id,
    mercadopago_status = p_payment_status,
    updated_at = now()
  where id = v_topup.id;

  topup_status := 'acreditado';
  movement_id := v_movement_id;
  resulting_balance := v_resulting_balance;
  return next;
end;
$function$;

revoke execute on function public.credit_customer_credit_topup_from_mercadopago(uuid, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.credit_customer_credit_topup_from_mercadopago(uuid, text, text, numeric)
  to service_role;

notify pgrst, 'reload schema';

commit;
