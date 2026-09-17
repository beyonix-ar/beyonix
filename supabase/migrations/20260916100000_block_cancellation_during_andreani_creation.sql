-- BLOQUEANTE B1 (auditoría Andreani Parte 1/4): cierra la carrera entre la
-- creación de un envío Andreani y la cancelación del pedido.
--
-- Secuencia reproducida: claim_andreani_shipment_creation (ver
-- 20260906120000_harden_andreani_commercial_and_order_writes.sql) marca
-- andreani_creation_status='claimed' y dispara el POST externo a Andreani.
-- Mientras ese POST está en curso, ninguno de los 3 caminos reales que
-- llevan un pedido a estado='cancelado' verificaba ese claim -- sólo miraban
-- si YA existía tracking/andreani_envio_id, que en ese momento sigue siendo
-- NULL porque Andreani todavía no respondió. Resultado posible: el pedido
-- queda cancelado y, segundos después, createAndreaniShipmentForOrder
-- (lib/andreani/order-shipment.ts) persiste igual la respuesta porque su
-- UPDATE final sólo está cercado por id + claim token, no por el estado del
-- pedido -- pedido cancelado + envío Andreani realmente creado.
--
-- Los 3 caminos que hoy pueden fijar estado='cancelado' (auditados
-- explícitamente, ninguno más existe -- ver también el fixture de test
-- lib/andreani/fixtures/andreani-cancellation-race-schema.sql):
--   1) public.request_customer_order_cancellation_with_claim (cliente,
--      20260825130000_atomic_customer_cancellation_claim.sql)
--   2) public.approve_order_claim_cancellation (admin aprueba un reclamo de
--      cancelación, 20260816120000_atomic_order_claim_cancellation.sql,
--      invocada desde public.mutate_admin_order_claim)
--   3) public.admin_cancel_order (admin cancela/rechaza directo,
--      20260915130000_fix_admin_cancel_order_previous_estado.sql)
--
-- FIX: a las 3 se les agrega, dentro de la MISMA transacción que ya hace
-- `select ... for update` sobre la fila del pedido (el lock ya existente es
-- lo que hace esta comprobación atómica frente al UPDATE de
-- claim_andreani_shipment_creation), un guard que bloquea la cancelación si
-- andreani_creation_status es 'claimed' (creación en curso) o
-- 'reconciliation_required' (resultado externo incierto -- p.ej. timeout o
-- 5xx: Andreani pudo haber creado el envío igual). Nunca se libera el claim,
-- nunca se asume "no hay envío" por andreani_envio_id NULL, nunca se
-- cancela ni reintenta nada contra Andreani acá -- sólo se impide que el
-- pedido pase a cancelado mientras el resultado externo sea ambiguo. Si el
-- envío YA quedó creado (andreani_creation_status='created', con
-- andreani_envio_id seteado), la cancelación sigue las reglas EXISTENTES de
-- despacho (ORDER_ALREADY_DISPATCHED), sin cambios -- ver
-- ORDER_ALREADY_DISPATCHED en cada función, no tocado por esta migración.
--
-- Defensa en profundidad adicional (no la protección principal): el UPDATE
-- final de createAndreaniShipmentForOrder que persiste el resultado del POST
-- ahora también exige `andreani_creation_status = 'claimed'` además de
-- id + claim token, para no pisar un estado que ya fue resuelto por otra
-- vía entre el POST y la persistencia (ver lib/andreani/order-shipment.ts).
--
-- Bytes idénticos a la versión vigente de cada función salvo el guard nuevo
-- (comentado como "-- NUEVO" en cada una) y grants/comment, que se
-- reafirman sin cambios.

