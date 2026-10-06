-- Etapa 5: intención financiera única por pedido. El dinero y la NC siguen
-- moviéndose exclusivamente por las RPC y servicios existentes.
create table public.order_financial_resolutions (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null unique references public.ordenes(id) on delete restrict,
  choice text not null check (choice in ('beyonix_credit','mercadopago_refund','manual_refund')),
  amount numeric(14,2) not null check (amount > 0),
  status text not null default 'reserved' check (status in ('reserved','processing','manual_pending','requires_action','completed')),
  selected_by uuid not null references public.profiles(id),
  selected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_key uuid,
  attempt_count integer not null default 0,
  note_id uuid references public.order_credit_notes(id),
  last_error text,
  completed_at timestamptz,
  completed_by uuid references public.profiles(id),
  check ((status='completed') = (completed_at is not null))
);
create index order_financial_resolutions_status_idx on public.order_financial_resolutions(status,updated_at);
alter table public.order_financial_resolutions enable row level security;
revoke all on public.order_financial_resolutions from public,anon,authenticated;
grant select,insert,update on public.order_financial_resolutions to service_role;

-- Incluye tandas históricas: retirar el bulto no revierte el corte financiero.
create or replace function public.order_was_prepared_for_dispatch(p_order_id bigint)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1 from public.dispatch_batch_items i
    join public.dispatch_batches b on b.id=i.batch_id
    where i.order_id=p_order_id and b.prepared_at is not null
      and (i.removed_at is null or i.removed_at >= b.closed_at)
  );
$$;
revoke all on function public.order_was_prepared_for_dispatch(bigint) from public,anon,authenticated;
grant execute on function public.order_was_prepared_for_dispatch(bigint) to service_role;

create or replace function public.order_financial_claim_block(p_order_id bigint)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select public.order_claim_money_block(c.id)
  from public.order_claims c
  where c.order_id=p_order_id and c.status not in ('cerrado','rechazado')
    and exists(select 1 from public.order_claim_units u where u.claim_id=c.id)
    and public.order_claim_money_block(c.id) is not null
  order by c.id desc limit 1;
$$;
revoke all on function public.order_financial_claim_block(bigint) from public,anon,authenticated;
grant execute on function public.order_financial_claim_block(bigint) to service_role;

-- Protege también el endpoint MP anterior y cualquier caller futuro.
create or replace function public.guard_claim_mercadopago_refund()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.status='processing' and (tg_op='INSERT' or old.status is distinct from 'processing') then
    if public.order_was_prepared_for_dispatch(new.order_id) then
      raise exception 'REFUND_PREPARED_BATCH';
    end if;
    if exists (select 1 from public.ordenes where id=new.order_id and andreani_handed_over_at is not null) then
      raise exception 'REFUND_HANDED_OVER';
    end if;
    perform public.assert_order_claim_money_released(new.order_id);
  end if;
  return new;
end;
$$;

create or replace function public.reserve_order_financial_resolution(
  p_order_id bigint,p_actor_id uuid,p_choice text
) returns public.order_financial_resolutions
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_order public.ordenes%rowtype; v_row public.order_financial_resolutions%rowtype;
  v_amount numeric; v_role text;
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
  if p_choice='manual_refund' and v_order.payment_method_id is distinct from 'transferencia'
     and not (v_order.payment_method_id='mercadopago' and public.order_was_prepared_for_dispatch(p_order_id)) then
    raise exception 'FINANCIAL_INVALID_PAYMENT_METHOD';
  end if;
  if p_choice='beyonix_credit' and v_order.usuario_id is null then raise exception 'FINANCIAL_NO_ACCOUNT'; end if;
  v_amount := coalesce(nullif(v_order.payment_confirmed_amount,0),nullif(v_order.external_amount_due,0));
  if v_amount is null or v_amount<=0 then raise exception 'FINANCIAL_AMOUNT_INVALID'; end if;
  if p_choice='mercadopago_refund' and (v_amount>40000 or nullif(btrim(v_order.payment_id),'') is null) then
    raise exception 'FINANCIAL_MP_INELIGIBLE';
  end if;
  if p_choice='mercadopago_refund' and (
     lower(coalesce(v_order.estado,'')) in ('enviado','en_camino','visita_fallida','en_sucursal','retiro_pendiente','retiro_vencido','en_devolucion','devuelto_beyonix','entregado')
     or nullif(btrim(v_order.tracking_number),'') is not null
     or nullif(btrim(v_order.andreani_tracking),'') is not null
     or nullif(btrim(v_order.andreani_envio_id),'') is not null
  ) then raise exception 'FINANCIAL_RETURN_REQUIRED'; end if;
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

