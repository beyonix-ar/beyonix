begin;

-- Same order row lock as admin_cancel_order. All decisions use the locked row.
create or replace function public.review_manual_transfer_payment(
  p_order_id bigint, p_actor_id uuid, p_expected_status text,
  p_next_status text, p_observation text
)
returns public.ordenes language plpgsql security definer set search_path = public as $$
declare
  v_order public.ordenes%rowtype;
  v_previous text;
  v_observation text := nullif(btrim(p_observation), '');
begin
  if auth.role() is distinct from 'service_role' or not exists (
    select 1 from public.profiles where id = p_actor_id and rol in ('admin', 'super_admin')
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found or v_order.payment_method_id is distinct from 'transferencia' then
    raise exception 'TRANSFER_ORDER_NOT_FOUND';
  end if;
  if v_order.estado = 'cancelado' or v_order.cancelled_at is not null
     or v_order.cancellation_requested_at is not null
     or coalesce(v_order.financial_status, 'pending_payment') not in
        ('pending_payment', 'payment_submitted', 'payment_confirmed') then
    raise exception 'TRANSFER_CANCELLATION_CONFLICT';
  end if;
  if p_next_status is null or p_next_status not in ('pendiente_comprobante', 'en_revision', 'confirmado', 'rechazado') then
    raise exception 'TRANSFER_INVALID_TRANSITION';
  end if;
  -- Read-only retry: no audit, balance reversal, stock refresh or update repeated.
  if v_order.payment_status = p_next_status then return v_order; end if;
  if v_order.payment_status is distinct from p_expected_status then
    raise exception 'TRANSFER_PAYMENT_CONFLICT';
  end if;
  if v_order.payment_status = 'confirmado' or v_order.financial_status = 'payment_confirmed'
     or p_next_status not in ('confirmado', 'rechazado')
     or (coalesce(v_order.payment_status, '') <> 'auto_verified_stock_conflict' and
         (v_order.payment_status is distinct from 'en_revision' or nullif(v_order.payment_proof_url, '') is null)) then
    raise exception 'TRANSFER_INVALID_TRANSITION';
  end if;
  if p_next_status = 'rechazado' and coalesce(length(v_observation), 0) < 3 then
    raise exception 'TRANSFER_REJECTION_REASON_REQUIRED';
  end if;
  v_previous := coalesce(v_order.financial_status, v_order.payment_status, 'pending_payment');
  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  update public.ordenes set
    payment_status = p_next_status,
    estado = case when p_next_status = 'confirmado' then 'pagado' else 'pendiente' end,
    financial_status = case when p_next_status = 'confirmado' then 'payment_confirmed' else 'pending_payment' end,
    paid_at = case when p_next_status = 'confirmado' then coalesce(v_order.paid_at, now()) else null end,
    payment_confirmed_by = case when p_next_status = 'confirmado' then p_actor_id else null end,
    payment_confirmed_at = case when p_next_status = 'confirmado' then now() else null end,
    payment_confirmed_amount = case when p_next_status = 'confirmado' then coalesce(v_order.external_amount_due, v_order.total, 0) else null end,
    payment_confirmation_observation = left(v_observation, 1000),
    order_change_status = case when p_next_status = 'confirmado' then 'change_approved' else v_order.order_change_status end,
    order_change_extra_amount = case when p_next_status = 'confirmado' then 0 else v_order.order_change_extra_amount end
  where id = p_order_id returning * into v_order;
  if p_next_status = 'rechazado' and coalesce(v_order.credit_balance_used, 0) > 0 then
    perform public.reverse_customer_credit_for_order(p_order_id, 'Reintegro de saldo por pago rechazado', p_actor_id);
    select * into v_order from public.ordenes where id = p_order_id;
  end if;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (p_order_id, 'admin', p_actor_id,
    case when p_next_status = 'confirmado' then 'payment_confirmed' else 'payment_status_rechazado' end,
    v_previous, v_order.financial_status,
    jsonb_build_object('observation', v_observation, 'amount', v_order.total,
      'externalAmount', v_order.payment_confirmed_amount, 'creditBalanceUsed', v_order.credit_balance_used,
      'proofUrl', v_order.payment_proof_url, 'proofFileName', v_order.payment_proof_file_name));
  return v_order;
end;
$$;
revoke all on function public.review_manual_transfer_payment(bigint, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.review_manual_transfer_payment(bigint, uuid, text, text, text) to service_role;
notify pgrst, 'reload schema';
commit;
