create table if not exists public.customer_store_benefits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_order_id bigint references public.ordenes(id) on delete set null,
  used_order_id bigint references public.ordenes(id) on delete set null,
  benefit_type text not null check (benefit_type in ('gift_card', 'discount')),
  code text not null unique,
  percent integer not null check (percent between 1 and 100),
  status text not null default 'active' check (status in ('active', 'used', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists customer_store_benefits_source_type_idx
  on public.customer_store_benefits (source_order_id, benefit_type)
  where source_order_id is not null;

create index if not exists customer_store_benefits_user_status_idx
  on public.customer_store_benefits (user_id, status, created_at desc);

alter table public.customer_store_benefits enable row level security;

drop policy if exists "Customers can read own store benefits"
  on public.customer_store_benefits;
create policy "Customers can read own store benefits"
on public.customer_store_benefits
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Admins can create store benefits"
  on public.customer_store_benefits;
create policy "Admins can create store benefits"
on public.customer_store_benefits
for insert
to authenticated
with check (
  public.current_user_role() in ('admin', 'super_admin')
);

revoke all on public.customer_store_benefits from anon, authenticated;
grant select, insert on public.customer_store_benefits to authenticated;

alter table public.ordenes
  add column if not exists store_benefit_id uuid references public.customer_store_benefits(id) on delete set null,
  add column if not exists store_benefit_code text,
  add column if not exists store_benefit_type text,
  add column if not exists store_benefit_percent integer,
  add column if not exists store_benefit_discount_amount numeric(12, 2);
