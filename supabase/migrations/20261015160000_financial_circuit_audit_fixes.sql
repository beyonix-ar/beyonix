-- Auditoría del circuito Pago → Factura C → Cancelación → NC → Reintegro.
--
-- HALLAZGOS (sin datos reales afectados: la base no tiene pagos combinados ni
-- reintegros manuales todavía):
--
-- 1. Pago combinado (saldo + MP/transferencia). 20261014130000 separó el
--    importe fiscal de la NC (total_amount) del dinero externo
--    (external_amount), pero reserve_order_financial_resolution y
--    complete_manual_order_financial_refund seguían sumando total_amount:
--      * NC total $100.000 = $70.000 MP + $30.000 saldo: la resolución se
--        rechazaba con FINANCIAL_AMOUNT_INVALID / FINANCIAL_MP_INELIGIBLE
--        (100.000 > 70.000 cobrados por MP).
--      * NC parcial combinada: el reintegro manual se reservaba por el total
--        fiscal (incluye la parte de saldo, que el trigger de la NC ya
--        restaura), así que el Admin habría devuelto de más por transferencia.
--    Ahora ambas usan coalesce(external_amount, total_amount), igual que
--    commit_order_refund_proof y el orquestador.
--
-- 2. Transferencia: complete_manual_order_financial_refund cerraba el
--    reintegro (financial_status='refunded') sin ningún comprobante. BEYONIX
--    no devuelve dinero por banco: el reintegro externo sólo se cierra con el
--    comprobante del pago saliente (mismo requisito que
--    commit_order_refund_proof). Un reintento sobre una resolución ya
--    completada sigue siendo idempotente sin archivo.
--
-- 3. Factura → NC → dinero. guard_refund_requires_invoice cubría "sin
--    factura"; con la factura ya autorizada la NC se exigía sólo vía
--    credit_note_required, y ese flag puede quedar en false sin ninguna NC
--    (p. ej. pedido facturado después de la cancelación con un flujo previo).
--    El guard ahora exige además una NC autorizada de reintegro externo antes
--    de registrar dinero devuelto de una venta facturada.
--
-- 4. Defensa en profundidad: un refund de Mercado Pago no puede iniciarse si
--    el pedido ya tiene una resolución financiera con otro destino (saldo o
--    reintegro manual). Simétrico a guard_claim_refund_proof.
--
-- Sólo reemplaza funciones; no toca triggers ni datos.

begin;

-- 1. Reserva: dinero externo de las NC, no su total fiscal.
create or replace function public.reserve_order_financial_resolution(
  p_order_id bigint,p_actor_id uuid,p_choice text
) returns public.order_financial_resolutions
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp as $$
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
  -- NUEVO: dinero externo de la NC (en un pago combinado la parte de saldo
  -- vuelve por la propia NC, nunca por este reintegro).
  select coalesce(sum(coalesce(external_amount,total_amount)),0) into v_note_amount from public.order_credit_notes
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

