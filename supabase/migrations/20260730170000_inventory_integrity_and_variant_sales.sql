-- Endurece la identidad de SKU, hace atómica la creación de variantes y
-- permite imputar ventas externas a la variante correcta.

create or replace function public.normalized_catalog_sku(p_sku text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(upper(btrim(coalesce(p_sku, ''))), '');
$$;

create or replace function public.validate_product_sku_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.sku := nullif(btrim(new.sku), '');

  if new.sku is not null and exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = new.id
       or public.normalized_catalog_sku(variants.sku)
          = public.normalized_catalog_sku(new.sku)
  ) then
    raise exception
      'Los productos con variantes no pueden conservar un SKU principal.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_product_sku_ownership on public.productos;
create trigger validate_product_sku_ownership
before insert or update of sku on public.productos
for each row execute function public.validate_product_sku_ownership();

create or replace function public.validate_variant_sku_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_product_sku text;
  v_has_variants boolean;
begin
  new.sku := nullif(btrim(new.sku), '');

  if new.sku is not null and exists (
    select 1
    from public.producto_variantes variants
    where variants.id is distinct from new.id
      and public.normalized_catalog_sku(variants.sku)
          = public.normalized_catalog_sku(new.sku)
  ) then
    raise exception 'El SKU ya está asignado a otra variante.';
  end if;

  if new.sku is not null and exists (
    select 1
    from public.productos products
    where products.id <> new.producto_id
      and public.normalized_catalog_sku(products.sku)
          = public.normalized_catalog_sku(new.sku)
  ) then
    raise exception 'El SKU ya está asignado a otro producto.';
  end if;

  if tg_op = 'INSERT' then
    select
      products.sku,
      exists (
        select 1
        from public.producto_variantes variants
        where variants.producto_id = products.id
      )
    into v_product_sku, v_has_variants
    from public.productos products
    where products.id = new.producto_id;

    if not found then
      raise exception 'El producto de la variante no existe.';
    end if;

    if not v_has_variants
       and v_product_sku is not null
       and public.normalized_catalog_sku(new.sku)
           is distinct from public.normalized_catalog_sku(v_product_sku) then
      raise exception
        'La primera variante debe heredar el SKU principal %.',
        v_product_sku;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists validate_variant_sku_ownership
  on public.producto_variantes;
create trigger validate_variant_sku_ownership
before insert or update of sku, producto_id
on public.producto_variantes
for each row execute function public.validate_variant_sku_ownership();

create or replace function public.transfer_product_sku_to_first_variant()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.productos
  set sku = null
  where id = new.producto_id
    and sku is not null;
  return new;
end;
$$;

drop trigger if exists transfer_product_sku_to_first_variant
  on public.producto_variantes;
create trigger transfer_product_sku_to_first_variant
after insert on public.producto_variantes
for each row execute function public.transfer_product_sku_to_first_variant();

-- Limpia el legado seguro: el SKU ya vive en la variante.
update public.productos products
set sku = null
where products.sku is not null
  and exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = products.id
  );

create or replace function public.create_product_variant_with_allocation(
  p_product_id bigint,
  p_name text,
  p_sku text,
  p_color_hex text,
  p_images jsonb,
  p_quantity integer,
  p_actor_id uuid
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
  v_created public.producto_variantes%rowtype;
  v_allocations jsonb;
begin
  if p_product_id is null
     or p_product_id <= 0
     or nullif(btrim(p_name), '') is null
     or p_color_hex !~ '^#[0-9A-Fa-f]{6}$'
     or p_quantity is null
     or p_quantity < 0 then
    raise exception 'Los datos de la variante no son válidos.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  select *
  into v_product
  from public.productos
  where id = p_product_id
  for update;

  if not found then
    raise exception 'El producto ya no existe.';
  end if;

  insert into public.producto_variantes (
    producto_id,
    nombre,
    sku,
    color_hex,
    imagenes,
    activo,
    orden
  )
  values (
    p_product_id,
    left(btrim(p_name), 160),
    nullif(left(btrim(coalesce(p_sku, '')), 120), ''),
    upper(p_color_hex),
    coalesce(p_images, '[]'::jsonb),
    v_product.activo,
    (
      select coalesce(max(variants.orden), 0) + 1
      from public.producto_variantes variants
      where variants.producto_id = p_product_id
    )
  )
  returning * into v_created;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'variant_id', allocations.variant_id,
        'quantity', allocations.quantity
      )
      order by allocations.variant_id
    ),
    '[]'::jsonb
  )
  into v_allocations
  from public.inventory_variant_allocations allocations
  where allocations.product_id = p_product_id;

  v_allocations := v_allocations || jsonb_build_array(
    jsonb_build_object(
      'variant_id', v_created.id,
      'quantity', p_quantity
    )
  );

  perform public.set_product_variant_allocations(
    p_product_id,
    v_allocations,
    p_actor_id
  );

  select *
  into v_created
  from public.producto_variantes
  where id = v_created.id;

  return v_created;
