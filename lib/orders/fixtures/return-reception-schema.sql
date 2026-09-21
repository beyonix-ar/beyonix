-- Fixture aislado para Auditoría 4/7 (devoluciones), Fase 5: ejercita las
-- RPCs SQL REALES agregadas/modificadas en esta fase --
-- record_order_item_return_reception, process_claim_return_inventory,
-- review_mercadolibre_return -- contra un esquema mínimo que reproduce sólo
-- las columnas/tablas que esas funciones tocan. Sin red, credenciales ni
-- datos reales.

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
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users(id),
  rol text not null default 'admin',
  email text
);
create function public.current_user_role() returns text language sql stable as $$
  select rol from public.profiles where id = auth.uid()
$$;
grant execute on function public.current_user_role() to anon, authenticated, service_role;
grant select on public.profiles to anon, authenticated, service_role;

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
  precio numeric(12, 2) not null default 0,
  return_restocked_quantity integer not null default 0,
  return_written_off_quantity integer not null default 0,
  return_inventory_note text,
  return_inventory_processed_at timestamptz,
  return_inventory_processed_by uuid
);

create table public.order_claims (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.ordenes(id),
  user_id uuid,
  status text not null default 'recibido',
  failure_type text,
  resolution text,
  affected_items jsonb not null default '[]'::jsonb
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

-- Función genérica real (confirmada en vivo, ya usada por orden_items_
-- audit_log_trigger entre otras) -- 20260920100000 la adjunta también a
-- inventory_return_movements.
create or replace function public.audit_log_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor_user_id uuid;
  v_actor_email text;
  v_record_id text;
begin
  if current_setting('app.audit_skip', true) = 'true' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_actor_user_id := auth.uid();

  select profiles.email into v_actor_email
  from public.profiles where profiles.id = v_actor_user_id;

  if tg_op = 'DELETE' then
    v_record_id := old.id::text;
  else
    v_record_id := new.id::text;
  end if;

  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, actor_email, before_data, after_data
  ) values (
    tg_table_name, tg_op, v_record_id, v_actor_user_id, v_actor_email,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create table public.mercadolibre_sales (
  id uuid primary key default gen_random_uuid(),
  sale_date timestamptz not null default now(),
  product_id bigint references public.productos(id),
  quantity integer not null default 1,
  raw_data jsonb not null default '{}'::jsonb
);
create function public.inventory_ml_variant_id(p_raw_data jsonb) returns bigint language sql immutable as $$
  select nullif(p_raw_data->'beyonix_cost_mapping'->>'variant_id', '')::bigint
$$;

-- Dependencias de sync_conditioned_catalog_sku_registry (no ejercitadas por
-- los tests de esta fase, que no usan discounted_quantity > 0 -- se agregan
-- igual para que la migración real cargue sin sorpresas).
create table public.catalog_sku_registry (
  normalized_sku text primary key,
  product_id bigint,
  variant_id bigint,
  conditioned_stock_id uuid
);
create function public.normalized_catalog_sku(p_sku text) returns text language sql immutable as $$
  select nullif(upper(btrim(coalesce(p_sku, ''))), '');
$$;

-- refresh_inventory_from_row() real (reproducida también en
-- 20260918150000; se repite acá porque esa migración adjunta triggers a
-- tablas -- product_cost_entries, business_expenses, external_sales -- que
-- no son parte de este fixture). refresh_inventory_after_return_movement
-- (creada por la migración real que este test carga) la necesita para
-- existir.
create or replace function public.refresh_inventory_from_row()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old_product_id bigint;
  v_new_product_id bigint;
begin
  v_old_product_id := case when tg_op <> 'INSERT' then old.product_id else null end;
  v_new_product_id := case when tg_op <> 'DELETE' then new.product_id else null end;

  if v_old_product_id is not null then
    perform public.refresh_inventory_stock(v_old_product_id);
  end if;
  if v_new_product_id is not null
     and v_new_product_id is distinct from v_old_product_id then
    perform public.refresh_inventory_stock(v_new_product_id);
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

-- Dependencias de adjust_variant_stock_idempotent (Fase 3, reemplazos) --
-- mínimas, sólo lo que esa función real toca.
create table public.inventory_stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references public.productos(id),
  variant_id bigint not null references public.producto_variantes(id),
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

-- Stub que SÍ recompone a nivel producto Y variante (a diferencia del
-- stub simple de otras fases): los tests de reemplazo (Fase 3) necesitan
-- que adjust_variant_stock_idempotent y esta función se compongan
-- correctamente, igual que en producción (inventory_movements suma
-- devoluciones + ajustes manuales, entre otras fuentes). La matemática
-- exacta de stock derivado en general ya está cubierta por
-- lib/inventory/inventory-hardening.test.ts (Auditoría 1/7).
create function public.refresh_inventory_stock(p_product_id bigint)
returns void language plpgsql as $$
begin
  perform set_config('beyonix.inventory_refresh', 'on', true);
  update public.productos
  set stock = coalesce(
    (select sum(sellable_quantity) from public.inventory_return_movements where product_id = p_product_id and variant_id is null),
    0
  ) + coalesce(
    (select sum(quantity_delta) from public.inventory_stock_adjustments where product_id = p_product_id and variant_id is null),
    0
  )
  where id = p_product_id;

  update public.producto_variantes v
  set stock = coalesce(
    (select sum(m.sellable_quantity) from public.inventory_return_movements m where m.variant_id = v.id), 0
  ) + coalesce(
    (select sum(a.quantity_delta) from public.inventory_stock_adjustments a where a.variant_id = v.id), 0
  )
  where v.producto_id = p_product_id;
end;
$$;

-- adjust_variant_stock_idempotent real (confirmada en vivo, sin cambios en
-- esta fase) -- reutilizada por create_order_replacement.
create or replace function public.adjust_variant_stock_idempotent(
  p_variant_id bigint, p_new_quantity integer, p_reason text, p_actor_id uuid, p_idempotency_key text
)
returns producto_variantes
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_variant public.producto_variantes%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_delta integer;
begin
  if v_key is null or length(v_key) < 8 or length(v_key) > 240 then
    raise exception 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_new_quantity is null or p_new_quantity < 0 then
    raise exception 'La cantidad no puede ser negativa.';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Indicá un motivo para el ajuste.';
  end if;

  perform pg_advisory_xact_lock(hashtext('inventory-stock-adjustment'), hashtext(v_key));

  if exists (select 1 from public.inventory_operation_log log where log.idempotency_key = v_key) then
    select * into v_variant from public.producto_variantes where id = p_variant_id;
    if not found then raise exception 'La variante ya no existe.'; end if;
    return v_variant;
  end if;

  select * into v_variant from public.producto_variantes where id = p_variant_id for update;
  if not found then raise exception 'La variante ya no existe.'; end if;

  perform pg_advisory_xact_lock(93000, v_variant.producto_id::integer);

  v_delta := p_new_quantity - coalesce(v_variant.stock, 0);
  if v_delta = 0 then return v_variant; end if;

  insert into public.inventory_stock_adjustments (product_id, variant_id, quantity_delta, reason, created_by, idempotency_key)
  values (v_variant.producto_id, p_variant_id, v_delta, v_reason, p_actor_id, v_key);

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  perform public.refresh_inventory_stock(v_variant.producto_id);

  insert into public.inventory_operation_log (
    product_id, variant_id, movement_type, quantity, origin, effective_at,
    actor_user_id, actor_process, idempotency_key, source_table, source_id,
    document_reference, metadata
  ) values (
    v_variant.producto_id, p_variant_id, 'adjustment', abs(v_delta),
    'admin_stock_adjustment', now(), p_actor_id,
    'adjust_variant_stock_idempotent', v_key, 'inventory_stock_adjustments',
    v_key, v_reason,
    jsonb_build_object('previousStock', coalesce(v_variant.stock, 0), 'newStock', p_new_quantity, 'delta', v_delta)
  ) on conflict (idempotency_key) do nothing;

  select * into v_variant from public.producto_variantes where id = p_variant_id;
  return v_variant;
end;
$function$;

create or replace function public.compute_historical_unit_cost(
  p_product_id bigint, p_variant_id bigint, p_as_of date
) returns numeric language sql stable as $$
  -- Valor fijo de prueba: la lógica real de costo histórico ya tiene
  -- cobertura extensa en lib/business/product-costs.test.ts (Auditoría
  -- 3/7). Acá sólo importa que el valor que devuelve quede correctamente
  -- registrado en order_replacements.unit_cost.
  select 500::numeric;
$$;
