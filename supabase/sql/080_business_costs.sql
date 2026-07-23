create table if not exists public.product_cost_entries (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references public.productos(id) on delete restrict,
  variant_id bigint references public.producto_variantes(id) on delete restrict,
  purchase_date date not null default current_date,
  quantity integer not null check (quantity > 0),
  unit_cost numeric(14, 2) not null check (unit_cost >= 0),
  freight_cost numeric(14, 2) not null default 0 check (freight_cost >= 0),
  tax_cost numeric(14, 2) not null default 0 check (tax_cost >= 0),
  commission_cost numeric(14, 2) not null default 0 check (commission_cost >= 0),
  other_cost numeric(14, 2) not null default 0 check (other_cost >= 0),
  total_cost numeric(14, 2) generated always as (
    quantity * unit_cost + freight_cost + tax_cost + commission_cost + other_cost
  ) stored,
  supplier text,
  document_type text,
  document_number text,
  payment_method text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.business_expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null default current_date,
  category text not null,
  description text,
  amount numeric(14, 2) not null check (amount >= 0),
  recurrence text not null default 'unico' check (
    recurrence in ('unico', 'mensual', 'bimestral', 'trimestral', 'semestral', 'anual')
  ),
  status text not null default 'pagado' check (status in ('pendiente', 'pagado')),
  supplier text,
  payment_method text,
  document_type text,
  document_number text,
  tax_deductible boolean not null default false,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists product_cost_entries_product_date_idx
  on public.product_cost_entries (product_id, variant_id, purchase_date desc);

create index if not exists product_cost_entries_purchase_date_idx
  on public.product_cost_entries (purchase_date desc);

create index if not exists business_expenses_date_category_idx
  on public.business_expenses (expense_date desc, category);

create or replace function public.set_business_cost_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists product_cost_entries_updated_at on public.product_cost_entries;
create trigger product_cost_entries_updated_at
before update on public.product_cost_entries
for each row execute function public.set_business_cost_updated_at();

drop trigger if exists business_expenses_updated_at on public.business_expenses;
create trigger business_expenses_updated_at
before update on public.business_expenses
for each row execute function public.set_business_cost_updated_at();

create or replace function public.audit_business_cost_movement()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_email text;
  v_record_id text;
begin
  select coalesce(profiles.email, users.email::text)
    into v_actor_email
  from auth.users
  left join public.profiles on profiles.id = users.id
  where users.id = v_actor_id;

  v_record_id := case
    when tg_op = 'DELETE' then old.id::text
    else new.id::text
  end;

  insert into public.audit_logs (
    table_name,
    action,
    record_id,
    actor_user_id,
    actor_email,
    before_data,
    after_data
  ) values (
    tg_table_name,
    tg_op,
    v_record_id,
    v_actor_id,
    v_actor_email,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists audit_product_cost_entries on public.product_cost_entries;
create trigger audit_product_cost_entries
after insert or update or delete on public.product_cost_entries
for each row execute function public.audit_business_cost_movement();

drop trigger if exists audit_business_expenses on public.business_expenses;
create trigger audit_business_expenses
after insert or update or delete on public.business_expenses
for each row execute function public.audit_business_cost_movement();

alter table public.product_cost_entries enable row level security;
alter table public.business_expenses enable row level security;

drop policy if exists "Admins manage product costs" on public.product_cost_entries;
create policy "Admins manage product costs"
on public.product_cost_entries
for all
to authenticated
using (public.current_user_role() in ('admin', 'super_admin'))
with check (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Admins manage business expenses" on public.business_expenses;
create policy "Admins manage business expenses"
on public.business_expenses
for all
to authenticated
using (public.current_user_role() in ('admin', 'super_admin'))
with check (public.current_user_role() in ('admin', 'super_admin'));

grant select, insert, update, delete on public.product_cost_entries to authenticated;
grant select, insert, update, delete on public.business_expenses to authenticated;

comment on table public.product_cost_entries is
  'Lotes históricos de compra usados para calcular el costo integral de mercadería.';

comment on table public.business_expenses is
  'Gastos operativos, fiscales y administrativos reales de BEYONIX.';