create or replace function public.request_customer_order_cancellation_with_claim(
  p_order_id bigint,
  p_user_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_claim public.order_claims%rowtype;
  v_now timestamptz := now();
  v_payment_confirmed boolean;
  v_proof_pending boolean;
  v_invoiced boolean;
  v_next_financial_status text;
  v_previous_financial_status text;
  v_affected_items jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cancelar esta compra.';
  end if;

  if p_order_id is null or p_user_id is null
     or length(trim(coalesce(p_reason, ''))) not between 5 and 600 then
    raise exception 'INVALID_CANCELLATION_REQUEST';
  end if;

  select * into v_order
  from public.ordenes
  where id = p_order_id
    and usuario_id = p_user_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if lower(coalesce(v_order.estado, '')) = 'cancelado'
     or lower(coalesce(v_order.financial_status, '')) in (
       'cancelled', 'refund_pending', 'refunded'
     ) then
    raise exception 'ORDER_ALREADY_CANCELLED';
  end if;

  -- NUEVO: creación Andreani en curso o con resultado externo incierto --
  -- no liberar el claim, no asumir que no existe envío por
  -- andreani_envio_id NULL. Si ya quedó 'created' (con andreani_envio_id
  -- seteado), el guard de despacho de más abajo ya lo cubre sin cambios.
  if v_order.andreani_creation_status = 'claimed' then
    raise exception 'ANDREANI_CREATION_IN_PROGRESS';
  end if;
  if v_order.andreani_creation_status = 'reconciliation_required' then
    raise exception 'ANDREANI_RECONCILIATION_REQUIRED';
  end if;

  if lower(coalesce(v_order.estado, '')) in (
       'enviado', 'en_camino', 'visita_fallida', 'en_sucursal',
       'retiro_pendiente', 'retiro_vencido', 'en_devolucion',
       'devuelto_beyonix', 'entregado'
     )
     or nullif(btrim(coalesce(v_order.tracking_number, '')), '') is not null
     or nullif(btrim(coalesce(v_order.andreani_tracking, '')), '') is not null
     or nullif(btrim(coalesce(v_order.andreani_envio_id, '')), '') is not null then
    raise exception 'ORDER_ALREADY_DISPATCHED';
  end if;

  v_payment_confirmed :=
    v_order.paid_at is not null
    or coalesce(v_order.payment_confirmed_amount, 0) > 0
    or lower(coalesce(v_order.payment_status, '')) in (
      'confirmado', 'approved', 'confirmed'
    )
    or lower(coalesce(v_order.financial_status, '')) = 'payment_confirmed';
  v_proof_pending :=
    nullif(btrim(coalesce(v_order.payment_proof_url, '')), '') is not null
    and lower(coalesce(v_order.payment_status, '')) in (
      'en_revision', 'pendiente_comprobante', 'pending'
    );
  v_invoiced :=
    v_order.invoice_status in ('authorized', 'processing')
    or v_order.invoice_cae is not null
    or (v_order.invoice_number is not null and v_order.invoice_point is not null);
  v_next_financial_status := case
    when v_payment_confirmed then 'refund_pending'
    when v_proof_pending then 'cancellation_requested'
    else 'cancelled'
  end;
  v_previous_financial_status := coalesce(
    v_order.financial_status,
    v_order.payment_status,
    'pending_payment'
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'order_item_id', oi.id,
        'quantity', oi.cantidad
      ) order by oi.id
    ),
    '[]'::jsonb
  ) into v_affected_items
  from public.orden_items oi
  where oi.orden_id = v_order.id;

  insert into public.order_claims (
    order_id,
    user_id,
    claim_type,
    status,
    failure_type,
    started_at,
    description,
    resolution,
    offered_resolutions,
    admin_needs_action,
    last_customer_message_at,
    affected_items,
    closed_at
  ) values (
    v_order.id,
    p_user_id,
    'transporte_48hs',
    case
      when v_payment_confirmed then 'reintegro_pendiente'
      when v_proof_pending then 'en_revision'
      else 'cerrado'
    end,
    'cancelar_compra',
    v_now,
    trim(p_reason),
    case when v_payment_confirmed then 'reintegro_total' else 'otro' end,
    '[]'::jsonb,
    v_payment_confirmed or v_proof_pending,
    v_now,
    v_affected_items,
    case when not v_payment_confirmed and not v_proof_pending then v_now else null end
  )
  returning * into v_claim;

  update public.ordenes
  set
    estado = 'cancelado',
    cancelled_at = v_now,
    financial_status = v_next_financial_status,
    cancellation_requested_at = v_now,
    cancellation_requested_by = p_user_id,
    refund_pending_at = case when v_payment_confirmed then v_now else null end,
    credit_note_required = v_payment_confirmed and v_invoiced
  where id = v_order.id
  returning * into v_order;

  if coalesce(v_order.credit_balance_used, 0) > 0 then
    perform *
    from public.reverse_customer_credit_for_order(
      v_order.id,
      'Reintegro de saldo por cancelación de compra',
      p_user_id
    );
  end if;

  insert into public.order_audit_events (
    order_id,
    actor_type,
    actor_id,
    action,
    previous_status,
    new_status,
    metadata
  ) values (
    v_order.id,
    'customer',
    p_user_id,
    case
      when v_payment_confirmed then 'cancellation_requested_refund_pending'
      else 'cancellation_requested'
    end,
    v_previous_financial_status,
    v_next_financial_status,
    jsonb_build_object(
      'claimId', v_claim.id,
      'cancellationReason', trim(p_reason),
      'invoiceIssued', v_invoiced,
      'creditNoteRequired', v_payment_confirmed and v_invoiced,
      'source', 'customer_cancellation'
    )
  );

  insert into public.order_claim_messages (
    claim_id,
    author_user_id,
    author_role,
    message
  ) values (
    v_claim.id,
    p_user_id,
    'cliente',
    trim(p_reason)
  );

  return to_jsonb(v_order) || jsonb_build_object('claim_id', v_claim.id);
