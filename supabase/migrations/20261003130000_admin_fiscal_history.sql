-- Historial fiscal de solo lectura para Admin. No modifica comprobantes ni su emisión.
begin;

create index if not exists ordenes_fiscal_history_issued_idx
  on public.ordenes (invoice_created_at desc, id desc)
  where invoice_status = 'authorized' and invoice_cae is not null;

create index if not exists order_credit_notes_fiscal_history_issued_idx
  on public.order_credit_notes (authorized_at desc, id desc)
  where status = 'authorized' and cae is not null;

create function public.search_admin_fiscal_history(
  p_kind text,
  p_from date default null,
  p_to date default null,
  p_search text default null,
  p_number text default null,
  p_order text default null,
  p_client text default null,
  p_document text default null,
  p_date date default null,
  p_cae text default null,
  p_amount numeric default null,
  p_status text default null,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_from timestamptz;
  v_to timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_kind not in ('invoice', 'credit_note')
     or p_page is null or p_page < 1 or p_page > 100000
     or p_page_size is null or p_page_size < 1 or p_page_size > 251
     or length(coalesce(p_search, '')) > 120
     or length(coalesce(p_number, '')) > 80
     or length(coalesce(p_order, '')) > 80
     or length(coalesce(p_client, '')) > 120
     or length(coalesce(p_document, '')) > 80
     or length(coalesce(p_cae, '')) > 80
     or p_amount < 0
     or (p_from is not null and p_to is not null and p_from >= p_to) then
    raise exception 'INVALID_FISCAL_HISTORY_FILTER';
  end if;

  v_from := case when p_from is null then null
    else p_from::timestamp at time zone 'America/Argentina/Buenos_Aires' end;
  v_to := case when p_to is null then null
    else p_to::timestamp at time zone 'America/Argentina/Buenos_Aires' end;

  with documents as (
    select 'invoice'::text as kind, o.id::text as id, o.id as order_id,
      o.invoice_point as point, o.invoice_number as number,
      o.cliente_nombre as client, o.cliente_dni as document,
      o.invoice_created_at as issued_at, coalesce(o.invoice_requested_total, o.total) as amount,
      o.invoice_cae as cae, o.invoice_status as status,
      o.invoice_arca_environment as environment,
      null::text as reason, null::integer as original_point,
      null::bigint as original_number
    from public.ordenes o
    where p_kind = 'invoice' and o.invoice_status = 'authorized'
      and o.invoice_cae is not null and o.invoice_number is not null
      and o.invoice_created_at is not null
      and (v_from is null or o.invoice_created_at >= v_from)
      and (v_to is null or o.invoice_created_at < v_to)

    union all

    select 'credit_note'::text, n.id::text, n.order_id,
      n.voucher_point, n.voucher_number,
      o.cliente_nombre, o.cliente_dni,
      n.authorized_at, n.total_amount,
      n.cae, n.status, n.arca_environment,
      n.reason, n.invoice_point, n.invoice_number
    from public.order_credit_notes n
    join public.ordenes o on o.id = n.order_id
    where p_kind = 'credit_note' and n.status = 'authorized'
      and n.cae is not null and n.voucher_number is not null
      and n.authorized_at is not null
      and (v_from is null or n.authorized_at >= v_from)
      and (v_to is null or n.authorized_at < v_to)
  ), filtered as (
    select d.*,
      (d.issued_at at time zone 'America/Argentina/Buenos_Aires')::date as day,
      lpad(d.point::text, 4, '0') || '-' || lpad(d.number::text, 8, '0') as display_number
    from documents d
    where (p_search is null or p_search = '' or position(lower(p_search) in lower(concat_ws(' ',
        d.id, d.order_id::text, 'BX-' || (d.order_id + 1000)::text,
        d.client, d.document, d.cae, d.reason,
        lpad(d.point::text, 4, '0') || '-' || lpad(d.number::text, 8, '0'),
        d.amount::text, d.status))) > 0)
      and (p_number is null or p_number = '' or position(lower(p_number) in lower(
        lpad(d.point::text, 4, '0') || '-' || lpad(d.number::text, 8, '0'))) > 0)
      and (p_order is null or p_order = '' or position(lower(p_order) in lower(
        d.order_id::text || ' BX-' || (d.order_id + 1000)::text)) > 0)
      and (p_client is null or p_client = '' or position(lower(p_client) in lower(coalesce(d.client, ''))) > 0)
      and (p_document is null or p_document = '' or position(lower(p_document) in lower(coalesce(d.document, ''))) > 0)
      and (p_date is null or (d.issued_at at time zone 'America/Argentina/Buenos_Aires')::date = p_date)
      and (p_cae is null or p_cae = '' or position(lower(p_cae) in lower(coalesce(d.cae, ''))) > 0)
      and (p_amount is null or round(d.amount::numeric, 2) = round(p_amount, 2))
      and (p_status is null or p_status = '' or d.status = p_status)
  ), page as (
    select * from filtered
    order by issued_at desc, id desc
    limit p_page_size offset (p_page - 1) * p_page_size
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'items', coalesce((select jsonb_agg(to_jsonb(page) order by issued_at desc, id desc) from page), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.search_admin_fiscal_history(
  text, date, date, text, text, text, text, text, date, text, numeric, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.search_admin_fiscal_history(
  text, date, date, text, text, text, text, text, date, text, numeric, text, integer, integer
) to service_role;

commit;
