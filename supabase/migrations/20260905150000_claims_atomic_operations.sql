begin;

-- Inspeccionado contra catálogos remotos el 2026-09-05. No elimina datos.
alter table public.order_claims enable row level security;
alter table public.order_claim_messages enable row level security;
alter table public.order_claim_files enable row level security;
revoke all on public.order_claims, public.order_claim_messages, public.order_claim_files from anon, authenticated;
grant select on public.order_claims to authenticated;
revoke all on sequence public.order_claims_id_seq, public.order_claim_messages_id_seq, public.order_claim_files_id_seq from anon, authenticated;
drop policy if exists "Internal users can read order claims" on public.order_claims;
create policy "Internal users can read order claims" on public.order_claims for select to authenticated using (public.is_current_user_internal());

-- Un trigger UPDATE OF rol no cubre un rol cambiado por otro trigger de email.
-- Este guard se ejecuta al final de los BEFORE triggers y también en INSERT.
create or replace function public.guard_profile_privilege_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if auth.role() = 'service_role' or session_user in ('postgres', 'supabase_admin') and auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if new.rol <> 'cliente' then raise exception 'PROFILE_ROLE_FORBIDDEN'; end if;
  elsif new.rol is distinct from old.rol then
    select rol into v_role from public.profiles where id=auth.uid();
    if coalesce(v_role,'') <> 'super_admin' and not (v_role='admin' and old.rol <> 'super_admin' and new.rol in ('cliente','operador','admin')) then
      raise exception 'PROFILE_ROLE_FORBIDDEN';
    end if;
  end if;
  return new;
end $$;
create trigger zz_guard_profile_privilege_assignment before insert or update on public.profiles for each row execute function public.guard_profile_privilege_assignment();
revoke all on function public.guard_profile_privilege_assignment() from public, anon, authenticated;

alter table public.order_claims
  add column if not exists refund_account_holder text,
  add column if not exists refund_account_identifier text,
  add column if not exists refund_bank text,
  add column if not exists refund_amount_confirmed text,
  add column if not exists refund_details_submitted_at timestamptz,
  add column if not exists refund_completed_at timestamptz,
  add column if not exists refund_completed_by uuid references auth.users(id);

update storage.buckets set public=false, file_size_limit=41943040,
  allowed_mime_types=array['image/jpeg','image/png','image/gif','image/webp','application/pdf','video/mp4','video/quicktime','video/webm']
where id='order-claim-evidence';

