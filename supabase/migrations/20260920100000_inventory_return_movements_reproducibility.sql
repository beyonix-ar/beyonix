-- Auditoría 4/7 (devoluciones), Fase 5, punto 10: reproducibilidad.
--
-- Confirmado en vivo (solo lectura, 2026-09-19/20) que `inventory_return_
-- movements` -- con sus columnas, CHECK, FKs, RLS, policy y 5 triggers --
-- NUNCA fue creada en supabase/migrations/, sólo existe aplicada
-- directamente a producción (mismo patrón ya corregido para otras piezas en
-- 20260918110000/20260918150000). Si hoy se reconstruyera el esquema sólo
-- desde migrations/, esta tabla no existiría y las ~40 migraciones
-- posteriores que hacen `alter table public.inventory_return_movements`
-- fallarían.
--
-- Reproducción BYTE A BYTE de lo que corre hoy en producción (columnas,
-- CHECK, FKs, índice UNIQUE, RLS, policy, grants, funciones de trigger)
-- -- cero cambio de comportamiento en esta parte.
--
-- Único agregado real (no reproducción): se adjunta `audit_log_change()`
-- -- función genérica ya usada en otras tablas (p. ej. orden_items, ver
-- `orden_items_audit_log_trigger`, confirmado en vivo) -- como trigger
-- también acá, para que cada alta/edición/baja de un movimiento de
-- devolución quede en `audit_logs` con actor/email/before/after. Es el
-- fix de Fase 4, punto 8 (auditoría central).

begin;

