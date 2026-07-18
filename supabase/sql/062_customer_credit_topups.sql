create table if not exists public.customer_credit_topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  customer_name text not null check (length(trim(customer_name)) between 3 and 120),
  customer_dni text not null check (customer_dni ~ '^[0-9]{7,8}$'),
  proof_url text,
  proof_file_name text,
  status text not null default 'en_revision' check (
    status in ('en_revision', 'acreditado', 'rechazado')
  ),
  credited_movement_id uuid references public.customer_credit_movements(id) on delete set null,
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_credit_topups_user_created_idx
  on public.customer_credit_topups (user_id, created_at desc);

alter table public.customer_credit_topups enable row level security;

drop policy if exists "Customers can read own credit topups"
  on public.customer_credit_topups;
create policy "Customers can read own credit topups"
on public.customer_credit_topups
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Admins can manage credit topups"
  on public.customer_credit_topups;
create policy "Admins can manage credit topups"
on public.customer_credit_topups
for all
to authenticated
using (public.current_user_role() in ('admin', 'super_admin'))
with check (public.current_user_role() in ('admin', 'super_admin'));

revoke all on public.customer_credit_topups from anon, authenticated;
grant select on public.customer_credit_topups to authenticated;
grant insert, update, delete on public.customer_credit_topups to authenticated;

insert into storage.buckets (id, name, public)
values ('customer-credit-topups', 'customer-credit-topups', false)
on conflict (id) do update set public = false;