-- Registro durable de intentos: sólo los objetos reservados aquí pueden limpiarse.
-- Los objetos históricos nunca se incluyen en la limpieza automática.
create table public.order_claim_operations (
  id uuid primary key,
  actor_id uuid not null references auth.users(id),
  order_id bigint not null references public.ordenes(id),
  request_key text not null check (length(request_key)=64),
  status text not null default 'uploading' check (status in ('uploading','committed','failed','cleaned')),
  file_paths text[] not null default '{}',
  bucket_id text not null default 'order-claim-evidence' check (bucket_id in ('order-claim-evidence','payment-proofs')),
  claim_id bigint references public.order_claims(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '10 minutes',
  unique(actor_id,request_key)
);
alter table public.order_claim_operations enable row level security;
revoke all on public.order_claim_operations from public,anon,authenticated;
grant all on public.order_claim_operations to service_role;
create index order_claim_operations_cleanup_idx on public.order_claim_operations(expires_at) where status in ('uploading','failed');

create or replace function public.begin_order_claim_operation(p_id uuid,p_actor_id uuid,p_order_id bigint,p_request_key text,p_file_paths text[],p_bucket_id text default 'order-claim-evidence')
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_op public.order_claim_operations%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CLAIM_FORBIDDEN'; end if;
  if cardinality(p_file_paths)>6 or exists(select 1 from unnest(p_file_paths) path where path not like p_actor_id::text||'/'||p_id::text||'/%' or path like '%..%') then raise exception 'CLAIM_INVALID'; end if;
  insert into public.order_claim_operations(id,actor_id,order_id,request_key,file_paths,bucket_id)
  values(p_id,p_actor_id,p_order_id,p_request_key,p_file_paths,p_bucket_id) on conflict(actor_id,request_key) do nothing;
  select * into v_op from public.order_claim_operations where actor_id=p_actor_id and request_key=p_request_key for update;
  if v_op.order_id<>p_order_id or v_op.bucket_id<>p_bucket_id then raise exception 'CLAIM_INVALID'; end if;
  if v_op.status='cleaned' then
    update public.order_claim_operations set status='uploading', file_paths=p_file_paths, expires_at=now()+interval '10 minutes' where id=v_op.id returning * into v_op;
    return to_jsonb(v_op)||jsonb_build_object('acquired',true);
  end if;
  return to_jsonb(v_op)||jsonb_build_object('acquired',v_op.id=p_id);
end $$;

create or replace function public.commit_customer_order_claim(p_operation_id uuid,p_actor_id uuid,p_payload jsonb,p_files jsonb)
returns bigint language plpgsql security definer set search_path=public set timezone='UTC' as $$
declare
  v_op public.order_claim_operations%rowtype;
  v_order public.ordenes%rowtype;
  v_claim public.order_claims%rowtype;
  v_reason text:=p_payload->>'problemType';
  v_type text;
  v_message text:=btrim(coalesce(p_payload->>'message',''));
  v_items jsonb;
  v_item jsonb;
  v_file jsonb;
  v_message_id bigint;
  v_previous text;
  v_email text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CLAIM_FORBIDDEN'; end if;
  select * into v_op from public.order_claim_operations where id=p_operation_id and actor_id=p_actor_id for update;
  if not found then raise exception 'CLAIM_FORBIDDEN'; end if;
  if v_op.status='committed' then return v_op.claim_id; end if;
  if v_op.status<>'uploading' or v_op.expires_at<=now() or v_op.bucket_id<>'order-claim-evidence' then raise exception 'CLAIM_CONFLICT'; end if;
  select * into v_order from public.ordenes where id=v_op.order_id for update;
  select lower(email) into v_email from auth.users where id=p_actor_id and email_confirmed_at is not null;
  if not found or (v_order.usuario_id is not null and v_order.usuario_id<>p_actor_id) or
     (v_order.usuario_id is null and (v_email is null or lower(btrim(v_order.cliente_email)) is distinct from v_email)) then raise exception 'CLAIM_FORBIDDEN'; end if;
  if length(v_message)>2000 or jsonb_array_length(p_files)>6 then raise exception 'CLAIM_INVALID'; end if;
  if p_payload->>'claimId' is not null then
    select * into v_claim from public.order_claims where id=(p_payload->>'claimId')::bigint and order_id=v_order.id and user_id=p_actor_id for update;
    if not found then raise exception 'CLAIM_FORBIDDEN'; end if;
    if v_claim.status in ('cerrado','rechazado') then raise exception 'CLAIM_TERMINAL'; end if;
    if v_claim.updated_at is distinct from (p_payload->>'expectedUpdatedAt')::timestamptz then raise exception 'CLAIM_CONFLICT'; end if;
    v_previous:=v_claim.status;
    if p_payload ? 'refundDetails' then
      if v_claim.status<>'reintegro_pendiente' or jsonb_array_length(p_files)>0 then raise exception 'CLAIM_INVALID'; end if;
      if exists(select 1 from unnest(array['holder','identifier','bank','amount']) k where length(btrim(coalesce(p_payload->'refundDetails'->>k,''))) not between 1 and 180) then raise exception 'CLAIM_INVALID'; end if;
      update public.order_claims set refund_account_holder=p_payload->'refundDetails'->>'holder',refund_account_identifier=p_payload->'refundDetails'->>'identifier',refund_bank=p_payload->'refundDetails'->>'bank',refund_amount_confirmed=p_payload->'refundDetails'->>'amount',refund_details_submitted_at=now() where id=v_claim.id;
      v_message:='Datos de reintegro enviados para revisión de BEYONIX.';
    else
      if length(v_message)<5 and jsonb_array_length(p_files)=0 then raise exception 'CLAIM_INVALID'; end if;
      if jsonb_array_length(p_files)=0 and (select author_role from public.order_claim_messages where claim_id=v_claim.id order by created_at desc,id desc limit 1)='cliente' then raise exception 'CLAIM_WAIT_REPLY'; end if;
      if length(v_message)<5 then v_message:='El cliente adjuntó nueva evidencia.'; end if;
      if v_claim.status='falta_informacion' then update public.order_claims set status='en_revision' where id=v_claim.id; end if;
    end if;
  else
    if length(v_message)<10 then raise exception 'CLAIM_INVALID'; end if;
    if exists(select 1 from public.order_claims where order_id=v_order.id and status not in ('cerrado','rechazado')) then raise exception 'CLAIM_EXISTS'; end if;
    if v_reason='consulta_pedido' then
      if v_order.estado in ('cancelado','entregado') or v_order.delivered_at is not null then raise exception 'CLAIM_INELIGIBLE'; end if;
      v_type:='transporte_48hs'; v_items:='[]';
    else
      if v_reason not in ('danado','incorrecto','faltante','cantidad_menor','falla','otro') or v_reason is null then raise exception 'CLAIM_INVALID'; end if;
      if exists(select 1 from public.order_claims where order_id=v_order.id and coalesce(failure_type,'') not in ('cancelar_compra','consulta_pedido')) then raise exception 'CLAIM_EXISTS'; end if;
      v_type:=case when v_reason in ('falla','otro') then 'garantia_beyonix' else 'transporte_48hs' end;
      if v_order.estado='cancelado' or v_order.delivered_at is null or v_order.delivered_at>now() then raise exception 'CLAIM_DELIVERY_DATE'; end if;
      if now()>v_order.delivered_at+(case when v_type='transporte_48hs' then interval '48 hours' else interval '6 months' end) then raise exception 'CLAIM_EXPIRED'; end if;
      v_items:=p_payload->'items';
      if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items)=0 then raise exception 'CLAIM_INVALID'; end if;
      if (select count(distinct x->>'order_item_id') from jsonb_array_elements(v_items) x)<>jsonb_array_length(v_items) then raise exception 'CLAIM_INVALID'; end if;
      for v_item in select * from jsonb_array_elements(v_items) loop
        if not exists(select 1 from public.orden_items where id=(v_item->>'order_item_id')::bigint and orden_id=v_order.id and (v_item->>'quantity')::integer between 1 and cantidad) then raise exception 'CLAIM_INVALID_ITEMS'; end if;
      end loop;
    end if;
    insert into public.order_claims(order_id,user_id,claim_type,failure_type,description,affected_items,admin_needs_action)
    values(v_order.id,p_actor_id,v_type,v_reason,v_message,v_items,true) returning * into v_claim;
  end if;
  insert into public.order_claim_messages(claim_id,author_user_id,author_role,message)
  values(v_claim.id,p_actor_id,'cliente',v_message) returning id into v_message_id;
  if jsonb_array_length(p_files)<>cardinality(v_op.file_paths) then raise exception 'CLAIM_INVALID_FILES'; end if;
  for v_file in select * from jsonb_array_elements(p_files) loop
    if not (v_file->>'path'=any(v_op.file_paths)) or not exists(select 1 from storage.objects where bucket_id='order-claim-evidence' and name=v_file->>'path') then raise exception 'CLAIM_INVALID_FILES'; end if;
    insert into public.order_claim_files(claim_id,uploaded_by,file_role,file_name,file_path,mime_type,file_size)
    values(v_claim.id,p_actor_id,case when v_previous is null then 'evidencia_inicial' else 'evidencia_adicional' end,v_file->>'name','order-claim-evidence/'||(v_file->>'path'),v_file->>'type',(v_file->>'size')::bigint);
  end loop;
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
  select v_order.id,'customer',p_actor_id,case when v_previous is null then 'claim_created' else 'claim_customer_response' end,v_previous,status,jsonb_build_object('claimId',id,'messageId',v_message_id,'fileCount',jsonb_array_length(p_files)) from public.order_claims where id=v_claim.id;
  if v_previous is null then
    insert into public.customer_notifications(user_id,type,title,body,action_url,order_id,source_key) values(p_actor_id,'claim_started','Solicitud recibida','Recibimos tu solicitud de ayuda.','/cuenta/compras/'||v_order.id||'/ayuda',v_order.id,'claim:'||v_claim.id||':created') on conflict(source_key) do nothing;
  end if;
  update public.order_claim_operations set status='committed',claim_id=v_claim.id where id=v_op.id;
  return v_claim.id;
