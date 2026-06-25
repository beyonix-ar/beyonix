create or replace function public.begin_arca_invoice_processing(p_order_id bigint)
returns table (
  id bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_order public.ordenes%rowtype;
  processing_order_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('beyonix-arca-invoice-processing'));

  select *
    into current_order
  from public.ordenes
  where ordenes.id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if current_order.invoice_status = 'authorized' and current_order.invoice_cae is not null then
    raise exception 'INVOICE_ALREADY_AUTHORIZED';
  end if;

  if current_order.invoice_status = 'processing' then
    raise exception 'INVOICE_ALREADY_PROCESSING';
  end if;

  select ordenes.id
    into processing_order_id
  from public.ordenes
  where ordenes.invoice_status = 'processing'
    and ordenes.id <> p_order_id
  limit 1;

  if processing_order_id is not null then
    raise exception 'INVOICE_PROCESSING_IN_PROGRESS';
  end if;

  update public.ordenes
  set invoice_status = 'processing'
  where ordenes.id = p_order_id
    and (
      ordenes.invoice_status is null
      or ordenes.invoice_status = 'pending'
      or ordenes.invoice_status = 'error'
    )
  returning *
    into current_order;

  if not found then
    raise exception 'INVOICE_ALREADY_PROCESSING';
  end if;

  return query
  select current_order.id;
end;
$$;

revoke all on function public.begin_arca_invoice_processing(bigint) from public;
grant execute on function public.begin_arca_invoice_processing(bigint) to authenticated;
