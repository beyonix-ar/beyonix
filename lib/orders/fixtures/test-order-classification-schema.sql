-- Esquema mínimo para 20261015150000_order_test_archive.sql +
-- 20261124120000_test_order_classification.sql (PGlite y PostgreSQL real).
-- El inventario replica la fuente única: stock = suma de inventory_movements
-- (compras, ventas web que consumen stock, devoluciones vendibles y ajustes),
-- con inventory_order_consumes_stock idéntica a la de producción.
create schema if not exists auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create or replace function auth.role() returns text language sql stable as $$
  select current_setting('request.jwt.claim.role', true)
$$;
create table auth.users (id uuid primary key);
create table public.profiles (id uuid primary key, rol text);
create table public.productos (id bigint primary key, nombre text not null, stock integer not null default 0);
create table public.producto_variantes (
  id bigint primary key, producto_id bigint not null references public.productos(id), nombre text,
  stock integer not null default 0 check (stock >= 0)
);
create table public.ordenes (
  id bigint primary key, usuario_id uuid, estado text, payment_method_id text, payment_status text, financial_status text,
  admin_visible_at timestamptz, paid_at timestamptz, payment_confirmed_at timestamptz, payment_confirmed_amount numeric,
  payment_proof_uploaded_at timestamptz, total numeric, invoice_status text, invoice_cae text,
  credit_note_required boolean default false, refund_pending_at timestamptz, refunded_at timestamptz,
  credit_balance_used numeric default 0, andreani_envio_id text, tracking_number text,
  super_admin_stock_retained_at timestamptz, payment_id text
);
create table public.orden_items (
  id bigint primary key, orden_id bigint not null references public.ordenes(id) on delete cascade,
  producto_id bigint, variante_id bigint, cantidad integer not null, conditioned_stock_id bigint,
  return_restocked_quantity integer not null default 0, return_written_off_quantity integer not null default 0,
  return_inventory_note text, return_inventory_processed_at timestamptz, return_inventory_processed_by uuid
);
create table public.order_credit_notes (id bigserial primary key, order_id bigint, status text, total_amount numeric);
create table public.mercadopago_order_refunds (id bigserial primary key, order_id bigint, status text);
create table public.customer_credit_movements (id bigserial primary key, order_id bigint);
create table public.order_claims (
  id bigserial primary key, order_id bigint, status text, failure_type text, affected_items jsonb not null default '[]'::jsonb
);
create table public.order_audit_events (
  id bigserial primary key, order_id bigint not null, actor_type text not null, actor_id uuid,
  action text not null, previous_status text, new_status text, metadata jsonb, created_at timestamptz not null default now()
);
create table public.order_audit_incident_resolutions (audit_event_id bigint primary key);
create table public.product_cost_entries (
  id bigserial primary key, product_id bigint not null, variant_id bigint not null, received_quantity integer not null
);
create table public.inventory_stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references public.productos(id) on delete restrict,
  variant_id bigint not null references public.producto_variantes(id) on delete restrict,
  adjustment_date date not null default current_date,
  quantity_delta integer not null check (quantity_delta <> 0),
  reason text not null check (length(btrim(reason)) between 3 and 300),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  idempotency_key text unique
);
create table public.inventory_operation_log (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null, variant_id bigint,
  movement_type text not null check (movement_type in (
    'purchase', 'web_sale', 'mercadolibre_sale', 'external_sale',
    'return', 'reclassification', 'write_off', 'repair', 'adjustment')),
  quantity integer not null check (quantity > 0),
  origin text not null check (length(btrim(origin)) between 2 and 80),
  effective_at timestamptz not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_process text not null,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) between 8 and 240),
  source_table text not null, source_id text not null, document_reference text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);
-- Mismas columnas que usa record_order_item_return_reception; la FK a ordenes
-- reproduce el KEY SHARE que toma una recepción sobre el pedido.
create table public.inventory_return_movements (
  id bigserial primary key, source_key text unique,
  order_id bigint references public.ordenes(id) on delete restrict, order_item_id bigint,
  product_id bigint not null, variant_id bigint, quantity integer not null default 0,
  received_quantity integer, sellable_quantity integer not null default 0,
  discounted_quantity integer not null default 0, non_sellable_quantity integer not null default 0,
  discount_percent numeric, discount_reason text, non_sellable_reason text, review_notes text,
  conditioned_active boolean not null default false, conditioned_name text, conditioned_sku text,
  conditioned_color_hex text, conditioned_images jsonb not null default '[]'::jsonb,
  occurred_at timestamptz, approved_by uuid, approved_at timestamptz
);
create table public.local_delivery_return_reservations (
  id bigserial primary key, order_id bigint not null references public.ordenes(id), status text not null default 'active'
);
create table public.audit_logs (
  id bigserial primary key, table_name text, record_id text, action text, after_data jsonb
);
create or replace function public.inventory_order_consumes_stock(p_status text, p_payment_status text)
returns boolean language sql immutable parallel safe as $function$
  select
    coalesce(p_status, '') in (
      'pagado', 'preparado', 'enviado', 'en_camino', 'visita_fallida', 'en_sucursal',
      'retiro_pendiente', 'retiro_vencido', 'en_devolucion', 'devuelto_beyonix', 'entregado', 'approved'
    )
    or (
      coalesce(p_status, '') <> 'cancelado'
      and coalesce(p_payment_status, '') in ('confirmado', 'confirmed', 'approved')
    );
$function$;
create or replace function public.local_delivery_released_quantity(p_order_item_id bigint)
returns integer language sql stable as $$ select 0 $$;
create view public.inventory_movements as
  select e.product_id, e.variant_id, 'purchase'::text as source, e.id::text as source_id,
    e.received_quantity::bigint as quantity_delta
  from public.product_cost_entries e
  union all
  select i.producto_id, i.variante_id, 'web_sale'::text, i.id::text, -i.cantidad::bigint
  from public.orden_items i
  join public.ordenes o on o.id = i.orden_id
  where i.conditioned_stock_id is null
    and (public.inventory_order_consumes_stock(o.estado, o.payment_status) or o.super_admin_stock_retained_at is not null)
  union all
  select r.product_id, r.variant_id, 'approved_return'::text, r.id::text, r.sellable_quantity::bigint
  from public.inventory_return_movements r
  where r.sellable_quantity <> 0
  union all
  select a.product_id, a.variant_id, 'stock_adjustment'::text, a.id::text, a.quantity_delta::bigint
  from public.inventory_stock_adjustments a;
create or replace function public.refresh_inventory_stock(p_product_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  update public.producto_variantes v
  set stock = coalesce((select sum(m.quantity_delta) from public.inventory_movements m
    where m.product_id = v.producto_id and m.variant_id = v.id), 0)
  where v.producto_id = p_product_id;
  update public.productos p
  set stock = coalesce((select sum(m.quantity_delta) from public.inventory_movements m where m.product_id = p.id), 0)
  where p.id = p_product_id;
end;
$$;
-- Como producción (refresh_inventory_after_return_movement): toda devolución
-- recalcula el stock derivado del producto.
create or replace function public.refresh_inventory_after_return_movement()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.refresh_inventory_stock(coalesce(new.product_id, old.product_id));
  return null;
end;
$$;
create trigger refresh_inventory_after_return_movement
  after insert or update or delete on public.inventory_return_movements
  for each row execute function public.refresh_inventory_after_return_movement();