create table if not exists public.inventory_return_movements (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  order_id bigint references public.ordenes(id) on delete restrict,
  order_item_id bigint references public.orden_items(id) on delete restrict,
  product_id bigint references public.productos(id) on delete restrict,
  variant_id bigint references public.producto_variantes(id) on delete restrict,
  quantity integer not null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  mercadolibre_sale_id uuid references public.mercadolibre_sales(id) on delete cascade,
  received_quantity integer not null default 0,
  sellable_quantity integer not null default 0,
  discounted_quantity integer not null default 0,
  non_sellable_quantity integer not null default 0,
  discount_percent numeric,
  review_notes text,
  discount_reason text,
  non_sellable_reason text,
  conditioned_active boolean not null default false,
  conditioned_name text,
  conditioned_sku text,
  conditioned_color_hex text,
  conditioned_images jsonb not null default '[]'::jsonb,
  occurred_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_movements_source_key_key,
  add constraint inventory_return_movements_source_key_key unique (source_key);

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_movements_quantity_check,
  add constraint inventory_return_movements_quantity_check check (quantity >= 0);

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_movements_source_check,
  add constraint inventory_return_movements_source_check check (
    (order_id is not null and order_item_id is not null and mercadolibre_sale_id is null)
    or (order_id is null and order_item_id is null and mercadolibre_sale_id is not null)
  );

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_movements_condition_check,
  add constraint inventory_return_movements_condition_check check (
    received_quantity >= 0
    and sellable_quantity >= 0
    and discounted_quantity >= 0
    and non_sellable_quantity >= 0
    and (sellable_quantity + discounted_quantity + non_sellable_quantity) <= received_quantity
    and quantity = sellable_quantity
    and (
      (discounted_quantity = 0 and discount_percent is null)
      or (discounted_quantity > 0 and discount_percent > 0 and discount_percent < 100)
    )
  );

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_movements_conditioned_active_check,
  add constraint inventory_return_movements_conditioned_active_check check (
    discounted_quantity > 0 or conditioned_active = false
  );

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_conditioned_color_check,
  add constraint inventory_return_conditioned_color_check check (
    conditioned_color_hex is null or conditioned_color_hex ~ '^#[0-9A-Fa-f]{6}$'
  );

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_conditioned_identity_check,
  add constraint inventory_return_conditioned_identity_check check (
    discounted_quantity <= 0
    or not conditioned_active
    or (
      nullif(btrim(conditioned_name), '') is not null
      and nullif(btrim(conditioned_sku), '') is not null
      and conditioned_color_hex ~ '^#[0-9A-Fa-f]{6}$'
    )
  );

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_conditioned_images_check,
  add constraint inventory_return_conditioned_images_check check (
    jsonb_typeof(conditioned_images) = 'array'
  );

alter table public.inventory_return_movements enable row level security;

drop policy if exists "Admins read inventory return movements" on public.inventory_return_movements;
create policy "Admins read inventory return movements"
on public.inventory_return_movements for select to authenticated
using (current_user_role() = any (array['admin', 'super_admin']));

grant select on public.inventory_return_movements to authenticated;
grant select, insert, update, delete, references, trigger, truncate
  on public.inventory_return_movements to service_role;

create or replace function public.validate_inventory_return_condition()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sale public.mercadolibre_sales%rowtype;
  v_item public.orden_items%rowtype;
  v_variant_product_id bigint;
  v_max_quantity integer;
begin
  if new.mercadolibre_sale_id is null then
    select * into v_item
    from public.orden_items items
    where items.id = new.order_item_id
      and items.orden_id = new.order_id;
    if not found then
      raise exception 'La devolución no pertenece al pedido indicado.';
    end if;

    new.product_id := v_item.producto_id;
    if new.variant_id is null and v_item.variante_id is not null then
      new.variant_id := v_item.variante_id;
    end if;
    v_max_quantity := v_item.cantidad;

    -- Compatibilidad con movimientos históricos que sólo informaban quantity.
    if new.received_quantity = 0
       and new.sellable_quantity = 0
       and new.discounted_quantity = 0
       and new.non_sellable_quantity = 0
       and new.quantity > 0 then
      new.received_quantity := new.quantity;
      new.sellable_quantity := new.quantity;
    end if;
  else
    select * into v_sale
    from public.mercadolibre_sales sales
    where sales.id = new.mercadolibre_sale_id;
    if not found or v_sale.product_id is null then
      raise exception 'La venta de Mercado Libre debe estar vinculada a un producto.';
    end if;

    new.product_id := v_sale.product_id;
    if tg_op = 'INSERT' and new.variant_id is null then
      new.variant_id := public.inventory_ml_variant_id(v_sale.raw_data);
    end if;
    new.order_id := null;
    new.order_item_id := null;
    v_max_quantity := v_sale.quantity;
  end if;

  -- Sólo el estado vendible normal alimenta el stock normal. Las unidades con
  -- descuento se publican y descuentan desde conditioned_inventory_offers.
  new.quantity := new.sellable_quantity;

  if new.received_quantity > v_max_quantity then
    raise exception 'No podés recibir más unidades que las vendidas.';
  end if;
  if new.received_quantity < 0
     or new.sellable_quantity < 0
     or new.discounted_quantity < 0
     or new.non_sellable_quantity < 0
     or new.sellable_quantity
          + new.discounted_quantity
          + new.non_sellable_quantity
        > new.received_quantity then
    raise exception 'La clasificación de la devolución no es válida.';
  end if;

  if new.discounted_quantity > 0 and (
    new.discount_percent is null
    or new.discount_percent <= 0
    or new.discount_percent >= 100
    or nullif(btrim(new.discount_reason), '') is null
  ) then
    raise exception 'Indicá el porcentaje y el motivo del descuento.';
  end if;
  if new.non_sellable_quantity > 0
     and nullif(btrim(new.non_sellable_reason), '') is null then
    raise exception 'Indicá por qué las unidades no son vendibles.';
  end if;

  if new.discounted_quantity = 0 then
    new.discount_percent := null;
    new.discount_reason := null;
    new.conditioned_active := false;
    new.conditioned_name := null;
    new.conditioned_sku := null;
    new.conditioned_color_hex := null;
    new.conditioned_images := '[]'::jsonb;
  end if;
  if new.non_sellable_quantity = 0 then
    new.non_sellable_reason := null;
  end if;

  if new.variant_id is not null then
    select variants.producto_id into v_variant_product_id
    from public.producto_variantes variants
    where variants.id = new.variant_id;
    if not found or v_variant_product_id is distinct from new.product_id then
      raise exception 'La variante vinculada no pertenece al producto.';
    end if;
  end if;

  return new;
end;
$function$;

create or replace function public.guard_inventory_return_variant_link()
returns trigger
set search_path to 'public'
language plpgsql
as $function$
begin
  if new.variant_id is distinct from old.variant_id
     and current_setting('beyonix.inventory_variant_link', true) is distinct from 'on' then
    raise exception 'INVENTORY_VARIANT_LINK_RPC_REQUIRED';
  end if;
  return new;
end;
$function$;

create or replace function public.normalize_conditioned_stock_state()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.discounted_quantity <= 0 then
    new.conditioned_active := false;
  end if;
  return new;
end;
$function$;

create or replace function public.sync_conditioned_catalog_sku_registry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sku text;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.conditioned_sku is not null then
    delete from public.catalog_sku_registry registry
    where registry.conditioned_stock_id = old.id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  v_sku := public.normalized_catalog_sku(new.conditioned_sku);
  if v_sku is null or new.discounted_quantity <= 0 then
    return new;
  end if;

  insert into public.catalog_sku_registry (
    normalized_sku,
    product_id,
    variant_id,
    conditioned_stock_id
  )
  values (v_sku, null, null, new.id);

  return new;
exception
  when unique_violation then
    raise exception
      'El SKU % ya está asignado a otro artículo.',
      new.conditioned_sku;
end;
$function$;

create or replace function public.touch_inventory_return_movement()
returns trigger
set search_path to 'public'
language plpgsql
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

create or replace trigger validate_inventory_return_condition
  before insert or update on public.inventory_return_movements
  for each row execute function public.validate_inventory_return_condition();

create or replace trigger guard_inventory_return_variant_link
  before update of variant_id on public.inventory_return_movements
  for each row execute function public.guard_inventory_return_variant_link();

create or replace trigger normalize_conditioned_stock_state
  before insert or update on public.inventory_return_movements
  for each row execute function public.normalize_conditioned_stock_state();

create or replace trigger sync_conditioned_catalog_sku_registry
  after insert or delete or update of conditioned_sku, discounted_quantity on public.inventory_return_movements
  for each row execute function public.sync_conditioned_catalog_sku_registry();

create or replace trigger touch_inventory_return_movement
  before update on public.inventory_return_movements
  for each row execute function public.touch_inventory_return_movement();

-- refresh_inventory_from_row() ya reproducida en 20260918150000.
create or replace trigger refresh_inventory_after_return_movement
  after insert or delete or update on public.inventory_return_movements
  for each row execute function public.refresh_inventory_from_row();

-- Único agregado de comportamiento real de esta migración (ver cabecera):
-- auditoría central de cada movimiento de devolución.
create or replace trigger inventory_return_movements_audit_log_trigger
  after insert or delete or update on public.inventory_return_movements
  for each row execute function public.audit_log_change();

-- --- orden_items: reproducibilidad de los dos triggers que gatean las
-- columnas return_* (confirmados vivos, tampoco estaban en migrations/) ---

create or replace function public.require_formal_claim_for_return_inventory()
returns trigger
set search_path to 'public'
language plpgsql
as $function$
begin
  if (
    new.return_restocked_quantity is distinct from old.return_restocked_quantity
    or new.return_written_off_quantity is distinct from old.return_written_off_quantity
    or new.return_inventory_note is distinct from old.return_inventory_note
    or new.return_inventory_processed_at is distinct from old.return_inventory_processed_at
    or new.return_inventory_processed_by is distinct from old.return_inventory_processed_by
  ) and not exists (
    select 1
    from public.order_claims
    where order_claims.order_id = new.orden_id
      and order_claims.failure_type is not null
      and order_claims.failure_type not in ('cancelar_compra', 'consulta_pedido')
  ) then
    raise exception 'No se puede modificar el inventario sin un reclamo formal asociado al pedido.';
  end if;

  return new;
end;
$function$;

create or replace trigger require_formal_claim_for_return_inventory
  before update on public.orden_items
  for each row execute function public.require_formal_claim_for_return_inventory();

notify pgrst, 'reload schema';

commit;
