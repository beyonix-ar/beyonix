-- Una NC parcial autorizada sólo habilita el importe externo de esa NC.
-- MP parcial no usa el refund total existente: requiere registro manual.
create or replace function public.reserve_order_financial_resolution(
  p_order_id bigint,p_actor_id uuid,p_choice text
) returns public.order_financial_resolutions
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_order public.ordenes%rowtype; v_row public.order_financial_resolutions%rowtype;
  v_amount numeric; v_paid_amount numeric; v_note_amount numeric; v_role text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FINANCIAL_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id=p_actor_id;
  if coalesce(v_role,'') not in ('admin','super_admin') then raise exception 'FINANCIAL_FORBIDDEN'; end if;
  if p_choice not in ('beyonix_credit','mercadopago_refund','manual_refund') then raise exception 'FINANCIAL_INVALID_CHOICE'; end if;
  select * into v_order from public.ordenes where id=p_order_id for update;
  if not found then raise exception 'FINANCIAL_ORDER_NOT_FOUND'; end if;
  select * into v_row from public.order_financial_resolutions where order_id=p_order_id for update;
  if found then
    if v_row.choice<>p_choice then raise exception 'FINANCIAL_CHOICE_CONFLICT'; end if;
    return v_row;
  end if;
  if v_order.financial_status is distinct from 'refund_pending' or v_order.andreani_handed_over_at is not null
     or v_order.paid_at is null or v_order.payment_status not in ('approved','confirmed','confirmado') then
    raise exception 'FINANCIAL_NOT_PENDING';
  end if;
  if public.order_was_prepared_for_dispatch(p_order_id) and p_choice<>'manual_refund' then
    raise exception 'FINANCIAL_PREPARED_MANUAL_ONLY';
  end if;
  if p_choice='mercadopago_refund' and v_order.payment_method_id is distinct from 'mercadopago' then
    raise exception 'FINANCIAL_INVALID_PAYMENT_METHOD';
  end if;
  if p_choice='beyonix_credit' and v_order.usuario_id is null then raise exception 'FINANCIAL_NO_ACCOUNT'; end if;
  v_paid_amount := coalesce(nullif(v_order.payment_confirmed_amount,0),nullif(v_order.external_amount_due,0));
  if v_paid_amount is null or v_paid_amount<=0 then raise exception 'FINANCIAL_AMOUNT_INVALID'; end if;
  select coalesce(sum(total_amount),0) into v_note_amount from public.order_credit_notes
    where order_id=p_order_id and status='authorized' and destination='external_refund'
      and settlement_status is distinct from 'completado' and cae is not null;
  if v_note_amount>v_paid_amount then raise exception 'FINANCIAL_AMOUNT_INVALID'; end if;
  if p_choice='manual_refund' and v_order.payment_method_id is distinct from 'transferencia' and
     not (v_order.payment_method_id='mercadopago' and
       (public.order_was_prepared_for_dispatch(p_order_id) or (v_note_amount>0 and v_note_amount<v_paid_amount))) then
    raise exception 'FINANCIAL_INVALID_PAYMENT_METHOD';
  end if;
  v_amount := case when p_choice='manual_refund' and v_note_amount>0 then v_note_amount else v_paid_amount end;
  if p_choice='mercadopago_refund' and (v_paid_amount>40000 or nullif(btrim(v_order.payment_id),'') is null
      or (v_note_amount>0 and v_note_amount<>v_paid_amount)) then
    raise exception 'FINANCIAL_MP_INELIGIBLE';
  end if;
  if p_choice='mercadopago_refund' and (
     lower(coalesce(v_order.estado,'')) in ('enviado','en_camino','visita_fallida','en_sucursal','retiro_pendiente','retiro_vencido','en_devolucion','devuelto_beyonix','entregado')
     or nullif(btrim(v_order.tracking_number),'') is not null
     or nullif(btrim(v_order.andreani_tracking),'') is not null
     or nullif(btrim(v_order.andreani_envio_id),'') is not null
  ) then raise exception 'FINANCIAL_RETURN_REQUIRED'; end if;
  if p_choice='beyonix_credit' and exists(select 1 from public.order_credit_notes
       where order_id=p_order_id and status='authorized' and destination='customer_balance' and cae is not null) then
    raise exception 'FINANCIAL_ALREADY_MOVING';
  end if;
  if exists(select 1 from public.order_refund_proofs where order_id=p_order_id) or
     exists(select 1 from public.mercadopago_order_refunds where order_id=p_order_id and status in ('confirmed','processing','needs_reconciliation')) then
    raise exception 'FINANCIAL_ALREADY_MOVING';
  end if;
  insert into public.order_financial_resolutions(order_id,choice,amount,selected_by)
    values(p_order_id,p_choice,v_amount,p_actor_id) returning * into v_row;
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
    values(p_order_id,'admin',p_actor_id,'financial_resolution_selected',v_order.financial_status,'reserved',
      jsonb_build_object('choice',p_choice,'amount',v_amount,'resolutionId',v_row.id));
  return v_row;
end;
$$;
revoke all on function public.reserve_order_financial_resolution(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_order_financial_resolution(bigint,uuid,text) to service_role;

notify pgrst, 'reload schema';
