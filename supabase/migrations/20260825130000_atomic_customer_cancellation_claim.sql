-- Registra la cancelación solicitada por el cliente y su reclamo comercial en
-- la misma transacción. Así, una orden facturada que requiere Nota de Crédito
-- nunca queda cancelada sin el claim que autoriza esa operación fiscal.

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
  'Cancela una orden no despachada y crea atómicamente el claim comercial del cliente.';

notify pgrst, 'reload schema';