end;
$$;

revoke all on function public.create_product_variant_with_allocation(
  bigint, text, text, text, jsonb, integer, uuid
) from public, anon, authenticated;
grant execute on function public.create_product_variant_with_allocation(
  bigint, text, text, text, jsonb, integer, uuid
) to service_role;

create or replace function public.update_product_variant_with_allocation(
  p_product_id bigint,
  p_variant_id bigint,
  p_name text,
  p_sku text,
  p_color_hex text,
  p_images jsonb,
  p_quantity integer,
  p_actor_id uuid
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated public.producto_variantes%rowtype;
  v_allocations jsonb;
begin
  if p_product_id is null
     or p_variant_id is null
     or nullif(btrim(p_name), '') is null
     or p_color_hex !~ '^#[0-9A-Fa-f]{6}$'
     or p_quantity is null
     or p_quantity < 0 then
    raise exception 'Los datos de la variante no son válidos.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  update public.producto_variantes
  set nombre = left(btrim(p_name), 160),
      sku = nullif(left(btrim(coalesce(p_sku, '')), 120), ''),
      color_hex = upper(p_color_hex),
      imagenes = coalesce(p_images, '[]'::jsonb)
  where id = p_variant_id
    and producto_id = p_product_id
  returning * into v_updated;

  if not found then
    raise exception 'La variante ya no existe.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'variant_id', allocations.variant_id,
        'quantity', allocations.quantity
      )
      order by allocations.variant_id
    ),
    '[]'::jsonb
  )
  into v_allocations
  from public.inventory_variant_allocations allocations
  where allocations.product_id = p_product_id
    and allocations.variant_id <> p_variant_id;

  v_allocations := v_allocations || jsonb_build_array(
    jsonb_build_object(
      'variant_id', p_variant_id,
      'quantity', p_quantity
    )
  );

  perform public.set_product_variant_allocations(
    p_product_id,
    v_allocations,
    p_actor_id
  );

  select *
  into v_updated
  from public.producto_variantes
  where id = p_variant_id;

  return v_updated;
end;
$$;

revoke all on function public.update_product_variant_with_allocation(
  bigint, bigint, text, text, text, jsonb, integer, uuid
) from public, anon, authenticated;
grant execute on function public.update_product_variant_with_allocation(
  bigint, bigint, text, text, text, jsonb, integer, uuid
) to service_role;