-- 2. Reintegro manual: comprobante obligatorio y dinero externo de las NC.
create or replace function public.complete_manual_order_financial_refund(
  p_resolution_id uuid,p_actor_id uuid,p_reference text default null,p_observation text default null,p_proof jsonb default null
) returns public.order_financial_resolutions
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp as $$
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
  -- NUEVO: BEYONIX no devuelve dinero por banco; sin comprobante del pago
  -- saliente el reintegro sigue pendiente.
  if v_path is null then raise exception 'FINANCIAL_PROOF_REQUIRED'; end if;
  select * into v_order from public.ordenes where id=v_row.order_id for update;
  if v_order.financial_status is distinct from 'refund_pending' or v_order.andreani_handed_over_at is not null then raise exception 'FINANCIAL_RETURN_REQUIRED'; end if;
  perform public.assert_order_claim_money_released(v_row.order_id);
  if exists(select 1 from public.order_refund_proofs where order_id=v_row.order_id) then raise exception 'FINANCIAL_ALREADY_COMPLETED'; end if;
  if v_order.credit_note_required then raise exception 'FINANCIAL_CREDIT_NOTE_PENDING'; end if;
  if exists(select 1 from public.order_credit_notes where order_id=v_row.order_id and status='processing') then
    raise exception 'FINANCIAL_CREDIT_NOTE_PENDING';
  end if;
  -- NUEVO: dinero externo de las NC, no su total fiscal.
  select array_agg(id order by id),coalesce(sum(coalesce(external_amount,total_amount)),0) into v_notes,v_note_amount
    from public.order_credit_notes where order_id=v_row.order_id and status='authorized'
      and destination='external_refund' and settlement_status is distinct from 'completado' and cae is not null;
  if v_notes is not null and v_note_amount<v_row.amount then raise exception 'FINANCIAL_CREDIT_NOTE_AMOUNT'; end if;
  if v_order.invoice_status='authorized' and v_notes is null then raise exception 'FINANCIAL_CREDIT_NOTE_PENDING'; end if;
  if p_proof->>'name' is null or p_proof->>'type' is null or p_proof->>'type' not in ('image/jpeg','image/png','application/pdf')
     or v_path not like v_row.order_id::text||'/%'
     or nullif(p_proof->>'size','') is null or (p_proof->>'size')::bigint not between 1 and 5242880 or not exists(
       select 1 from storage.objects where bucket_id='payment-proofs' and name=v_path
     ) then raise exception 'FINANCIAL_INVALID_PROOF'; end if;
  insert into public.order_refund_proofs(order_id,uploaded_by,file_name,file_path,mime_type,file_size,
    amount,method,observation,bank_reference,refund_date,financial_resolution_id)
    values(v_row.order_id,p_actor_id,p_proof->>'name','payment-proofs/'||v_path,p_proof->>'type',(p_proof->>'size')::bigint,
      v_row.amount,'Reintegro manual',nullif(btrim(p_observation),''),nullif(btrim(p_reference),''),current_date,v_row.id)
    returning id into v_proof_id;
  if v_notes is not null then
    update public.order_credit_notes set management_status='finalizada',settlement_status='completado',
      settlement_date=current_date,settlement_reference=v_proof_id::text,updated_at=now()
      where id=any(v_notes);
  end if;
  update public.ordenes set financial_status='refunded',refund_amount=v_row.amount,
    refund_method='Reintegro manual',refunded_at=now(),refunded_by=p_actor_id,
    refund_proof_url='payment-proofs/'||v_path,refund_proof_file_name=p_proof->>'name',
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

-- 3. Dinero devuelto de una venta facturada: exige la NC autorizada.
create or replace function public.guard_refund_requires_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Refund de MP: sólo al pasar a 'processing' (antes de llamar a MP). La
  -- conciliación de un intento ya en curso no se bloquea.
  if tg_table_name = 'mercadopago_order_refunds' then
    if new.status is distinct from 'processing'
       or (tg_op = 'UPDATE' and old.status = 'processing') then
      return new;
    end if;
  end if;
  if public.order_has_pending_invoice_obligation(new.order_id) then
    raise exception 'INVOICE_REQUIRED_BEFORE_REFUND';
  end if;
  -- NUEVO: Factura C autorizada → primero la NC C (reintegro externo).
  if exists (
       select 1 from public.ordenes o
       where o.id = new.order_id
         and (o.invoice_cae is not null or o.invoice_status = 'authorized')
     )
     and not exists (
       select 1 from public.order_credit_notes n
       where n.order_id = new.order_id
         and n.status = 'authorized'
         and n.cae is not null
         and n.destination = 'external_refund'
     ) then
    raise exception 'CREDIT_NOTE_REQUIRED_BEFORE_REFUND';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_refund_requires_invoice() from public, anon, authenticated;

-- 4. Refund MP incompatible con la resolución financiera elegida.
create or replace function public.guard_claim_mercadopago_refund()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public,pg_temp
as $$
begin
  if new.status='processing' and (tg_op='INSERT' or old.status is distinct from 'processing') then
    if public.order_was_prepared_for_dispatch(new.order_id) then
      raise exception 'REFUND_PREPARED_BATCH';
    end if;
    if exists (select 1 from public.ordenes where id=new.order_id and andreani_handed_over_at is not null) then
      raise exception 'REFUND_HANDED_OVER';
    end if;
    -- NUEVO: con saldo o reintegro manual elegidos, MP no puede devolver además.
    if exists (select 1 from public.order_financial_resolutions
               where order_id=new.order_id and choice<>'mercadopago_refund') then
      raise exception 'FINANCIAL_CHOICE_CONFLICT';
    end if;
    perform public.assert_order_claim_money_released(new.order_id);
  end if;
  return new;
end;
$$;

revoke all on function public.guard_claim_mercadopago_refund() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
