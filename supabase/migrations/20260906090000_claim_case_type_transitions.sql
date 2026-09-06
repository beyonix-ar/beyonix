-- Reauditoría: impide cerrar cancelaciones por PATCH genérico y convertir
-- consultas en reclamos económicos. No modifica registros históricos.
begin;
create or replace function public.mutate_admin_order_claim(p_claim_id bigint,p_actor_id uuid,p_expected_updated_at timestamptz,p_patch jsonb)
returns public.order_claims language plpgsql security definer set search_path=public as $$
declare
  v_claim public.order_claims%rowtype;
  v_order public.ordenes%rowtype;
  v_role text;
  v_status text;
  v_resolution text;
  v_action text:=coalesce(p_patch->>'action','update');
  v_message text:=btrim(coalesce(p_patch->>'admin_response',''));
  v_before text;
  v_items jsonb;
  v_item jsonb;
  v_allowed text[];
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CLAIM_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id=p_actor_id;
  if coalesce(v_role,'') not in ('operador','admin','super_admin') then raise exception 'CLAIM_FORBIDDEN'; end if;
  select * into v_order from public.ordenes where id=(select order_id from public.order_claims where id=p_claim_id) for update;
  select * into v_claim from public.order_claims where id=p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if p_expected_updated_at is null or v_claim.updated_at<>p_expected_updated_at then raise exception 'CLAIM_CONFLICT'; end if;
  if v_claim.status in ('cerrado','rechazado') then raise exception 'CLAIM_TERMINAL'; end if;
  if length(v_message)>2000 then raise exception 'CLAIM_INVALID'; end if;
  v_before:=v_claim.status;
  v_status:=coalesce(p_patch->>'status',v_claim.status);
  v_resolution:=coalesce(p_patch->>'resolution',v_claim.resolution);
  -- Las consultas y cancelaciones conservan su circuito propio.
  if v_claim.failure_type='consulta_pedido' and
    (v_action<>'update' or v_status not in ('recibido','en_revision','falta_informacion','cerrado','rechazado') or coalesce(v_resolution,'otro') not in ('otro','rechazado')) then raise exception 'CLAIM_INVALID'; end if;
  if v_claim.failure_type='cancelar_compra' and v_action='update' and
    (v_status is distinct from v_claim.status and v_status not in ('en_revision','falta_informacion') or v_resolution is distinct from v_claim.resolution) then raise exception 'CLAIM_CANCELLATION_ACTION'; end if;
  if v_action='affected_items' then
    if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
    if coalesce(v_claim.failure_type,'') in ('consulta_pedido','cancelar_compra') then raise exception 'CLAIM_INVALID'; end if;
    v_items:=p_patch->'items';
    if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items)=0 or (select count(distinct x->>'order_item_id') from jsonb_array_elements(v_items) x)<>jsonb_array_length(v_items) then raise exception 'CLAIM_INVALID_ITEMS'; end if;
    perform id from public.orden_items where orden_id=v_order.id order by id for update;
    if exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and status in ('processing','authorized')) then raise exception 'CLAIM_ITEMS_LOCKED'; end if;
    for v_item in select * from jsonb_array_elements(v_items) loop
      if not exists(select 1 from public.orden_items where id=(v_item->>'order_item_id')::bigint and orden_id=v_order.id and (v_item->>'quantity')::integer between 1 and cantidad) then raise exception 'CLAIM_INVALID_ITEMS'; end if;
    end loop;
    if exists(select 1 from public.orden_items i where i.orden_id=v_order.id and i.return_inventory_processed_at is not null and
      (select x->>'quantity' from jsonb_array_elements(v_claim.affected_items) x where (x->>'order_item_id')::bigint=i.id) is distinct from
      (select x->>'quantity' from jsonb_array_elements(v_items) x where (x->>'order_item_id')::bigint=i.id)) then raise exception 'CLAIM_ITEMS_LOCKED'; end if;
    update public.order_claims set affected_items=v_items,affected_items_updated_at=now(),affected_items_updated_by=p_actor_id where id=v_claim.id;
  else
    if v_action='approve_cancellation' then
      if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
      perform public.approve_order_claim_cancellation(v_claim.id,p_actor_id,v_role,v_message);
      v_status:='cerrado'; v_resolution:='otro'; v_message:='';
    elsif v_action='reject_cancellation' then
      if v_claim.failure_type is distinct from 'cancelar_compra' or length(v_message)<5 then raise exception 'CLAIM_INVALID'; end if;
      v_status:='rechazado'; v_resolution:='rechazado';
    elsif v_action='mark_credit_note_issued' then
      if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
      if coalesce(v_claim.resolution,'') not in ('cupon_descuento','saldo_a_favor') or not exists(
        select 1 from public.order_credit_notes n join public.customer_credit_movements m on m.order_id=n.order_id and m.claim_id=n.claim_id
        where n.claim_id=v_claim.id and n.status='authorized' and n.destination='customer_balance' and n.cae is not null and n.settlement_status='completado' and m.source_type='credit_note' and m.movement_type='credit'
      ) or exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and (status='processing' or status='authorized' and settlement_status is distinct from 'completado')) then raise exception 'CLAIM_CREDIT_PENDING'; end if;
      v_status:='cerrado'; v_resolution:=v_claim.resolution;
      v_message:='La nota de crédito fue autorizada y el saldo ya está acreditado en tu cuenta.';
    elsif v_action='mark_refund_done' then
      if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
      if coalesce(v_claim.resolution,'') not in ('reintegro_total','reintegro_parcial') or v_order.financial_status is distinct from 'refunded' or not exists(
        select 1 from public.order_credit_notes n join public.order_refund_proofs f on f.order_id=n.order_id where n.claim_id=v_claim.id and n.status='authorized' and n.destination='external_refund' and n.settlement_status='completado'
      ) then raise exception 'CLAIM_REFUND_PENDING'; end if;
      v_status:='cerrado'; v_resolution:=v_claim.resolution;
      v_message:='El reintegro fue registrado. Podés consultar el comprobante desde el detalle de tu compra.';
    elsif v_action<>'update' then raise exception 'CLAIM_INVALID';
    end if;
    v_allowed:=case v_claim.status
      when 'recibido' then array['en_revision','falta_informacion','aprobado','reintegro_pendiente','rechazado','cerrado']
      when 'en_revision' then array['falta_informacion','aprobado','reintegro_pendiente','rechazado','cerrado']
      when 'falta_informacion' then array['en_revision','aprobado','reintegro_pendiente','rechazado','cerrado']
      when 'aprobado' then array['cambio_pendiente','cupon_pendiente','rechazado','cerrado']
      else array['cerrado','rechazado'] end;
    if v_status<>v_claim.status and not v_status=any(v_allowed) then raise exception 'CLAIM_TRANSITION'; end if;
    if v_role='operador' and (p_patch ? 'credit_note_amount' or (v_resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento','cambio_producto','envio_unidad_faltante') and (v_status<>v_claim.status or v_resolution is distinct from v_claim.resolution))) then raise exception 'CLAIM_FORBIDDEN'; end if;
    if v_claim.resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento') and v_resolution is distinct from v_claim.resolution and v_claim.status not in ('recibido','en_revision','falta_informacion') and
      not (v_status='rechazado' and not exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and status in ('processing','authorized'))) then raise exception 'CLAIM_RESOLUTION_LOCKED'; end if;
    if v_status='cerrado' and v_resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento') and v_action not in ('mark_refund_done','mark_credit_note_issued') then raise exception 'CLAIM_ECONOMIC_CLOSE'; end if;
    if v_status in ('aprobado','reintegro_pendiente','cambio_pendiente','cupon_pendiente','cerrado') and (v_resolution is null or v_resolution='rechazado') then raise exception 'CLAIM_INVALID'; end if;
    if v_status='reintegro_pendiente' and v_resolution not in ('reintegro_total','reintegro_parcial') then raise exception 'CLAIM_INVALID'; end if;
    if v_status='cupon_pendiente' and v_resolution not in ('cupon_descuento','saldo_a_favor') then raise exception 'CLAIM_INVALID'; end if;
    if v_resolution='rechazado' and v_status<>'rechazado' then raise exception 'CLAIM_INVALID'; end if;
    if v_status='rechazado' and (v_resolution<>'rechazado' or length(coalesce(nullif(p_patch->>'rejection_reason',''),v_message))<5) then raise exception 'CLAIM_INVALID'; end if;
    if p_patch ? 'credit_note_amount' then
      if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
      if v_action<>'update' or v_status<>'aprobado' or v_resolution is distinct from 'cupon_descuento' or exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and status in ('processing','authorized')) then raise exception 'CLAIM_INVALID_AMOUNT'; end if;
      if (p_patch->>'credit_note_amount')::numeric<=0 or (p_patch->>'credit_note_amount')::numeric > v_order.total-coalesce((select sum(total_amount) from public.order_credit_notes where order_id=v_order.id and status in ('processing','authorized')),0) then raise exception 'CLAIM_INVALID_AMOUNT'; end if;
      update public.ordenes set credit_note_required=true,credit_note_amount=(p_patch->>'credit_note_amount')::numeric where id=v_order.id;
    end if;
    if v_action<>'approve_cancellation' then
      update public.order_claims set status=v_status,resolution=v_resolution,
        admin_response=case when p_patch ? 'admin_response' or v_action in ('mark_refund_done','mark_credit_note_issued') then nullif(v_message,'') else admin_response end,
        rejection_reason=case when v_status='rechazado' then coalesce(nullif(p_patch->>'rejection_reason',''),v_message) else rejection_reason end,
        closed_at=case when v_status in ('cerrado','rechazado') then now() else null end,
        refund_completed_at=case when v_action='mark_refund_done' then now() else refund_completed_at end,
        refund_completed_by=case when v_action='mark_refund_done' then p_actor_id else refund_completed_by end,
        first_reviewed_at=case when v_claim.status='recibido' and v_status='en_revision' then now() else first_reviewed_at end,
        first_reviewed_by=case when v_claim.status='recibido' and v_status='en_revision' then p_actor_id else first_reviewed_by end,
        admin_needs_action=case when v_status in ('cerrado','rechazado') or v_claim.status='recibido' and v_status='en_revision' then false else admin_needs_action end
      where id=v_claim.id;
      if length(v_message)>0 and (coalesce((p_patch->>'append_message')::boolean,false) or v_message is distinct from v_claim.admin_response) then
        insert into public.order_claim_messages(claim_id,author_user_id,author_role,message) values(v_claim.id,p_actor_id,v_role,v_message);
      elsif v_status in ('cerrado','rechazado') then
        insert into public.order_claim_messages(claim_id,author_user_id,author_role,message) values(v_claim.id,p_actor_id,v_role,case when v_status='cerrado' then 'BEYONIX finalizó el reclamo.' else 'BEYONIX rechazó el reclamo: '||coalesce(p_patch->>'rejection_reason',v_message) end);
      end if;
    end if;
  end if;
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
  values(v_order.id,'admin',p_actor_id,'claim_'||v_action,v_before,v_status,jsonb_build_object('claimId',v_claim.id,'previousResolution',v_claim.resolution,'newResolution',v_resolution,'previousItems',case when v_action='affected_items' then v_claim.affected_items end,'affectedItems',v_items));
  select * into v_claim from public.order_claims where id=v_claim.id;
  return v_claim;
end $$;
revoke all on function public.mutate_admin_order_claim(bigint,uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.mutate_admin_order_claim(bigint,uuid,timestamptz,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
