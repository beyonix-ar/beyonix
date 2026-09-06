-- Reauditoría: dos pestañas y retries de una nota parcial no deben reservar
-- una segunda emisión cuando la primera ya terminó y liberó processing.
begin;
create or replace function public.begin_partial_credit_note(
  p_order_id bigint,p_claim_id bigint,p_destination text,p_reason text,
  p_items_amount numeric,p_manual_amount numeric,p_total_amount numeric,
  p_invoice_point integer,p_invoice_number bigint,p_created_by uuid,
  p_items jsonb,p_operation_type text,p_expected_note_ids uuid[]
)
returns public.order_credit_notes language plpgsql security definer set search_path=public as $$
declare v_ids uuid[]; v_note public.order_credit_notes%rowtype;
begin
  if auth.role() is distinct from 'service_role' or not exists(select 1 from public.profiles where id=p_created_by and rol in ('admin','super_admin')) then raise exception 'CREDIT_NOTE_ACTOR_FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(91091,p_order_id::integer);
  perform id from public.ordenes where id=p_order_id for update;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into v_ids from public.order_credit_notes where order_id=p_order_id and status in ('processing','authorized');
  if p_expected_note_ids is null or v_ids is distinct from (select coalesce(array_agg(x order by x),'{}'::uuid[]) from unnest(p_expected_note_ids) x) then raise exception 'CREDIT_NOTE_SNAPSHOT_CONFLICT'; end if;
  -- El motor canónico conserva importes, elegibilidad, cantidades y permisos.
  select * into v_note from public.begin_partial_credit_note(p_order_id,p_claim_id,p_destination,p_reason,p_items_amount,p_manual_amount,p_total_amount,p_invoice_point,p_invoice_number,p_created_by,p_items,p_operation_type);
  return v_note;
end $$;
-- Sólo el wrapper SECURITY DEFINER puede invocar la firma sin snapshot.
revoke all on function public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text) from public,anon,authenticated,service_role;
revoke all on function public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text,uuid[]) from public,anon,authenticated;
grant execute on function public.begin_partial_credit_note(bigint,bigint,text,text,numeric,numeric,numeric,integer,bigint,uuid,jsonb,text,uuid[]) to service_role;
notify pgrst,'reload schema';
commit;