end $$;

-- Cambios de estado y mensajes conservan una única transacción y versión.
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

revoke all on function public.begin_order_claim_operation(uuid,uuid,bigint,text,text[],text),public.commit_customer_order_claim(uuid,uuid,jsonb,jsonb),public.mutate_admin_order_claim(bigint,uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.begin_order_claim_operation(uuid,uuid,bigint,text,text[],text),public.commit_customer_order_claim(uuid,uuid,jsonb,jsonb),public.mutate_admin_order_claim(bigint,uuid,timestamptz,jsonb) to service_role;

-- Extiende el registro canónico; no ejecuta un pago ni llama a Mercado Pago.
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
  if v_order.financial_status in ('refunded','cancelled') then raise exception 'CLAIM_CONFLICT'; end if;
  perform id from public.order_credit_notes where order_id=v_order.id order by id for update;
  select sum(total_amount),array_agg(id) into v_amount,v_notes from public.order_credit_notes
    where order_id=v_order.id and status='authorized' and destination='external_refund' and settlement_status<>'completado';
  if coalesce(v_amount,0)<=0 then raise exception 'CLAIM_REFUND_PENDING'; end if;
  if not(v_path=any(v_op.file_paths)) or not exists(select 1 from storage.objects where bucket_id='payment-proofs' and name=v_path) then raise exception 'CLAIM_INVALID_FILES'; end if;
  insert into public.order_refund_proofs(order_id,uploaded_by,file_name,file_path,mime_type,file_size,amount,method)
    values(v_order.id,p_actor_id,p_file->>'name','payment-proofs/'||v_path,p_file->>'type',(p_file->>'size')::bigint,v_amount,'Devolución de dinero') returning id into v_proof_id;
  update public.order_credit_notes set management_status='finalizada',settlement_status='completado',settlement_date=current_date,settlement_reference=v_proof_id::text,updated_at=now() where id=any(v_notes);
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
    values(v_order.id,'admin',p_actor_id,'order_refunded',v_order.financial_status,'refunded',jsonb_build_object('proofId',v_proof_id,'amount',v_amount,'creditNoteIds',v_notes));
  update public.ordenes set financial_status='refunded',refund_proof_url='payment-proofs/'||v_path,refund_proof_file_name=p_file->>'name',refund_proof_mime_type=p_file->>'type',refund_proof_file_size=(p_file->>'size')::bigint,
    refund_amount=v_amount,refund_method='Devolución de dinero',refund_uploaded_by=p_actor_id,refund_uploaded_at=now(),refunded_at=now(),refunded_by=p_actor_id,credit_note_required=false where id=v_order.id returning * into v_order;
  if v_order.usuario_id is not null then
    insert into public.customer_notifications(user_id,type,title,body,action_url,order_id,source_key)
      values(v_order.usuario_id,'order_refunded','Dinero reintegrado','Registramos el reintegro de tu pedido.','/cuenta/compras/'||v_order.id,v_order.id,'order:'||v_order.id||':refunded') on conflict(source_key) do nothing;
  end if;
  update public.order_claim_operations set status='committed' where id=v_op.id;
  return v_order;
end $$;
revoke all on function public.commit_order_refund_proof(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.commit_order_refund_proof(uuid,uuid,jsonb) to service_role;

-- En la recepción, el lock de pedido serializa contra cambios de affected_items
-- y se conserva el motor canónico de inventario, sin duplicar sus movimientos.
create or replace function public.process_claim_return_inventory(p_claim_id bigint,p_order_id bigint,p_order_item_id bigint,p_restocked_quantity integer,p_written_off_quantity integer,p_note text,p_processed_by uuid)
returns public.orden_items language plpgsql security definer set search_path=public as $$
declare v_claim public.order_claims%rowtype; v_quantity integer; v_result public.orden_items%rowtype;
begin
  if auth.role() is distinct from 'service_role' or not exists(select 1 from public.profiles where id=p_processed_by and rol in ('admin','super_admin')) then raise exception 'CLAIM_FORBIDDEN'; end if;
  perform id from public.ordenes where id=p_order_id for update;
  select * into v_claim from public.order_claims where id=p_claim_id and order_id=p_order_id for update;
  if not found or coalesce(v_claim.failure_type,'') in ('cancelar_compra','consulta_pedido') then raise exception 'CLAIM_INVALID'; end if;
  select (x->>'quantity')::integer into v_quantity from jsonb_array_elements(v_claim.affected_items) x where (x->>'order_item_id')::bigint=p_order_item_id;
  if v_quantity is null or p_restocked_quantity is null or p_written_off_quantity is null or p_restocked_quantity<0 or p_written_off_quantity<0 or p_restocked_quantity+p_written_off_quantity not between 1 and v_quantity then raise exception 'CLAIM_INVALID_ITEMS'; end if;
  select * into v_result from public.process_order_item_return_inventory(p_order_id,p_order_item_id,p_restocked_quantity,p_written_off_quantity,p_note,p_processed_by);
  return v_result;
end $$;
revoke all on function public.process_claim_return_inventory(bigint,bigint,bigint,integer,integer,text,uuid) from public,anon,authenticated;
grant execute on function public.process_claim_return_inventory(bigint,bigint,bigint,integer,integer,text,uuid) to service_role;

notify pgrst,'reload schema';
commit;
