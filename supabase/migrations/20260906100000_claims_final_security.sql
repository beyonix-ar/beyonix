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
  if exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and status in ('processing','authorized')) and
    (v_resolution is distinct from v_claim.resolution or v_status='rechazado') then raise exception 'CLAIM_RESOLUTION_LOCKED'; end if;
  if v_status='cerrado' and exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and
    (status='processing' or status='authorized' and settlement_status is distinct from 'completado')) then raise exception 'CLAIM_CREDIT_PENDING'; end if;
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
        select 1 from public.order_credit_notes n join public.order_refund_proofs f on f.order_id=n.order_id and f.id::text=n.settlement_reference where n.claim_id=v_claim.id and n.status='authorized' and n.destination='external_refund' and n.settlement_status='completado' and n.cae is not null
      ) or exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and (status='processing' or status='authorized' and settlement_status is distinct from 'completado')) then raise exception 'CLAIM_REFUND_PENDING'; end if;
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
    if v_role='operador' and (p_patch ? 'credit_note_amount' or ((v_resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento','cambio_producto','envio_unidad_faltante') or v_claim.resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento','cambio_producto','envio_unidad_faltante')) and (v_status<>v_claim.status or v_resolution is distinct from v_claim.resolution))) then raise exception 'CLAIM_FORBIDDEN'; end if;
    if v_claim.resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento') and v_resolution is distinct from v_claim.resolution and v_claim.status not in ('recibido','en_revision','falta_informacion') and
      not (v_status='rechazado' and not exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and status in ('processing','authorized'))) then raise exception 'CLAIM_RESOLUTION_LOCKED'; end if;
    if v_status='cerrado' and v_resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento') and v_action not in ('mark_refund_done','mark_credit_note_issued') then raise exception 'CLAIM_ECONOMIC_CLOSE'; end if;
    if v_status in ('aprobado','reintegro_pendiente','cambio_pendiente','cupon_pendiente','cerrado') and (v_resolution is null or v_resolution='rechazado') then raise exception 'CLAIM_INVALID'; end if;
    if v_status='cambio_pendiente' and v_resolution not in ('cambio_producto','envio_unidad_faltante','otro') then raise exception 'CLAIM_INVALID'; end if;
    if v_status='reintegro_pendiente' and v_resolution not in ('reintegro_total','reintegro_parcial') then raise exception 'CLAIM_INVALID'; end if;
    if v_status='cupon_pendiente' and v_resolution not in ('cupon_descuento','saldo_a_favor') then raise exception 'CLAIM_INVALID'; end if;
    if v_resolution='rechazado' and v_status<>'rechazado' then raise exception 'CLAIM_INVALID'; end if;
    if v_status='rechazado' and (v_resolution<>'rechazado' or length(coalesce(nullif(p_patch->>'rejection_reason',''),v_message))<5) then raise exception 'CLAIM_INVALID'; end if;
    if p_patch ? 'credit_note_amount' then
      if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
      if v_action<>'update' or v_status<>'aprobado' or v_resolution is distinct from 'cupon_descuento' or exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and status in ('processing','authorized')) then raise exception 'CLAIM_INVALID_AMOUNT'; end if;
      if p_patch->>'credit_note_amount' is null or (p_patch->>'credit_note_amount')::numeric<=0 or (p_patch->>'credit_note_amount')::numeric > v_order.total-coalesce((select sum(total_amount) from public.order_credit_notes where order_id=v_order.id and status in ('processing','authorized')),0) then raise exception 'CLAIM_INVALID_AMOUNT'; end if;
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
        admin_needs_action=case when v_status in ('cerrado','rechazado') or v_status='aprobado' and v_status<>v_claim.status or v_claim.status='recibido' and v_status='en_revision' then false else admin_needs_action end
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