-- La función histórica crea el producto, imágenes, variantes y
-- especificaciones en una transacción, pero no conocía los SKU de variante.
-- Este envoltorio completa esos SKU dentro de la misma transacción.
create or replace function public.create_producto_completo_v2(
  p_producto jsonb,
  p_imagenes jsonb default '[]'::jsonb,
  p_variantes jsonb default '[]'::jsonb,
  p_especificaciones jsonb default '[]'::jsonb
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
  v_variant jsonb;
  v_variant_id bigint;
  v_index integer := 0;
begin
  v_product := public.create_producto_completo(
    p_producto,
    p_imagenes,
    p_variantes,
    p_especificaciones
  );

  for v_variant in
    select value
    from jsonb_array_elements(coalesce(p_variantes, '[]'::jsonb))
  loop
    select variants.id
    into v_variant_id
    from public.producto_variantes variants
    where variants.producto_id = v_product.id
    order by variants.id
    offset v_index
    limit 1;

    if v_variant_id is null then
      raise exception 'No se pudo verificar una variante recién creada.';
    end if;

    update public.producto_variantes
    set sku = nullif(left(btrim(coalesce(v_variant ->> 'sku', '')), 120), '')
    where id = v_variant_id;

    v_index := v_index + 1;
  end loop;

  if jsonb_array_length(coalesce(p_variantes, '[]'::jsonb)) = 0 then
    update public.productos
    set sku = nullif(left(btrim(coalesce(p_producto ->> 'sku', '')), 120), '')
    where id = v_product.id;
  end if;

  select *
  into v_product
  from public.productos
  where id = v_product.id;

  return v_product;
end;
$$;

revoke all on function public.create_producto_completo_v2(
  jsonb, jsonb, jsonb, jsonb
) from public, anon;
grant execute on function public.create_producto_completo_v2(
  jsonb, jsonb, jsonb, jsonb
) to authenticated, service_role;

alter table public.external_sales
  add column if not exists variant_id bigint
  references public.producto_variantes(id) on delete restrict;

create index if not exists external_sales_variant_id_idx
  on public.external_sales (variant_id);

create or replace function public.validate_external_sale_variant()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_variant_product_id bigint;
begin
  if new.variant_id is not null then
    select variants.producto_id
    into v_variant_product_id
    from public.producto_variantes variants
    where variants.id = new.variant_id;

    if not found
       or new.product_id is null
       or v_variant_product_id <> new.product_id then
      raise exception 'La variante de la venta no pertenece al producto.';
    end if;
  elsif new.product_id is not null and exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = new.product_id
  ) then
    raise exception
      'Seleccioná una variante para descontar correctamente el stock.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_external_sale_variant
  on public.external_sales;
create trigger validate_external_sale_variant
before insert or update of product_id, variant_id
on public.external_sales
for each row execute function public.validate_external_sale_variant();

create or replace view public.inventory_movements
with (security_invoker = true)
as
select
  entries.product_id,
  entries.variant_id,
  entries.purchase_date as movement_date,
  entries.created_at as recorded_at,
  'purchase'::text as source,
  entries.id::text as source_id,
  entries.received_quantity::bigint as quantity_delta
from public.product_cost_entries entries
where entries.product_id is not null
  and entries.received_quantity <> 0

union all

