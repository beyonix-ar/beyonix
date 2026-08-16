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
  'Aprueba una cancelación solicitada por reclamo y actualiza orden, saldo, auditoría y reclamo en una única transacción idempotente.';
