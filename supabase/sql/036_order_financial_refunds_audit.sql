alter table public.ordenes
  add column if not exists financial_status text not null default 'pending_payment',
  add column if not exists payment_confirmed_by uuid references auth.users(id) on delete set null,
  add column if not exists payment_confirmed_at timestamptz,
  add column if not exists payment_confirmed_amount numeric(12, 2),
  add column if not exists payment_confirmation_observation text,
  add column if not exists cancellation_requested_by uuid references auth.users(id) on delete set null,
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists refund_pending_at timestamptz,
  add column if not exists refund_proof_url text,
  add column if not exists refund_proof_file_name text,
  add column if not exists refund_proof_mime_type text,
  add column if not exists refund_proof_file_size bigint,
  add column if not exists refund_amount numeric(12, 2),
  add column if not exists refund_method text,
  add column if not exists refund_observation text,
  add column if not exists refund_internal_note text,
  add column if not exists refund_uploaded_by uuid references auth.users(id) on delete set null,
  add column if not exists refund_uploaded_at timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by uuid references auth.users(id) on delete set null,
  add column if not exists credit_note_required boolean not null default false,
  add column if not exists credit_note_issued boolean not null default false,
  add column if not exists credit_note_number text,
  add column if not exists credit_note_issued_at timestamptz;

alter table public.ordenes
  drop constraint if exists ordenes_financial_status_check;

alter table public.ordenes
  add constraint ordenes_financial_status_check check (
    financial_status in (
      'pending_payment',
      'payment_submitted',
      'payment_confirmed',
      'cancellation_requested',
      'refund_pending',
      'refunded',
      'cancelled'
    )
  );

create index if not exists ordenes_financial_status_idx
  on public.ordenes (financial_status, created_at desc);

create index if not exists ordenes_refund_pending_idx
  on public.ordenes (refund_pending_at desc)
  where financial_status = 'refund_pending';

update public.ordenes
set financial_status = case
  when estado = 'cancelado'
    and (
      coalesce(payment_status, '') in ('confirmado', 'approved', 'confirmed')
      or paid_at is not null
    )
    then 'refund_pending'
  when estado = 'cancelado' then 'cancelled'
  when coalesce(payment_status, '') in ('confirmado', 'approved', 'confirmed')
    or estado in ('pagado', 'enviado', 'en_camino', 'entregado')
    then 'payment_confirmed'
  when payment_proof_url is not null
    and coalesce(payment_status, '') in ('en_revision', 'pendiente_comprobante', 'pending')
    then 'payment_submitted'
  else 'pending_payment'
end
where financial_status = 'pending_payment';

update public.ordenes
set
  payment_confirmed_at = coalesce(payment_confirmed_at, paid_at),
  payment_confirmed_amount = coalesce(payment_confirmed_amount, total)
where financial_status in ('payment_confirmed', 'refund_pending', 'refunded')
  and payment_confirmed_at is null
  and paid_at is not null;

update public.ordenes
set
  cancellation_requested_at = coalesce(cancellation_requested_at, cancelled_at),
  refund_pending_at = coalesce(refund_pending_at, cancelled_at),
  credit_note_required = (
    invoice_status = 'authorized'
    or invoice_cae is not null
    or (invoice_number is not null and invoice_point is not null)
  )
where financial_status = 'refund_pending';

create table if not exists public.order_refund_proofs (
  id bigserial primary key,
  order_id bigint not null references public.ordenes(id) on delete cascade,
  uploaded_by uuid references auth.users(id) on delete set null,
  file_name text not null,
  file_path text not null,
  mime_type text not null,
  file_size bigint not null,
  amount numeric(12, 2) not null,
  method text,
  observation text,
  created_at timestamptz not null default now()
);

create index if not exists order_refund_proofs_order_created_idx
  on public.order_refund_proofs (order_id, created_at desc);

alter table public.order_refund_proofs enable row level security;

drop policy if exists "Admins can read refund proofs"
  on public.order_refund_proofs;
create policy "Admins can read refund proofs"
on public.order_refund_proofs
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('admin', 'super_admin')
  )
);

drop policy if exists "Customers can read own refund proofs"
  on public.order_refund_proofs;
create policy "Customers can read own refund proofs"
on public.order_refund_proofs
for select
to authenticated
using (
  exists (
    select 1
    from public.ordenes
    where ordenes.id = order_refund_proofs.order_id
      and ordenes.usuario_id = auth.uid()
  )
);

create table if not exists public.order_audit_events (
  id bigserial primary key,
  order_id bigint not null references public.ordenes(id) on delete cascade,
  actor_type text not null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  previous_status text,
  new_status text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint order_audit_events_actor_type_check check (
    actor_type in ('customer', 'admin', 'system')
  )
);

create index if not exists order_audit_events_order_created_idx
  on public.order_audit_events (order_id, created_at asc);

alter table public.order_audit_events enable row level security;

drop policy if exists "Admins can read order audit events"
  on public.order_audit_events;
create policy "Admins can read order audit events"
on public.order_audit_events
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('admin', 'super_admin')
  )
);

grant select on public.order_refund_proofs to authenticated;
grant select on public.order_audit_events to authenticated;
