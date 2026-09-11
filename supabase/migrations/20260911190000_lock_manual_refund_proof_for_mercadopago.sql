-- Migración de ACTIVACIÓN del sistema seguro de refunds de Mercado Pago.
--
-- Se separa deliberadamente de la migración preparatoria
-- (20260911170000_mercadopago_order_refunds.sql) para permitir un rollout a
-- producción sin ventana incompatible:
--
--   1. Se aplica 20260911170000 (tabla + RPC, 100% aditiva).
--   2. Se aplica 20260911180000 (Fase 2, 100% aditiva).
--   3. Se despliega el código nuevo (Fase 1 + Fase 2) y se verifica
--      end-to-end sin mover dinero real.
--   4. Recién ENTONCES se aplica ESTA migración.
--
-- Antes del paso 4, un pedido de Mercado Pago puede seguir reembolsándose
-- por el flujo manual de comprobante (comportamiento sin cambios respecto a
-- hoy) mientras el código nuevo todavía no está confirmado funcionando en
-- producción. Recién cuando esta migración se aplica, commit_order_refund_proof
-- deja de aceptar comprobantes manuales para pedidos pagados por Mercado
-- Pago -- a partir de ahí la única vía es el refund real contra la API de
-- Mercado Pago (begin_mercadopago_order_refund / record_mercadopago_order_refund_result).
--
-- CREATE OR REPLACE sobre la definición vigente (20260906100000): idéntica
-- salvo el guard nuevo al principio. No se edita ninguna migración
-- histórica.

begin;

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
  if v_order.payment_method_id = 'mercadopago' then
    raise exception 'MERCADOPAGO_REQUIRES_REAL_REFUND';
  end if;
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

notify pgrst, 'reload schema';

commit;