select
  items.producto_id,
  items.variante_id,
  (orders.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
  orders.created_at,
  'web_sale'::text,
  items.id::text,
  -items.cantidad::bigint
from public.orden_items items
join public.ordenes orders on orders.id = items.orden_id
where public.inventory_order_consumes_stock(
  orders.estado,
  orders.payment_status
)

union all

select
  sales.product_id,
  sales.variant_id,
  sales.sale_date,
  sales.created_at,
  'external_sale'::text,
  sales.id::text,
  -sales.quantity::bigint
from public.external_sales sales
where sales.product_id is not null

union all

select
  sales.product_id,
  public.inventory_ml_variant_id(sales.raw_data),
  coalesce(
    (sales.sale_date at time zone 'America/Argentina/Buenos_Aires')::date,
    (sales.imported_at at time zone 'America/Argentina/Buenos_Aires')::date
  ),
  sales.imported_at,
  'mercadolibre_sale'::text,
  sales.id::text,
  -public.inventory_ml_stock_units(
    sales.quantity,
    sales.raw_data
  )::bigint
from public.mercadolibre_sales sales
where sales.product_id is not null
  and public.inventory_ml_stock_units(
    sales.quantity,
    sales.raw_data
  ) > 0

union all

select
  movements.product_id,
  movements.variant_id,
  (movements.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
  movements.created_at,
  'approved_return'::text,
  movements.id::text,
  movements.sellable_quantity::bigint
from public.inventory_return_movements movements
where movements.sellable_quantity <> 0

union all

select
  expenses.product_id,
  expenses.variant_id,
  expenses.expense_date,
  expenses.created_at,
  'product_expense'::text,
  expenses.id::text,
  -expenses.quantity::bigint
from public.business_expenses expenses
where expenses.expense_type = 'product'
  and expenses.product_id is not null
  and expenses.quantity is not null;

grant select on public.inventory_movements to authenticated;

create or replace view public.inventory_stock_integrity
with (security_invoker = true)
as
select
  products.id as product_id,
  products.nombre as product_name,
  products.stock::bigint as stored_normal_stock,
  coalesce(ledger.normal_stock, 0)::bigint as calculated_normal_stock,
  coalesce(variants.stored_stock, 0)::bigint as stored_variant_stock,
  coalesce(variants.expected_stock, 0)::bigint as calculated_variant_stock,
  coalesce(generic.balance, 0)::bigint as generic_balance,
  coalesce(allocations.quantity, 0)::bigint as allocated_quantity,
  greatest(
    coalesce(allocations.quantity, 0) - greatest(coalesce(generic.balance, 0), 0),
    0
  )::bigint as allocation_overflow,
  greatest(
    greatest(coalesce(generic.balance, 0), 0) - coalesce(allocations.quantity, 0),
    0
  )::bigint as unassigned_quantity,
  coalesce(returns.discounted, 0)::bigint as discounted_stock,
  coalesce(returns.non_sellable, 0)::bigint as non_sellable_stock,
  coalesce(returns.pending_review, 0)::bigint as pending_review_stock,
  (
    coalesce(ledger.normal_stock, 0)
    + coalesce(returns.discounted, 0)
    + coalesce(returns.non_sellable, 0)
    + coalesce(returns.pending_review, 0)
  )::bigint as physical_stock,
  array_remove(array[
    case
      when products.stock is distinct from coalesce(ledger.normal_stock, 0)
      then 'PRODUCT_STOCK_MISMATCH'
    end,
    case
      when coalesce(variants.stored_stock, 0)
        is distinct from coalesce(variants.expected_stock, 0)
      then 'VARIANT_STOCK_MISMATCH'
    end,
    case
      when coalesce(allocations.quantity, 0)
        > greatest(coalesce(generic.balance, 0), 0)
      then 'ALLOCATION_OVERFLOW'
    end,
    case
      when products.sku is not null and coalesce(variants.count, 0) > 0
      then 'PRODUCT_AND_VARIANT_SKU'
    end
  ], null) as issues
from public.productos products
left join lateral (
  select sum(movements.quantity_delta) as normal_stock
  from public.inventory_movements movements
  where movements.product_id = products.id
    and movements.movement_date <= current_date
) ledger on true
left join lateral (
  select sum(movements.quantity_delta) as balance
  from public.inventory_movements movements
  where movements.product_id = products.id
    and movements.variant_id is null
    and movements.movement_date <= current_date
) generic on true
left join lateral (
  select sum(items.quantity) as quantity
  from public.inventory_variant_allocations items
  where items.product_id = products.id
) allocations on true
left join lateral (
  select
    count(*) as count,
    sum(variant.stock) as stored_stock,
    sum(
      coalesce((
        select sum(movements.quantity_delta)
        from public.inventory_movements movements
        where movements.product_id = products.id
          and movements.variant_id = variant.id
          and movements.movement_date <= current_date
      ), 0)
      + coalesce((
        select allocation.quantity
        from public.inventory_variant_allocations allocation
        where allocation.variant_id = variant.id
      ), 0)
    ) as expected_stock
  from public.producto_variantes variant
  where variant.producto_id = products.id
) variants on true
left join lateral (
  select
    sum(movements.discounted_quantity) as discounted,
    sum(movements.non_sellable_quantity) as non_sellable,
    sum(greatest(
      movements.received_quantity
      - movements.sellable_quantity
      - movements.discounted_quantity
      - movements.non_sellable_quantity,
      0
    )) as pending_review
  from public.inventory_return_movements movements
  where movements.product_id = products.id
) returns on true;

grant select on public.inventory_stock_integrity
  to authenticated, service_role;

do $$
declare
  v_product_id bigint;
begin
  for v_product_id in
    select products.id
    from public.productos products
    order by products.id
  loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;
end;
$$;

comment on view public.inventory_stock_integrity is
  'Conciliación derivada entre libro, stock almacenado, variantes, devoluciones y distribución.';