end;
$$;

revoke all on function public.request_customer_order_cancellation_with_claim(
  bigint, uuid, text
) from public, anon, authenticated;
grant execute on function public.request_customer_order_cancellation_with_claim(
  bigint, uuid, text
) to service_role;

comment on function public.request_customer_order_cancellation_with_claim(
  bigint, uuid, text
) is
  'Cancela una orden no despachada y crea atómicamente el claim comercial del cliente. Bloquea si hay una creación Andreani en curso (claimed) o con resultado externo incierto (reconciliation_required) -- fix 20260916100000.';

create or replace function public.approve_order_claim_cancellation(
  p_claim_id bigint,
  p_admin_id uuid,
  p_admin_role text,
  p_message text
)
returns public.order_claims
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_order public.ordenes%rowtype;
  v_payment_confirmed boolean;
  v_now timestamptz := now();
  v_message text;
  v_previous_financial_status text;
  v_next_financial_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para aprobar esta cancelación.';
  end if;

  if p_admin_id is null
     or coalesce(p_admin_role, '') not in ('operador', 'admin', 'super_admin') then
    raise exception 'Operador inválido.';
  end if;

  select *
  into v_claim
  from public.order_claims
  where id = p_claim_id
  for update;

  if not found then
    raise exception 'No encontramos la solicitud.';
  end if;

  if v_claim.failure_type is distinct from 'cancelar_compra' then
    raise exception 'Esta acción sólo aplica a solicitudes de cancelación.';
  end if;

  if v_claim.status in ('cerrado', 'rechazado') then
    raise exception 'La solicitud de cancelación ya fue cerrada.';
  end if;

  select *
  into v_order
  from public.ordenes
  where id = v_claim.order_id
  for update;

  if not found then
    raise exception 'No encontramos el pedido asociado.';
  end if;

  if lower(coalesce(v_order.estado, '')) = 'cancelado' then
    raise exception 'El pedido ya fue cancelado.';
  end if;

  -- NUEVO: mismo guard que request_customer_order_cancellation_with_claim y
  -- admin_cancel_order -- ver el comentario de cabecera de esta migración.
  if v_order.andreani_creation_status = 'claimed' then
    raise exception 'ANDREANI_CREATION_IN_PROGRESS';
  end if;
  if v_order.andreani_creation_status = 'reconciliation_required' then
    raise exception 'ANDREANI_RECONCILIATION_REQUIRED';
  end if;

  if v_order.invoice_status in ('authorized', 'processing')
     or v_order.invoice_cae is not null
     or (v_order.invoice_number is not null and v_order.invoice_point is not null) then
    raise exception 'No se puede aprobar la cancelación porque el pedido ya fue facturado.';
  end if;

  if lower(coalesce(v_order.estado, '')) in (
       'enviado',
       'en_camino',
       'visita_fallida',
       'en_sucursal',
       'retiro_pendiente',
       'retiro_vencido',
       'en_devolucion',
       'devuelto_beyonix',
       'entregado'
     )
     or nullif(trim(v_order.tracking_number), '') is not null
     or nullif(trim(v_order.andreani_tracking), '') is not null
     or nullif(trim(v_order.andreani_envio_id), '') is not null
     or exists (
       select 1
       from unnest(array[
         'camino',
         'tránsito',
         'transito',
         'distribución',
         'distribucion',
         'reparto',
         'visita',
         'entregado'
       ]) as dispatched_status(fragment)
       where lower(coalesce(v_order.andreani_estado, '')) like '%' || fragment || '%'
     ) then
    raise exception 'No se puede aprobar la cancelación porque el pedido ya fue despachado.';
  end if;

  v_payment_confirmed :=
    v_order.paid_at is not null
    or coalesce(v_order.payment_status, '') in ('confirmado', 'approved', 'confirmed')
    or coalesce(v_order.estado, '') in (
      'pagado',
      'enviado',
      'en_camino',
      'visita_fallida',
      'en_sucursal',
      'retiro_pendiente',
      'retiro_vencido',
      'en_devolucion',
      'devuelto_beyonix',
      'entregado'
    );
  v_previous_financial_status := coalesce(
    v_order.financial_status,
    v_order.payment_status,
    v_order.estado,
    'pending_payment'
  );
  v_next_financial_status := case
    when v_payment_confirmed then 'refund_pending'
    else 'cancelled'
  end;
  v_message := coalesce(
    nullif(trim(p_message), ''),
    'BEYONIX aprobó la cancelación de la compra.'
  );

  update public.ordenes
  set
    estado = 'cancelado',
    cancelled_at = v_now,
    financial_status = v_next_financial_status,
    cancellation_requested_at = v_now,
    cancellation_requested_by = p_admin_id,
    refund_pending_at = case when v_payment_confirmed then v_now else null end,
    credit_note_required = false
  where id = v_order.id;

  if coalesce(v_order.credit_balance_used, 0) > 0 then
    perform *
    from public.reverse_customer_credit_for_order(
      v_order.id,
      'Reintegro de saldo a favor por cancelación de compra',
      p_admin_id
    );
  end if;

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
    'admin',
    p_admin_id,
    case
      when v_payment_confirmed then 'order_cancelled_refund_pending'
      else 'order_status_changed'
    end,
    v_previous_financial_status,
    v_next_financial_status,
    jsonb_build_object(
      'previousEstado', v_order.estado,
      'newEstado', 'cancelado',
      'source', 'order_claim_cancellation_approved',
      'claimId', v_claim.id
    )
  );

  update public.order_claims
  set
    status = 'cerrado',
    resolution = 'otro',
    admin_response = v_message,
    closed_at = v_now,
    admin_needs_action = false,
    updated_at = v_now
  where id = v_claim.id
  returning *
  into v_claim;

  insert into public.order_claim_messages (
    claim_id,
    author_user_id,
    author_role,
    message
  )
  values (
    v_claim.id,
    p_admin_id,
    p_admin_role,
    v_message
  );

  return v_claim;