-- Retire unused RPC that bypassed authentication, CAS and canonical inventory.
create or replace function public.approve_order_claim_product_change(p_claim_id bigint,p_admin_id uuid)
returns public.order_claims language plpgsql security definer set search_path=public as $$
begin raise exception 'CLAIM_ACTION_RETIRED'; end $$;
revoke all on function public.approve_order_claim_product_change(bigint,uuid) from public,anon,authenticated,service_role;

-- Transaction-start now() can regress after waiting for another transaction.
create or replace function public.touch_order_claim_updated_at()
returns trigger language plpgsql set search_path=public as $$
begin
  new.updated_at := greatest(clock_timestamp(),old.updated_at+interval '1 microsecond');
  return new;
end $$;
revoke all on function public.touch_order_claim_updated_at() from public,anon,authenticated;
create or replace function public.process_claim_return_inventory(p_claim_id bigint,p_order_id bigint,p_order_item_id bigint,p_restocked_quantity integer,p_written_off_quantity integer,p_note text,p_processed_by uuid)
returns public.orden_items language plpgsql security definer set search_path=public as $$
declare v_claim public.order_claims%rowtype; v_quantity integer; v_result public.orden_items%rowtype;
begin
  if auth.role() is distinct from 'service_role' or not exists(select 1 from public.profiles where id=p_processed_by and rol in ('admin','super_admin')) then raise exception 'CLAIM_FORBIDDEN'; end if;
  perform id from public.ordenes where id=p_order_id for update;
  select * into v_claim from public.order_claims where id=p_claim_id and order_id=p_order_id for update;
  if not found or coalesce(v_claim.failure_type,'') in ('cancelar_compra','consulta_pedido') then raise exception 'CLAIM_INVALID'; end if;
  if v_claim.status in ('cerrado','rechazado') then raise exception 'CLAIM_TERMINAL'; end if;
  select (x->>'quantity')::integer into v_quantity from jsonb_array_elements(v_claim.affected_items) x where (x->>'order_item_id')::bigint=p_order_item_id;
  if v_quantity is null or p_restocked_quantity is null or p_written_off_quantity is null or p_restocked_quantity<0 or p_written_off_quantity<0 or p_restocked_quantity+p_written_off_quantity not between 1 and v_quantity then raise exception 'CLAIM_INVALID_ITEMS'; end if;
  if exists(select 1 from public.order_credit_notes n where n.claim_id=v_claim.id and n.status in ('processing','authorized')) then raise exception 'CLAIM_ITEMS_LOCKED'; end if;
  select * into v_result from public.process_order_item_return_inventory(p_order_id,p_order_item_id,p_restocked_quantity,p_written_off_quantity,p_note,p_processed_by);
  return v_result;
end $$;
revoke all on function public.process_claim_return_inventory(bigint,bigint,bigint,integer,integer,text,uuid) from public,anon,authenticated;
grant execute on function public.process_claim_return_inventory(bigint,bigint,bigint,integer,integer,text,uuid) to service_role;


create or replace function public.notify_customer_claim_message()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_claim public.order_claims%rowtype;
begin
  if new.author_role='cliente' then return new; end if;
  select * into v_claim from public.order_claims where id=new.claim_id;
  if v_claim.user_id is null then return new; end if;
  insert into public.customer_notifications(user_id,type,title,body,action_url,order_id,source_key)
  values(v_claim.user_id,'claim_response','Mensaje de BEYONIX','Tenés una nueva respuesta sobre tu pedido.',
    '/cuenta/compras/'||v_claim.order_id||'/ayuda',v_claim.order_id,'claim-message:'||new.id)
  on conflict(source_key) do nothing;
  return new;
end $$;
-- Una respuesta del cliente en aprobado sigue necesitando atención del Admin.
create or replace function public.clear_resolved_order_claim_attention()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status in ('cerrado','rechazado') then new.admin_needs_action:=false; end if;
  return new;
