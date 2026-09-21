-- Extends admin-cancel-order-schema.sql. Isolated tables; production RPC bodies
-- and inventory refresh/locking triggers are loaded by the integration suite.
grant usage on schema auth to anon, authenticated;
alter table public.ordenes
  add payment_method_id text default 'transferencia',
  add total numeric default 100,
  add original_total numeric default 100,
  add external_amount_due numeric default 100,
  add credit_balance_movement_id uuid,
  add payment_composition jsonb,
  add payment_proof_url text default 'proof',
  add payment_proof_file_name text,
  add payment_confirmed_by uuid,
  add payment_confirmed_at timestamptz,
  add payment_confirmation_observation text,
  add order_change_status text,
  add order_change_extra_amount numeric,
  add andreani_creation_status text,
  add credit_note_status text,
  add credit_note_cae text,
  add credit_note_error text;
create table public.customer_credit_movements (
  id uuid primary key default gen_random_uuid(), user_id uuid, movement_type text,
  amount numeric, description text, source_type text, source_id text, order_id bigint,
  created_by uuid, related_movement_id uuid, source_key text unique,
  resulting_balance numeric, metadata jsonb
);
create function public.get_customer_credit_balance(p_id uuid) returns numeric language sql as $$
  select coalesce(sum(amount), 0) from public.customer_credit_movements where user_id = p_id
$$;
create table public.productos (id bigint primary key, stock integer not null default 10);
create table public.producto_variantes (
  id bigint primary key, producto_id bigint references public.productos(id), stock integer not null default 10
);
create table public.inventory_variant_allocations(variant_id bigint primary key, quantity integer);
grant select on public.productos, public.producto_variantes to service_role;
create table public.external_sales (
  id uuid primary key default gen_random_uuid(), sale_date date not null,
  product_id bigint references public.productos(id), variant_id bigint references public.producto_variantes(id),
  product_name text not null, sku text, quantity integer not null check(quantity > 0),
  unit_price numeric not null, unit_cost numeric not null, gross_amount numeric not null,
  fee_type text, fee_value numeric, fee_amount numeric, shipping_amount numeric,
  other_expense_amount numeric, net_amount numeric, payment_method text, reference text,
  customer_name text, notes text, created_by uuid, updated_by uuid,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  status text not null default 'completed' check(status in ('completed', 'reversed')),
  reversed_at timestamptz, reversed_by uuid, reversal_reason text,
  reversal_amount numeric, reversal_idempotency_key text unique
);
alter table public.external_sales enable row level security;
-- Reproduce the vulnerable grants/policy so the migration must actually revoke them.
grant select, insert, update, delete on public.external_sales to authenticated;
grant all on public.external_sales to service_role;
create policy legacy_admin on public.external_sales to authenticated using (true) with check (true);
-- Only the opening stock + external-sale branches are needed in this fixture.
create view public.inventory_movements as
select id as product_id, null::bigint as variant_id, current_date as movement_date,
  10::bigint as quantity_delta from public.productos
union all
select product_id, variant_id, sale_date, -quantity::bigint from public.external_sales
where product_id is not null and status <> 'reversed';
-- Count actual INSERT trigger executions independently of the derived stock total.
create table public.test_sale_insert_events(id uuid);
create function public.test_record_sale_insert() returns trigger language plpgsql as $$
begin insert into public.test_sale_insert_events values(new.id); return new; end;
$$;
create trigger test_sale_insert after insert on public.external_sales
for each row execute function public.test_record_sale_insert();
