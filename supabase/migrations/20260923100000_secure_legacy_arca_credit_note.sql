begin;

-- Legacy RPC: no callers in app/lib. Preserve its signature and behavior for
-- controlled backend callers, while making the remote definition reproducible.
create or replace function public.begin_arca_credit_note_processing(p_order_id bigint)
returns table(id bigint)
language plpgsql security definer set search_path = public
as $$
declare
  current_order public.ordenes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('beyonix-arca-credit-note-processing'));
  select * into current_order from public.ordenes where ordenes.id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if current_order.credit_note_status = 'authorized' and current_order.credit_note_cae is not null then
    raise exception 'CREDIT_NOTE_ALREADY_AUTHORIZED';
  end if;
  if current_order.credit_note_status = 'processing' then
    raise exception 'CREDIT_NOTE_ALREADY_PROCESSING';
  end if;
  if exists (select 1 from public.ordenes where credit_note_status = 'processing' and ordenes.id <> p_order_id) then
    raise exception 'CREDIT_NOTE_PROCESSING_IN_PROGRESS';
  end if;
  update public.ordenes set credit_note_status = 'processing', credit_note_error = null, credit_note_required = true
  where ordenes.id = p_order_id and (credit_note_status is null or credit_note_status in ('pending', 'error'))
  returning * into current_order;
  if not found then raise exception 'CREDIT_NOTE_ALREADY_PROCESSING'; end if;
  return query select current_order.id;
end;
$$;
revoke all on function public.begin_arca_credit_note_processing(bigint) from public, anon, authenticated;
grant execute on function public.begin_arca_credit_note_processing(bigint) to service_role;
notify pgrst, 'reload schema';
commit;
