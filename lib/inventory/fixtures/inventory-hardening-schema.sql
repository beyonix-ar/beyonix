-- Fixture aislado para FASE 1 (hardening P0/P1 de inventario). Ejercita las
-- RPCs SQL REALES de producción (fetchadas via pg_get_functiondef contra
-- producción el 2026-09-18, no reimplementadas) contra un esquema mínimo:
-- productos/variantes con el CHECK y los guards reales, una vista
-- inventory_movements simplificada (sólo las ramas purchase/web_sale/
-- approved_return/stock_adjustment -- se omiten external_sales/
-- mercadolibre_sales/business_expenses por no ser parte de esta fase),
-- reservas de checkout y devoluciones. Sin red, credenciales ni datos
-- reales.

create role anon;
create role authenticated;
create role service_role bypassrls;

create schema auth;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create table auth.users (id uuid primary key);

-- --- Catálogo -------------------------------------------------------------

create table public.productos (
  id bigint generated always as identity primary key,
  activo boolean not null default true,
  stock integer not null default 0
);

create table public.producto_variantes (
  id bigint generated always as identity primary key,
  producto_id bigint not null references public.productos(id),
  activo boolean not null default true,
  stock integer not null default 0
);

create table public.inventory_variant_allocations (
  variant_id bigint primary key references public.producto_variantes(id),
  quantity integer not null default 0 check (quantity >= 0)
);

-- --- Pedidos ---------------------------------------------------------------

create table public.ordenes (
  id bigint generated always as identity primary key,
  usuario_id uuid,
  estado text not null default 'pendiente',
  payment_status text,
  checkout_idempotency_key text unique,
  created_at timestamptz not null default now()
);

create table public.orden_items (
  id bigint generated always as identity primary key,
  orden_id bigint not null references public.ordenes(id),
  producto_id bigint not null references public.productos(id),
  variante_id bigint references public.producto_variantes(id),
  cantidad integer not null,
  conditioned_stock_id uuid,
  return_restocked_quantity integer,
  return_written_off_quantity integer,
  return_inventory_note text,
  return_inventory_processed_at timestamptz,
  return_inventory_processed_by uuid
);

create table public.order_audit_events (
  id bigint generated always as identity primary key,
  order_id bigint,
  actor_type text,
  actor_id uuid,
  action text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- --- Compras (rama "purchase" del ledger) ----------------------------------

create table public.product_cost_entries (
  id bigint generated always as identity primary key,
  product_id bigint references public.productos(id),
  variant_id bigint references public.producto_variantes(id),
  received_quantity integer not null default 0,
  purchase_date date not null default current_date,
  created_at timestamptz not null default now(),
  created_by uuid,
  idempotency_key text,
  document_number text
);

-- --- Devoluciones físicas (rama "approved_return") -------------------------

create table public.conditioned_inventory_offers (
  id uuid primary key default gen_random_uuid(),
  product_id bigint references public.productos(id),
  available_quantity integer not null default 0
);

create table public.inventory_return_movements (
  id bigint generated always as identity primary key,
  source_key text not null unique,
  order_id bigint,
  order_item_id bigint,
  mercadolibre_sale_id bigint,
  product_id bigint references public.productos(id),
  variant_id bigint references public.producto_variantes(id),
  quantity integer not null,
  sellable_quantity integer not null default 0,
  non_sellable_quantity integer not null default 0,
  conditioned_active boolean not null default false,
  approved_by uuid,
  approved_at timestamptz,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Mismo comportamiento que la migración real 20260730174000 (línea 57): una
-- devolución no condicionada (conditioned_active=false, el único caso que
-- ejercitan estos tests) normaliza sellable_quantity = quantity. No se
-- reimplementa el flujo condicionado completo (fuera de alcance de esta
-- fase).
create function public.normalize_return_sellable_quantity()
returns trigger language plpgsql as $$
begin
  if not coalesce(new.conditioned_active, false) then
    new.sellable_quantity := new.quantity;
    new.non_sellable_quantity := 0;
  end if;
  return new;
end;
$$;

create trigger normalize_return_sellable_quantity
  before insert on public.inventory_return_movements
  for each row execute function public.normalize_return_sellable_quantity();

-- Equivalente de refresh_inventory_after_return_movement (confirmado activo
-- en producción vía los bloques DISABLE/ENABLE TRIGGER de las migraciones
-- de force-delete, aunque no forma parte de las 5 piezas que esta fase
-- reproduce explícitamente en supabase/migrations/ -- sin este trigger acá
-- una devolución nunca recalcularía nada y el fixture no reflejaría la
-- realidad).
create function public.refresh_inventory_from_return_movement()
returns trigger language plpgsql as $$
begin
  perform public.refresh_inventory_stock(new.product_id);
  return new;
end;
$$;

create trigger refresh_inventory_after_return_movement
  after insert on public.inventory_return_movements
  for each row execute function public.refresh_inventory_from_return_movement();

-- --- Ajustes manuales (rama "stock_adjustment") -----------------------------

create table public.inventory_stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references public.productos(id),
  variant_id bigint not null references public.producto_variantes(id),
  adjustment_date date not null default current_date,
  quantity_delta integer not null,
  reason text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  idempotency_key text
);

create table public.inventory_operation_log (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null,
  variant_id bigint,
  movement_type text not null,
  quantity integer not null,
  origin text not null,
  effective_at timestamptz not null,
  actor_user_id uuid,
  actor_process text not null,
  idempotency_key text not null unique,
  source_table text not null,
  source_id text not null,
  document_reference text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  table_name text,
  record_id text,
  action text,
  before_data jsonb,
  after_data jsonb
);

-- --- Reservas de checkout ---------------------------------------------------

create table public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  user_id uuid,
  product_id bigint not null references public.productos(id),
  variant_id bigint references public.producto_variantes(id),
  conditioned_stock_id uuid,
  quantity integer not null,
  order_id bigint,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

