alter table public.ordenes
  add column if not exists credit_note_status text,
  add column if not exists credit_note_point integer,
  add column if not exists credit_note_cae text,
  add column if not exists credit_note_cae_due date,
  add column if not exists credit_note_created_at timestamptz,
  add column if not exists credit_note_amount numeric(12, 2),
  add column if not exists credit_note_error text;

alter table public.ordenes
  drop constraint if exists ordenes_credit_note_status_check;

alter table public.ordenes
  add constraint ordenes_credit_note_status_check
  check (
    credit_note_status is null
    or credit_note_status in ('pending', 'processing', 'authorized', 'error')
  );

create or replace function public.begin_arca_credit_note_processing(p_order_id bigint)
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
  perform pg_advisory_xact_lock(hashtext('beyonix-arca-credit-note-processing'));

  select *
    into current_order
  from public.ordenes
  where ordenes.id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if current_order.credit_note_status = 'authorized' and current_order.credit_note_cae is not null then
    raise exception 'CREDIT_NOTE_ALREADY_AUTHORIZED';
  end if;

  if current_order.credit_note_status = 'processing' then
    raise exception 'CREDIT_NOTE_ALREADY_PROCESSING';
  end if;

  select ordenes.id
    into processing_order_id
  from public.ordenes
  where ordenes.credit_note_status = 'processing'
    and ordenes.id <> p_order_id
  limit 1;

  if processing_order_id is not null then
    raise exception 'CREDIT_NOTE_PROCESSING_IN_PROGRESS';
  end if;

  update public.ordenes
  set credit_note_status = 'processing',
      credit_note_error = null,
      credit_note_required = true
  where ordenes.id = p_order_id
    and (
      ordenes.credit_note_status is null
      or ordenes.credit_note_status = 'pending'
      or ordenes.credit_note_status = 'error'
    )
  returning *
    into current_order;

  if not found then
    raise exception 'CREDIT_NOTE_ALREADY_PROCESSING';
  end if;

  return query
  select current_order.id;
end;
$$;

revoke all on function public.begin_arca_credit_note_processing(bigint) from public;
grant execute on function public.begin_arca_credit_note_processing(bigint) to authenticated;
