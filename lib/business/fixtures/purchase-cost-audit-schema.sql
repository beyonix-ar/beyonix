-- Fixture aislado para Auditoría 3/7 (compras/costos), Fase 5: ejercita las
-- RPCs SQL REALES agregadas/modificadas en esta fase --
-- audit_business_cost_movement (20260801093000, sin cambios), el trigger que
-- la conecta y el force_delete_purchase_super_admin modificado
-- (20260918160000), y get_purchase_force_delete_impact (20260918170000) --
-- contra un esquema mínimo que reproduce sólo las columnas que esas
-- funciones tocan. Sin red, credenciales ni datos reales.

create role anon;
create role authenticated;
create role service_role bypassrls;

create schema auth;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('beyonix.actor_id', true), '')::uuid
$$;
create table auth.users (id uuid primary key, email text);

-- En Supabase real, `auth` es un schema del sistema con USAGE/EXECUTE
-- otorgado por defecto a anon/authenticated/service_role (así funciona
-- auth.uid() en cualquier policy RLS de cualquier proyecto). Acá se recrea
-- a mano, así que hay que otorgarlo explícitamente para que las policies que
-- llaman a auth.uid()/auth.role() directamente (sin pasar por una función
-- security definer que ya corre como el owner) no fallen por falta de
-- privilegio sobre el schema.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users(id),
  rol text not null default 'admin',
  email text
);

create table public.productos (
  id bigint generated always as identity primary key,
  stock integer not null default 0
);

create table public.producto_variantes (
  id bigint generated always as identity primary key,
  producto_id bigint not null references public.productos(id),
  stock integer not null default 0
);

-- Mismas columnas/CHECK relevantes que supabase/sql/080_business_costs.sql +
-- 20260801093000_atomic_product_purchases.sql -- todas las que
-- save_product_purchase_atomic inserta/actualiza, para poder cargar esa
-- función real sin modificarla.
create table public.product_cost_entries (
  id uuid primary key default gen_random_uuid(),
  product_id bigint references public.productos(id),
  variant_id bigint references public.producto_variantes(id),
  article_name text,
  sku text,
  purchase_date date not null default current_date,
  quantity integer not null check (quantity > 0),
  received_quantity integer not null default 0,
  reception_status text not null default 'recibida'
    check (reception_status in ('pendiente', 'parcial', 'recibida', 'anulada')),
  unit_cost numeric(14, 2) not null default 0 check (unit_cost >= 0),
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
  created_by uuid,
  created_at timestamptz not null default now()
);

-- Reproduce el estado REAL de producción confirmado en vivo (solo lectura,
-- 2026-09-18/19, ver reporte de Auditoría 3/7 "cierre final"): grant directo
-- de INSERT/UPDATE/DELETE a `authenticated` y `anon`, RLS enabled con una
-- policy permisiva FOR ALL para `authenticated` con rol admin/super_admin
-- (supabase/sql/080_business_costs.sql:130-150, nunca reproducida en
-- migrations/). Es la línea de base "antes" contra la que
-- 20260918180000_revoke_direct_writes_on_product_cost_entries.sql se
-- ejercita en los tests -- para probar el ANTES/DESPUÉS real del fix, no
-- sólo documentarlo.
create function public.current_user_role() returns text language sql stable as $$
  select rol from public.profiles where id = auth.uid()
$$;
grant execute on function public.current_user_role() to anon, authenticated, service_role;
grant select on public.profiles to anon, authenticated, service_role;

-- El grant a `service_role` también reproduce lo confirmado en vivo (no es
-- sólo bypassrls -- Supabase le otorga los mismos privilegios de tabla que
-- a authenticated). Sin este grant explícito, el backend (que usa
-- service_role) no podría ni siquiera pasar por el camino RPC/security
-- definer en un Postgres real, aunque bypassrls lo exima de las policies.
grant select, insert, update, delete on public.product_cost_entries
  to authenticated, anon, service_role;

alter table public.product_cost_entries enable row level security;
create policy "Admins manage product costs" on public.product_cost_entries for all to authenticated
using (current_user_role() = any (array['admin', 'super_admin']))
with check (current_user_role() = any (array['admin', 'super_admin']));

create table public.ordenes (
  id bigint generated always as identity primary key,
  estado text not null default 'pendiente',
  payment_status text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.orden_items (
  id bigint generated always as identity primary key,
  orden_id bigint not null references public.ordenes(id),
  producto_id bigint not null references public.productos(id),
  variante_id bigint references public.producto_variantes(id),
  cantidad integer not null,
  costo_unitario_historico numeric(12, 2)
);

create table public.external_sales (
  id uuid primary key default gen_random_uuid(),
  sale_date date not null default current_date,
  product_id bigint references public.productos(id),
  variant_id bigint references public.producto_variantes(id),
  costo_unitario_historico numeric(12, 2)
);

create table public.mercadolibre_sales (
  id bigint generated always as identity primary key,
  sale_date date not null default current_date,
  product_id bigint references public.productos(id),
  costo_unitario_historico numeric(12, 2)
);

-- Sólo para que 20260918150000_purchase_inventory_refresh_reproducibility.sql
-- pueda crear sus 5 triggers sin fallar por tabla inexistente -- no son objeto
-- de esta fase (gastos/devoluciones), así que quedan mínimas.
create table public.business_expenses (
  id bigint generated always as identity primary key,
  product_id bigint references public.productos(id)
);

create table public.inventory_return_movements (
  id bigint generated always as identity primary key,
  product_id bigint references public.productos(id)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  table_name text,
  action text,
  record_id text,
  actor_user_id uuid,
  actor_email text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

-- Stub deliberadamente simple: la matemática exacta de stock derivado ya
-- está cubierta por lib/inventory/inventory-hardening.test.ts (Auditoría
-- 1/7). Acá sólo hace falta que la función EXISTA (y respete el mismo GUC
-- que guard_derived_inventory_stock exige -- ver 20260918110000/20260918100000
-- -- para no romper el INSERT/UPDATE de las tablas que sí se ejercitan acá,
-- p. ej. orden_items vía refresh_inventory_after_order_item).
create function public.refresh_inventory_stock(p_product_id bigint)
returns void language plpgsql as $$
begin
  perform set_config('beyonix.inventory_refresh', 'on', true);
  update public.productos
  set stock = coalesce(
    (select sum(received_quantity) from public.product_cost_entries where product_id = p_product_id),
    0
  )
  where id = p_product_id;
end;
$$;