create or replace function public.claim_order_financial_resolution(p_resolution_id uuid,p_actor_id uuid,p_lease_key uuid)
returns public.order_financial_resolutions language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_row public.order_financial_resolutions%rowtype; v_role text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FINANCIAL_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id=p_actor_id;
  if coalesce(v_role,'') not in ('admin','super_admin') then raise exception 'FINANCIAL_FORBIDDEN'; end if;
  select * into v_row from public.order_financial_resolutions where id=p_resolution_id for update;
  if not found then raise exception 'FINANCIAL_NOT_FOUND'; end if;
  if v_row.status='completed' or v_row.status='manual_pending' then return v_row; end if;
  if v_row.status='processing' and v_row.lease_until>now() then return v_row; end if;
  update public.order_financial_resolutions
    set status='processing',lease_until=now()+interval '5 minutes',lease_key=p_lease_key,attempt_count=attempt_count+1,
        updated_at=now(),last_error=null
    where id=p_resolution_id returning * into v_row;
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
    values(v_row.order_id,'admin',p_actor_id,'financial_resolution_attempt',null,'processing',
      jsonb_build_object('resolutionId',v_row.id,'attempt',v_row.attempt_count));
  return v_row;
end;
$$;
revoke all on function public.claim_order_financial_resolution(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_order_financial_resolution(uuid,uuid,uuid) to service_role;

-- El comprobante del reintegro bancario es opcional. Los flujos legados con
-- archivo conservan su validación; la nueva RPC exige todos sus datos si se adjunta.
alter table public.order_refund_proofs
  alter column file_name drop not null,
  alter column file_path drop not null,
  alter column mime_type drop not null,
  alter column file_size drop not null;
alter table public.order_refund_proofs add column financial_resolution_id uuid unique
  references public.order_financial_resolutions(id);
alter table public.order_refund_proofs add constraint refund_proof_file_complete
  check ((file_name is null and file_path is null and mime_type is null and file_size is null)
      or (file_name is not null and file_path is not null and mime_type is not null and file_size is not null));

create or replace function public.complete_manual_order_financial_refund(
  p_resolution_id uuid,p_actor_id uuid,p_reference text default null,
  p_observation text default null,p_proof jsonb default null
) returns public.order_financial_resolutions language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_row public.order_financial_resolutions%rowtype; v_order public.ordenes%rowtype;
  v_role text; v_notes uuid[]; v_note_amount numeric; v_proof_id bigint;
  v_path text := nullif(btrim(p_proof->>'path'),'');
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FINANCIAL_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id=p_actor_id;
  if coalesce(v_role,'') not in ('admin','super_admin') then raise exception 'FINANCIAL_FORBIDDEN'; end if;
  if length(coalesce(p_reference,''))>120 or length(coalesce(p_observation,''))>600 then raise exception 'FINANCIAL_INVALID_DETAILS'; end if;
  select * into v_row from public.order_financial_resolutions where id=p_resolution_id for update;
  if not found or v_row.choice<>'manual_refund' then raise exception 'FINANCIAL_NOT_FOUND'; end if;
  if v_row.status='completed' then return v_row; end if;
  if v_row.status<>'manual_pending' then raise exception 'FINANCIAL_NOT_READY'; end if;
  select * into v_order from public.ordenes where id=v_row.order_id for update;
  if v_order.financial_status is distinct from 'refund_pending' or v_order.andreani_handed_over_at is not null then raise exception 'FINANCIAL_RETURN_REQUIRED'; end if;
  perform public.assert_order_claim_money_released(v_row.order_id);
  if exists(select 1 from public.order_refund_proofs where order_id=v_row.order_id) then raise exception 'FINANCIAL_ALREADY_COMPLETED'; end if;
  if v_order.credit_note_required then raise exception 'FINANCIAL_CREDIT_NOTE_PENDING'; end if;
  if exists(select 1 from public.order_credit_notes where order_id=v_row.order_id and status='processing') then
    raise exception 'FINANCIAL_CREDIT_NOTE_PENDING';
  end if;
  select array_agg(id order by id),coalesce(sum(total_amount),0) into v_notes,v_note_amount
    from public.order_credit_notes where order_id=v_row.order_id and status='authorized'
      and destination='external_refund' and settlement_status is distinct from 'completado' and cae is not null;
  if v_notes is not null and v_note_amount<v_row.amount then raise exception 'FINANCIAL_CREDIT_NOTE_AMOUNT'; end if;
  if v_order.invoice_status='authorized' and v_notes is null then raise exception 'FINANCIAL_CREDIT_NOTE_PENDING'; end if;
  if v_path is not null then
    if p_proof->>'name' is null or p_proof->>'type' is null or p_proof->>'type' not in ('image/jpeg','image/png','application/pdf')
       or v_path not like v_row.order_id::text||'/%'
       or nullif(p_proof->>'size','') is null or (p_proof->>'size')::bigint not between 1 and 5242880 or not exists(
         select 1 from storage.objects where bucket_id='payment-proofs' and name=v_path
       ) then raise exception 'FINANCIAL_INVALID_PROOF'; end if;
  end if;
  insert into public.order_refund_proofs(order_id,uploaded_by,file_name,file_path,mime_type,file_size,
    amount,method,observation,bank_reference,refund_date,financial_resolution_id)
    values(v_row.order_id,p_actor_id,case when v_path is null then null else p_proof->>'name' end,
      case when v_path is null then null else 'payment-proofs/'||v_path end,
      case when v_path is null then null else p_proof->>'type' end,
      case when v_path is null then null else (p_proof->>'size')::bigint end,
      v_row.amount,'Reintegro manual',nullif(btrim(p_observation),''),nullif(btrim(p_reference),''),current_date,v_row.id)
    returning id into v_proof_id;
  if v_notes is not null then
    update public.order_credit_notes set management_status='finalizada',settlement_status='completado',
      settlement_date=current_date,settlement_reference=v_proof_id::text,updated_at=now()
      where id=any(v_notes);
  end if;
  update public.ordenes set financial_status='refunded',refund_amount=v_row.amount,
    refund_method='Reintegro manual',refunded_at=now(),refunded_by=p_actor_id,
    refund_proof_url=case when v_path is null then null else 'payment-proofs/'||v_path end,
    refund_proof_file_name=case when v_path is null then null else p_proof->>'name' end,
    credit_note_required=false where id=v_row.order_id;
  update public.order_financial_resolutions set status='completed',completed_at=now(),completed_by=p_actor_id,
    lease_until=null,updated_at=now() where id=v_row.id returning * into v_row;
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
    values(v_row.order_id,'admin',p_actor_id,'financial_manual_refund_completed','manual_pending','completed',
      jsonb_build_object('resolutionId',v_row.id,'amount',v_row.amount,'reference',p_reference,
        'observation',p_observation,'proofId',v_proof_id));
  if v_order.usuario_id is not null then
    insert into public.customer_notifications(user_id,type,title,body,action_url,order_id,source_key)
      values(v_order.usuario_id,'order_refunded','Dinero reintegrado','Registramos el reintegro de tu pedido.',
        '/cuenta/compras/'||v_row.order_id,v_row.order_id,'order:'||v_row.order_id||':refunded')
      on conflict(source_key) do nothing;
  end if;
  return v_row;
end;
$$;
revoke all on function public.complete_manual_order_financial_refund(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.complete_manual_order_financial_refund(uuid,uuid,text,text,jsonb) to service_role;

notify pgrst, 'reload schema';
