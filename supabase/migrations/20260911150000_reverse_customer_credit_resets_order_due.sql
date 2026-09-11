-- P1: reverse_customer_credit_for_order devolvía el saldo al cliente pero
-- dejaba ordenes.credit_balance_used / external_amount_due /
-- credit_balance_movement_id / payment_composition con los valores previos
-- a la reversión (payment_composition.parts incluido: ver más abajo).
--
-- Escenario confirmado: pedido con saldo ($30.000) + Mercado Pago ($70.000).
-- MP rechaza/cancela -> se reintegra el saldo (correcto), pero la orden sigue
-- mostrando credit_balance_used=$30.000 y external_amount_due=$70.000 y queda
-- en estado pagable (estado/financial_status no cambian acá). Un segundo
-- intento de pago de MP sobre la MISMA preferencia/external_reference (normal
-- en Checkout Pro: reintentar con otra tarjeta genera un payment_id distinto
-- sin pasar de nuevo por create-preference) que apruebe exactamente esos
-- $70.000 confirma la orden como pagada en su totalidad
-- (processApprovedMercadoPagoOrderPayment compara contra external_amount_due),
-- sin volver a cobrar los $30.000 ya reintegrados a la billetera del cliente.
--
-- Corrección: dentro de la misma transacción/lock (`for update` ya tomado
-- sobre la orden), al reintegrar el saldo también se resetea el importe
-- pendiente de la orden a su total completo. Así, cualquier pago posterior
-- por el monto viejo (reducido) cae en amount_mismatch en vez de confirmar
-- la orden. No cambia firma, permisos, locks, idempotencia (source_key) ni
-- el resto de la lógica de la función.

begin;

CREATE OR REPLACE FUNCTION public.reverse_customer_credit_for_order(p_order_id bigint, p_description text DEFAULT 'Reintegro de saldo a favor por cancelación'::text, p_created_by uuid DEFAULT NULL::uuid)
 RETURNS TABLE(movement_id uuid, restored_amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_order public.ordenes%rowtype;
  v_amount numeric(12, 2);
  v_balance numeric(12, 2);
  v_source_key text;
  v_existing public.customer_credit_movements%rowtype;
  v_movement public.customer_credit_movements%rowtype;
  v_full_amount_due numeric(12, 2);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'No tenés permisos para revertir saldo.';
  end if;

  if p_order_id is null then
    raise exception 'ORDER_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtext('order-credit-reversal:' || p_order_id::text));

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  v_amount := round(coalesce(v_order.credit_balance_used, 0)::numeric, 2);

  if v_order.usuario_id is null or v_amount <= 0 then
    movement_id := null;
    restored_amount := 0;
    return next;
    return;
  end if;

  v_source_key := 'order:' || p_order_id || ':customer-credit:reversal';

  select *
  into v_existing
  from public.customer_credit_movements
  where source_key = v_source_key
  limit 1;

  if found then
    movement_id := v_existing.id;
    restored_amount := v_existing.amount;
    return next;
    return;
  end if;

  select public.get_customer_credit_balance(v_order.usuario_id)
  into v_balance;

  insert into public.customer_credit_movements (
    user_id,
    movement_type,
    amount,
    description,
    source_type,
    source_id,
    order_id,
    created_by,
    related_movement_id,
    source_key,
    resulting_balance,
    metadata
  ) values (
    v_order.usuario_id,
    'reversal',
    v_amount,
    coalesce(nullif(trim(p_description), ''), 'Reintegro de saldo a favor por cancelación'),
    'reversal',
    p_order_id::text,
    p_order_id,
    p_created_by,
    v_order.credit_balance_movement_id,
    v_source_key,
    v_balance + v_amount,
    jsonb_build_object(
      'order_id', p_order_id,
      'reversed_movement_id', v_order.credit_balance_movement_id
    )
  )
  returning *
  into v_movement;

  -- El saldo ya volvió a la billetera: la orden deja de tener crédito
  -- aplicado y su pendiente vuelve a ser el total completo. Sin esto, un
  -- pago posterior por el monto reducido (external_amount_due viejo)
  -- confirmaría la orden sin haber cobrado la diferencia ya reintegrada.
  --
  -- payment_composition.parts también se resetea a '[]': lo arma
  -- getPaymentComposition() (lib/customer-credit.ts) sólo al crear la orden,
  -- con el label del medio de pago externo -- reproducir ese mapeo acá
  -- duplicaría esa lógica en SQL. Dejarlo con el desglose viejo ($30.000
  -- saldo + $70.000 MP) sería peor: quedaría contradiciendo a los campos de
  -- nivel superior de ese mismo JSON, que si se resetean a 0 / total
  -- completo. Ningún consumidor actual lee payment_composition.parts
  -- (verificado: sin matches en app/, components/, hooks/), así que vaciarlo
  -- no rompe ninguna pantalla existente.
  v_full_amount_due := greatest(coalesce(v_order.original_total, v_order.total, 0), 0);

  update public.ordenes
  set
    credit_balance_used = 0,
    external_amount_due = v_full_amount_due,
    credit_balance_movement_id = null,
    payment_composition = coalesce(payment_composition, '{}'::jsonb) ||
      jsonb_build_object(
        'credit_balance_used', 0,
        'external_amount_due', v_full_amount_due,
        'parts', '[]'::jsonb,
        'credit_movement_id', null,
        'credit_reversal_movement_id', v_movement.id
      )
  where id = p_order_id;

  movement_id := v_movement.id;
  restored_amount := v_movement.amount;
  return next;
end;
$function$;

revoke execute on function public.reverse_customer_credit_for_order(bigint,text,uuid)
  from public, anon, authenticated;
grant execute on function public.reverse_customer_credit_for_order(bigint,text,uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