end $$;
revoke all on function public.notify_customer_claim_message(),public.sync_order_claim_admin_attention(),public.clear_resolved_order_claim_attention() from public,anon,authenticated;
create or replace function public.begin_partial_credit_note(
  p_order_id bigint,
  p_claim_id bigint,
  p_destination text,
  p_reason text,
  p_items_amount numeric,
  p_manual_amount numeric,
  p_total_amount numeric,
  p_invoice_point integer,
  p_invoice_number bigint,
  p_created_by uuid,
  p_items jsonb,
  p_operation_type text
)
returns public.order_credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note public.order_credit_notes;
  v_invoice_total numeric(12, 2);
  v_order_user_id uuid;
  v_committed_total numeric(12, 2);
  v_item jsonb;
  v_order_item public.orden_items;
  v_committed_quantity integer;
  v_actor_role text;
  v_claim public.order_claims%rowtype;
  v_affected_item jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'No tenés permisos para emitir esta nota de crédito.';
  end if;

  select rol into v_actor_role
  from public.profiles
  where id = p_created_by;

  if coalesce(v_actor_role,'') not in ('admin', 'super_admin') then
    raise exception 'CREDIT_NOTE_ACTOR_FORBIDDEN';
  end if;

  if p_operation_type not in (
    'devolucion_parcial',
    'devolucion_total',
    'cambio_producto',
    'cancelacion_antes_despacho',
    'reembolso_excepcional',
    'ajuste_manual'
  ) then
    raise exception 'INVALID_CREDIT_NOTE_OPERATION_TYPE';
  end if;

  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_CREDIT_NOTE_ITEM';
  end if;

  perform pg_advisory_xact_lock(91091, p_order_id::integer);

  -- Expiry cannot prove ARCA did not authorize the previous request.
  if exists(select 1 from public.order_credit_notes where order_id=p_order_id and status='processing') then
    raise exception 'CREDIT_NOTE_PROCESSING_IN_PROGRESS';
  end if;

  if p_destination not in ('external_refund', 'customer_balance', 'none') then
    raise exception 'INVALID_CREDIT_NOTE_DESTINATION';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'CREDIT_NOTE_REASON_REQUIRED';
  end if;

  if round(coalesce(p_total_amount, 0), 2) <= 0
     or round(coalesce(p_total_amount, 0), 2)
        <> round(coalesce(p_items_amount, 0) + coalesce(p_manual_amount, 0), 2) then
    raise exception 'INVALID_CREDIT_NOTE_AMOUNT';
  end if;

  if p_operation_type in ('ajuste_manual', 'reembolso_excepcional') then
    if v_actor_role <> 'super_admin' then
      raise exception 'CREDIT_NOTE_ADMIN_OPERATION_FORBIDDEN';
    end if;
    if p_claim_id is not null then
      raise exception 'INVALID_CREDIT_NOTE_CLAIM';
    end if;
    if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) <> 0
       or round(coalesce(p_items_amount, 0), 2) <> 0 then
      raise exception 'CREDIT_NOTE_ADMIN_ITEMS_FORBIDDEN';
    end if;
  elsif p_claim_id is null then
    raise exception 'CLAIM_REQUIRED';
  end if;

  select round(total::numeric, 2), usuario_id
  into v_invoice_total, v_order_user_id
  from public.ordenes
  where id = p_order_id
    and invoice_status = 'authorized'
    and invoice_cae is not null
    and invoice_point = p_invoice_point
    and invoice_number = p_invoice_number
  for update;

  if v_invoice_total is null then
    raise exception 'AUTHORIZED_INVOICE_REQUIRED';
  end if;

  if p_claim_id is not null then
    select * into v_claim
    from public.order_claims
    where id = p_claim_id
      and order_id = p_order_id
    for update;

    if not found or v_claim.user_id is distinct from v_order_user_id then
      raise exception 'INVALID_CREDIT_NOTE_CLAIM';
    end if;
    if v_claim.status not in (
         'aprobado',
         'reintegro_pendiente',
         'cambio_pendiente',
         'cupon_pendiente',
         'reemplazo_enviado'
       )
       or v_claim.resolution = 'rechazado'
       or v_claim.failure_type = 'consulta_pedido' then
      raise exception 'INVALID_CREDIT_NOTE_CLAIM_STATUS';
    end if;
    if p_operation_type = 'cancelacion_antes_despacho'
       and v_claim.failure_type is distinct from 'cancelar_compra' then
      raise exception 'INVALID_CREDIT_NOTE_CLAIM_STATUS';
    end if;
    if p_operation_type <> 'cancelacion_antes_despacho'
       and v_claim.failure_type = 'cancelar_compra' then
      raise exception 'INVALID_CREDIT_NOTE_CLAIM_STATUS';
    end if;
  end if;

  select coalesce(sum(total_amount), 0)
  into v_committed_total
  from public.order_credit_notes
  where order_id = p_order_id
    and status in ('processing', 'authorized');

  if round(v_committed_total + p_total_amount, 2) > v_invoice_total then
    raise exception 'CREDIT_NOTE_EXCEEDS_INVOICE';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    select *
    into v_order_item
    from public.orden_items
    where id = (v_item->>'order_item_id')::bigint
      and orden_id = p_order_id;

    if not found then
      raise exception 'INVALID_CREDIT_NOTE_ITEM';
    end if;

    if p_claim_id is not null then
      v_affected_item := null;
      select affected.value into v_affected_item
      from jsonb_array_elements(coalesce(v_claim.affected_items, '[]'::jsonb)) affected
      where (affected.value->>'order_item_id')::bigint = v_order_item.id
      limit 1;

      if v_affected_item is null
         or (v_item->>'quantity')::integer > (v_affected_item->>'quantity')::integer then
        raise exception 'INVALID_CREDIT_NOTE_CLAIM_ITEM';
      end if;
    end if;

    select coalesce(sum(cni.quantity), 0)
    into v_committed_quantity
    from public.order_credit_note_items cni
    join public.order_credit_notes cn on cn.id = cni.credit_note_id
    where cni.order_item_id = v_order_item.id
      and cn.status in ('processing', 'authorized');

    if (v_item->>'quantity')::integer <= 0
       or v_committed_quantity + (v_item->>'quantity')::integer > v_order_item.cantidad then
      raise exception 'CREDIT_NOTE_ITEM_QUANTITY_EXCEEDED';
    end if;
  end loop;

  insert into public.order_credit_notes (
    order_id,
    claim_id,
    destination,
    reason,
    items_amount,
    manual_amount,
    total_amount,
    invoice_point,
    invoice_number,
    created_by,
    operation_type
  )
  values (
    p_order_id,
    p_claim_id,
    p_destination,
    trim(p_reason),
    round(p_items_amount, 2),
    round(p_manual_amount, 2),
    round(p_total_amount, 2),
    p_invoice_point,
    p_invoice_number,
    p_created_by,
    p_operation_type
  )
  returning * into v_note;

  insert into public.order_credit_note_items (
    credit_note_id,
    order_item_id,
    quantity,
    unit_amount,
    total_amount,
    product_name,
    variant_name
  )
  select
    v_note.id,
    (value->>'order_item_id')::bigint,
    (value->>'quantity')::integer,
    round((value->>'unit_amount')::numeric, 4),
    round((value->>'total_amount')::numeric, 2),
    left(value->>'product_name', 240),
    nullif(left(value->>'variant_name', 240), '')
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb));

  return v_note;