end;
$$;

revoke all on function public.approve_order_claim_cancellation(bigint, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.approve_order_claim_cancellation(bigint, uuid, text, text)
  to service_role;

comment on function public.approve_order_claim_cancellation(bigint, uuid, text, text) is
  'Aprueba una cancelación solicitada por reclamo y actualiza orden, saldo, auditoría y reclamo en una única transacción idempotente. Bloquea si hay una creación Andreani en curso (claimed) o con resultado externo incierto (reconciliation_required) -- fix 20260916100000.';

create or replace function public.admin_cancel_order(
  p_order_id bigint,
  p_admin_id uuid,
  p_admin_role text,
  p_action text,
  p_reason_code text,
  p_reason_text text
)
returns public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_payment_confirmed boolean;
  v_now timestamptz := now();
  v_previous_financial_status text;
  v_next_financial_status text;
  v_previous_estado text;
  v_reason_code text;
  v_reason_text text;
  v_action text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cancelar este pedido.';
  end if;

  if p_admin_id is null
     or coalesce(p_admin_role, '') not in ('operador', 'admin', 'super_admin') then
    raise exception 'Operador inválido.';
  end if;

  v_action := lower(coalesce(p_action, ''));
  if v_action not in ('reject', 'cancel') then
    raise exception 'INVALID_ACTION';
  end if;

  v_reason_code := nullif(trim(coalesce(p_reason_code, '')), '');
  v_reason_text := nullif(trim(coalesce(p_reason_text, '')), '');
  if v_reason_code is null
     -- Misma lista real que ADMIN_ORDER_CANCELLATION_REASONS en
     -- lib/orders/admin-order-cancellation-reasons.ts -- defensa en
     -- profundidad, la ruta ya la valida antes de llegar acá.
     or v_reason_code not in (
       'solicitud_cliente',
       'pago_no_recibido',
       'pago_invalido',
       'falta_stock',
       'error_administrativo',
       'otro'
     )
     or length(coalesce(v_reason_text, v_reason_code)) < 3
     or length(coalesce(v_reason_text, '')) > 600 then
    raise exception 'INVALID_REASON';
  end if;

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if lower(coalesce(v_order.estado, '')) = 'cancelado' then
    raise exception 'ORDER_ALREADY_CANCELLED';
  end if;

  -- NUEVO: mismo guard que las otras 2 RPCs de cancelación -- ver el
  -- comentario de cabecera de esta migración.
  if v_order.andreani_creation_status = 'claimed' then
    raise exception 'ANDREANI_CREATION_IN_PROGRESS';
  end if;
  if v_order.andreani_creation_status = 'reconciliation_required' then
    raise exception 'ANDREANI_RECONCILIATION_REQUIRED';
  end if;

  if v_order.invoice_status in ('authorized', 'processing')
     or v_order.invoice_cae is not null
     or (v_order.invoice_number is not null and v_order.invoice_point is not null) then
    raise exception 'ORDER_ALREADY_INVOICED';
  end if;

  if lower(coalesce(v_order.estado, '')) in (
       'enviado',
       'en_camino',
       'visita_fallida',
       'en_sucursal',
       'retiro_pendiente',
       'retiro_vencido',
       'en_devolucion',
       'devuelto_beyonix',
       'entregado'
     )
     or nullif(trim(v_order.tracking_number), '') is not null
     or nullif(trim(v_order.andreani_tracking), '') is not null
     or nullif(trim(v_order.andreani_envio_id), '') is not null
     or exists (
       select 1
       from unnest(array[
         'camino',
         'tránsito',
         'transito',
         'distribución',
         'distribucion',
         'reparto',
         'visita',
         'entregado'
       ]) as dispatched_status(fragment)
       where lower(coalesce(v_order.andreani_estado, '')) like '%' || fragment || '%'
     ) then
    raise exception 'ORDER_ALREADY_DISPATCHED';
  end if;

  -- Misma fórmula EXACTA que lib/orders/order-payment-status.ts
  -- isOrderPaymentConfirmed() -- sin cambios respecto a la versión anterior.
  v_payment_confirmed :=
    v_order.paid_at is not null
    or coalesce(v_order.payment_confirmed_amount, 0) > 0
    or coalesce(v_order.payment_status, '') in ('confirmado', 'approved', 'confirmed')
    or coalesce(v_order.financial_status, '') in ('payment_confirmed', 'refund_pending', 'refunded');

  if v_action = 'reject' and v_payment_confirmed then
    raise exception 'ORDER_ALREADY_PAID_USE_CANCEL';
  end if;

  if v_action = 'cancel' and not v_payment_confirmed then
    raise exception 'ORDER_NOT_PAID_USE_REJECT';
  end if;

  -- Capturado ANTES del UPDATE ... RETURNING de más abajo -- v_order se
  -- reasigna ahí, así que sin esta variable propia quedaría con el valor
  -- YA cancelado (ese era exactamente el bug de 20260915130000).
  v_previous_estado := v_order.estado;
  v_previous_financial_status := coalesce(
    v_order.financial_status,
    v_order.payment_status,
    v_order.estado,
    'pending_payment'
  );
  v_next_financial_status := case
    when v_action = 'cancel' then 'refund_pending'
    else 'cancelled'
  end;

  update public.ordenes
  set
    estado = 'cancelado',
    cancelled_at = v_now,
    financial_status = v_next_financial_status,
    cancellation_requested_at = v_now,
    cancellation_requested_by = p_admin_id,
    refund_pending_at = case when v_action = 'cancel' then v_now else null end,
    credit_note_required = false
  where id = v_order.id
  returning * into v_order;

  if coalesce(v_order.credit_balance_used, 0) > 0 then
    perform *
    from public.reverse_customer_credit_for_order(
      v_order.id,
      case
        when v_action = 'reject' then 'Reintegro de saldo a favor por rechazo de pedido'
        else 'Reintegro de saldo a favor por cancelación de pedido'
      end,
      p_admin_id
    );
  end if;

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
    'admin',
    p_admin_id,
    case
      when v_action = 'reject' then 'order_rejected_by_admin'
      else 'order_cancelled_refund_pending'
    end,
    v_previous_financial_status,
    v_next_financial_status,
    jsonb_build_object(
      'previousEstado', v_previous_estado,
      'newEstado', 'cancelado',
      'source', case
        when v_action = 'reject' then 'admin_direct_rejection'
        else 'admin_direct_cancellation'
      end,
      'reasonCode', v_reason_code,
      'reasonText', coalesce(v_reason_text, v_reason_code)
    )
  );

  return v_order;
end;
$$;

revoke all on function public.admin_cancel_order(bigint, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_cancel_order(bigint, uuid, text, text, text, text)
  to service_role;

comment on function public.admin_cancel_order(bigint, uuid, text, text, text, text) is
  'Rechaza (pago no confirmado) o cancela (pago confirmado) un pedido directamente desde Admin, sin depender de un order_claims previo. Misma transacción atómica/guardas que approve_order_claim_cancellation. Bloquea si hay una creación Andreani en curso (claimed) o con resultado externo incierto (reconciliation_required) -- fix 20260916100000.';

notify pgrst, 'reload schema';
