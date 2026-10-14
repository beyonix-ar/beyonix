-- Saldo a favor usado como medio de pago: también respeta
-- pago confirmado → Factura C → NC C → devolver dinero/saldo.
--
-- HUECO: reverse_customer_credit_for_order restauraba el saldo en el acto, y
-- la llaman todas las cancelaciones (admin_cancel_order, cancelación del
-- cliente con reclamo, aprobación de cancelación por reclamo) en la misma
-- transacción que cancela: el saldo volvía antes de la Factura C y la NC.
--
-- CORRECCIÓN (en base, cubre a todos los callers sin tocarlos):
-- 1. order_customer_credit_reversal_on_hold(): la venta tuvo obligación
--    fiscal (invoice_queued_at = pago confirmado, o ya facturada) y todavía no
--    tiene Factura C con una NC autorizada.
-- 2. reverse_customer_credit_for_order (idéntica a 20260911150000 salvo el
--    bloque NUEVO): con la obligación abierta no restaura; devuelve 0 (igual
--    que "nada para restaurar") y audita el diferimiento una sola vez. Si ya
--    se restauró antes, devuelve ese movimiento (idempotente, source_key).
-- 3. Trigger AFTER en order_credit_notes: cuando una NC pasa a 'authorized'
--    sobre un pedido cancelado con saldo aplicado, restaura el saldo (una sola
--    vez: advisory lock + source_key único). Un error de ARCA deja la NC sin
--    autorizar: el saldo no vuelve y la obligación sigue.
-- Sin pago confirmado no hay obligación: rechazos, vencimientos y checkouts
-- abandonados restauran en el acto, como hasta ahora.

begin;

create or replace function public.order_customer_credit_reversal_on_hold(p_order_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.ordenes o
    where o.id = p_order_id
      and (o.invoice_queued_at is not null or o.invoice_cae is not null)
      and not (
        o.invoice_cae is not null
        and exists (
          select 1 from public.order_credit_notes n
          where n.order_id = o.id and n.status = 'authorized'
        )
      )
  )
$$;

revoke all on function public.order_customer_credit_reversal_on_hold(bigint) from public, anon, authenticated;
grant execute on function public.order_customer_credit_reversal_on_hold(bigint) to service_role;
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

  -- NUEVO (20261014120000): saldo aplicado a una venta cobrada = dinero de la
  -- venta. Pago confirmado → Factura C → NC C → recién ahí vuelve el saldo.
  -- Con la obligación fiscal abierta (encolada o facturada sin NC autorizada)
  -- no se restaura todavía: se difiere y lo hace el trigger de la NC. Un
  -- pedido que nunca tuvo obligación (pago rechazado, checkout vencido) sigue
  -- restaurando en el acto, como siempre.
  if public.order_customer_credit_reversal_on_hold(p_order_id) then
    if not exists (
      select 1 from public.order_audit_events
      where order_id = p_order_id and action = 'customer_credit_reversal_deferred'
    ) then
      insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
      values (p_order_id, 'system', p_created_by, 'customer_credit_reversal_deferred', null, null,
        jsonb_build_object('amount', v_amount, 'reason', 'invoice_and_credit_note_required'));
    end if;
    movement_id := null;
    restored_amount := 0;
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

create or replace function public.restore_customer_credit_after_credit_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from 'authorized'
     or (tg_op = 'UPDATE' and old.status = 'authorized') then
    return new;
  end if;
  -- Sólo la cancelación de la venta restituye el saldo completo; una NC de
  -- devolución parcial sobre un pedido vigente no lo toca.
  if exists (
    select 1 from public.ordenes o
    where o.id = new.order_id
      and coalesce(o.estado, '') = 'cancelado'
      and coalesce(o.credit_balance_used, 0) > 0
  ) then
    perform * from public.reverse_customer_credit_for_order(
      new.order_id,
      'Reintegro de saldo a favor por cancelación (con nota de crédito)',
      new.created_by
    );
  end if;
  return new;
end;
$$;

revoke all on function public.restore_customer_credit_after_credit_note() from public, anon, authenticated;

drop trigger if exists zz_restore_customer_credit_after_credit_note on public.order_credit_notes;
create trigger zz_restore_customer_credit_after_credit_note
  after insert or update of status on public.order_credit_notes
  for each row execute function public.restore_customer_credit_after_credit_note();

notify pgrst, 'reload schema';

commit;