exception
  when unique_violation then
    raise exception 'CREDIT_NOTE_PROCESSING_IN_PROGRESS';
end;
$$;

revoke all on function public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb, text
) from public, anon, authenticated;

grant execute on function public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb, text
) to service_role;

comment on function public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb, text
) is
  'Reserva una NC serializada: devoluciones con claim válido y productos afectados, o ajustes sin claim exclusivos de super_admin y sin items.';

create or replace function public.commit_order_refund_proof(p_operation_id uuid,p_actor_id uuid,p_file jsonb)
returns public.ordenes language plpgsql security definer set search_path=public as $$
declare
  v_op public.order_claim_operations%rowtype;
  v_order public.ordenes%rowtype;
  v_amount numeric;
  v_notes uuid[];
  v_proof_id bigint;
  v_role text;
  v_path text:=p_file->>'path';
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CLAIM_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id=p_actor_id;
  if coalesce(v_role,'') not in ('admin','super_admin') then raise exception 'CLAIM_FORBIDDEN'; end if;
  select * into v_op from public.order_claim_operations where id=p_operation_id and actor_id=p_actor_id for update;
  if not found then raise exception 'CLAIM_FORBIDDEN'; end if;
  select * into v_order from public.ordenes where id=v_op.order_id for update;
  if v_op.status='committed' then return v_order; end if;
  if v_op.status<>'uploading' or v_op.expires_at<=now() or v_op.bucket_id<>'payment-proofs' then raise exception 'CLAIM_CONFLICT'; end if;
  if v_order.financial_status='cancelled' then raise exception 'CLAIM_CONFLICT'; end if;
  perform id from public.order_credit_notes where order_id=v_order.id order by id for update;
  select sum(total_amount),array_agg(id order by id) into v_amount,v_notes from public.order_credit_notes
    where order_id=v_order.id and status='authorized' and destination='external_refund' and settlement_status is distinct from 'completado' and cae is not null;
  if coalesce(v_amount,0)<=0 then raise exception 'CLAIM_REFUND_PENDING'; end if;
  if jsonb_typeof(p_file->'expected_note_ids') is distinct from 'array' or
    v_notes is distinct from (select array_agg(value::uuid order by value::uuid) from jsonb_array_elements_text(p_file->'expected_note_ids')) then raise exception 'CLAIM_CONFLICT'; end if;
  if exists(select 1 from public.order_credit_notes where order_id=v_order.id and status='processing') then raise exception 'CLAIM_CONFLICT'; end if;
  if not(v_path=any(v_op.file_paths)) or not exists(select 1 from storage.objects where bucket_id='payment-proofs' and name=v_path) then raise exception 'CLAIM_INVALID_FILES'; end if;
  insert into public.order_refund_proofs(order_id,uploaded_by,file_name,file_path,mime_type,file_size,amount,method)
    values(v_order.id,p_actor_id,p_file->>'name','payment-proofs/'||v_path,p_file->>'type',(p_file->>'size')::bigint,v_amount,'Devolución de dinero') returning id into v_proof_id;
  update public.order_credit_notes set management_status='finalizada',settlement_status='completado',settlement_date=current_date,settlement_reference=v_proof_id::text,updated_at=now() where id=any(v_notes);
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
    values(v_order.id,'admin',p_actor_id,'order_refunded',v_order.financial_status,'refunded',jsonb_build_object('proofId',v_proof_id,'amount',v_amount,'creditNoteIds',v_notes));
  update public.ordenes set financial_status='refunded',refund_proof_url='payment-proofs/'||v_path,refund_proof_file_name=p_file->>'name',refund_proof_mime_type=p_file->>'type',refund_proof_file_size=(p_file->>'size')::bigint,
    refund_amount=(select sum(amount) from public.order_refund_proofs where order_id=v_order.id),refund_method='Devolución de dinero',refund_uploaded_by=p_actor_id,refund_uploaded_at=now(),refunded_at=now(),refunded_by=p_actor_id,credit_note_required=false where id=v_order.id returning * into v_order;
  if v_order.usuario_id is not null then
    insert into public.customer_notifications(user_id,type,title,body,action_url,order_id,source_key)
      values(v_order.usuario_id,'order_refunded','Dinero reintegrado','Registramos el reintegro de tu pedido.','/cuenta/compras/'||v_order.id,v_order.id,'order:'||v_order.id||':refunded') on conflict(source_key) do nothing;
  end if;
  update public.order_claim_operations set status='committed' where id=v_op.id;
  return v_order;
end $$;
revoke all on function public.commit_order_refund_proof(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.commit_order_refund_proof(uuid,uuid,jsonb) to service_role;


notify pgrst,'reload schema';
commit;
