-- Formaliza como migración el esquema y el RPC de Notas de Crédito C
-- parciales, que hasta ahora solo existían aplicados a mano vía
-- supabase/sql/091_partial_credit_notes.sql (nunca representados en
-- supabase/migrations/). Contenido trasladado sin cambios funcionales;
-- todas las sentencias son idempotentes, por lo que reaplicar esto sobre
-- el remoto ya migrado no tiene efecto.
--
-- Fecha del archivo: 091_partial_credit_notes.sql se aplicó a mano el
-- 2026-07-27, antes de que supabase/migrations/ arrancara (2026-07-29,
-- 20260729181537_remote_schema.sql, baseline vacío porque el esquema ya
-- existía). Por eso esta formalización va inmediatamente después del
-- baseline y no en la fecha en que se escribió este archivo: varias
-- migraciones posteriores (20260816135000_temp_reset_diagnostic.sql,
-- 20260816138000_temp_reset_diagnostic_fix2.sql y sobre todo
-- 20260816140000_reset_commercial_test_data.sql) ya hacen DELETE contra
-- order_credit_notes/order_credit_note_items, así que estas tablas tienen
-- que existir antes de esa fecha para que la historia de migraciones sea
-- reproducible desde cero. Ubicarla después del baseline (en vez de, por
-- ejemplo, justo antes de 20260816135000) también refleja con más
-- fidelidad cuándo existieron realmente en el remoto.

create table if not exists public.order_credit_notes (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null references public.ordenes(id) on delete restrict,
  claim_id bigint references public.order_claims(id) on delete set null,
  status text not null default 'processing'
    check (status in ('processing', 'authorized', 'error')),
  destination text not null default 'external_refund'
    check (destination in ('external_refund', 'customer_balance', 'none')),
  reason text not null,
  items_amount numeric(12, 2) not null default 0 check (items_amount >= 0),
  manual_amount numeric(12, 2) not null default 0 check (manual_amount >= 0),
  total_amount numeric(12, 2) not null check (total_amount > 0),
  invoice_point integer not null check (invoice_point > 0),
  invoice_number bigint not null check (invoice_number > 0),
  voucher_point integer,
  voucher_number bigint,
  cae text,
  cae_due date,
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  authorized_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint order_credit_notes_amount_breakdown
    check (total_amount = items_amount + manual_amount),
  constraint order_credit_notes_authorization_complete
    check (
      status <> 'authorized'
      or (
        voucher_point is not null
        and voucher_number is not null
        and cae is not null
        and cae_due is not null
        and authorized_at is not null
      )
    )
);

create table if not exists public.order_credit_note_items (
  id bigint generated always as identity primary key,
  credit_note_id uuid not null references public.order_credit_notes(id) on delete restrict,
  order_item_id bigint not null references public.orden_items(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_amount numeric(12, 4) not null check (unit_amount >= 0),
  total_amount numeric(12, 2) not null check (total_amount >= 0),
  product_name text not null,
  variant_name text,
  created_at timestamptz not null default now(),
  unique (credit_note_id, order_item_id)
);

create index if not exists order_credit_notes_order_created_idx
  on public.order_credit_notes(order_id, created_at desc);

create index if not exists order_credit_note_items_order_item_idx
  on public.order_credit_note_items(order_item_id);

create unique index if not exists order_credit_notes_voucher_unique
  on public.order_credit_notes(voucher_point, voucher_number)
  where voucher_point is not null and voucher_number is not null;

-- ARCA numera los comprobantes en forma correlativa. Solo se permite una
-- solicitud de Nota de Crédito C en vuelo para evitar solicitar el mismo número
-- desde dos pedidos distintos.
create unique index if not exists order_credit_notes_single_processing
  on public.order_credit_notes(status)
  where status = 'processing';

alter table public.order_credit_notes enable row level security;
alter table public.order_credit_note_items enable row level security;

revoke all on table public.order_credit_notes from anon, authenticated;
revoke all on table public.order_credit_note_items from anon, authenticated;

insert into public.order_credit_notes (
  order_id,
  status,
  destination,
  reason,
  items_amount,
  manual_amount,
  total_amount,
  invoice_point,
  invoice_number,
  voucher_point,
  voucher_number,
  cae,
  cae_due,
  created_at,
  authorized_at,
  updated_at
)
select
  orders.id,
  'authorized',
  case
    when exists (
      select 1
      from public.customer_credit_movements movement
      where movement.order_id = orders.id
        and movement.source_type = 'credit_note'
        and movement.movement_type = 'credit'
    ) then 'customer_balance'
    else 'external_refund'
  end,
  'Nota de crédito histórica migrada',
  0,
  round(orders.credit_note_amount::numeric, 2),
  round(orders.credit_note_amount::numeric, 2),
  orders.invoice_point,
  orders.invoice_number,
  orders.credit_note_point,
  orders.credit_note_number::bigint,
  orders.credit_note_cae,
  orders.credit_note_cae_due,
  coalesce(
    orders.credit_note_created_at,
    orders.credit_note_issued_at,
    orders.created_at
  ),
  coalesce(
    orders.credit_note_created_at,
    orders.credit_note_issued_at,
    orders.created_at
  ),
  now()
from public.ordenes orders
where orders.credit_note_status = 'authorized'
  and orders.credit_note_cae is not null
  and orders.credit_note_number is not null
  and orders.credit_note_number ~ '^[0-9]+$'
  and orders.credit_note_point is not null
  and orders.credit_note_amount > 0
  and orders.invoice_point is not null
  and orders.invoice_number is not null
  and not exists (
    select 1
    from public.order_credit_notes note
    where note.order_id = orders.id
      and note.voucher_point = orders.credit_note_point
      and note.voucher_number = orders.credit_note_number::bigint
  )
on conflict do nothing;

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
  p_items jsonb
)
returns public.order_credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note public.order_credit_notes;
  v_invoice_total numeric(12, 2);
  v_committed_total numeric(12, 2);
  v_item jsonb;
  v_order_item public.orden_items;
  v_committed_quantity integer;
begin
  perform pg_advisory_xact_lock(91091, p_order_id::integer);

  update public.order_credit_notes
  set status = 'error',
      error = 'La emisión quedó interrumpida antes de contactar a ARCA.',
      updated_at = now()
  where status = 'processing'
    and created_at < now() - interval '5 minutes';

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

  select round(total::numeric, 2)
  into v_invoice_total
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

  select coalesce(sum(total_amount), 0)
  into v_committed_total
  from public.order_credit_notes
  where order_id = p_order_id
    and status in ('processing', 'authorized');

  if round(v_committed_total + p_total_amount, 2) > v_invoice_total then
    raise exception 'CREDIT_NOTE_EXCEEDS_INVOICE';
  end if;

  if p_claim_id is not null and not exists (
    select 1
    from public.order_claims
    where id = p_claim_id and order_id = p_order_id
  ) then
    raise exception 'INVALID_CREDIT_NOTE_CLAIM';
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
    created_by
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
    p_created_by
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
  integer, bigint, uuid, jsonb
) from public, anon, authenticated;

grant execute on function public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb
) to service_role;

comment on table public.order_credit_notes is
  'Notas de Crédito C parciales o totales. Solo status=authorized representa un comprobante fiscal válido.';

comment on column public.order_credit_notes.manual_amount is
  'Ajuste fiscal manual no asociado a una línea, por ejemplo envío u otra diferencia justificada.';

do $$
begin
  alter publication supabase_realtime add table public.order_credit_notes;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.order_credit_note_items;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
