-- Integra las variantes con descuento al circuito de venta sin mezclar su
-- existencia con el stock normal del producto o de la variante de origen.

alter table public.orden_items
  add column if not exists conditioned_stock_id uuid
    references public.inventory_return_movements(id) on delete restrict,
  add column if not exists conditioned_name text,
  add column if not exists conditioned_sku text,
  add column if not exists conditioned_color_hex text,
  add column if not exists conditioned_images jsonb,
  add column if not exists conditioned_discount_percent numeric,
  add column if not exists conditioned_reason text;

alter table public.orden_items
  drop constraint if exists order_items_single_stock_source_check,
  add constraint order_items_single_stock_source_check check (
    conditioned_stock_id is null or variante_id is null
  ),
  drop constraint if exists order_items_conditioned_color_check,
  add constraint order_items_conditioned_color_check check (
    conditioned_color_hex is null
    or conditioned_color_hex ~ '^#[0-9A-Fa-f]{6}$'
  ),
  drop constraint if exists order_items_conditioned_images_check,
  add constraint order_items_conditioned_images_check check (
    conditioned_images is null
    or jsonb_typeof(conditioned_images) = 'array'
  ),
  drop constraint if exists order_items_conditioned_discount_check,
  add constraint order_items_conditioned_discount_check check (
    conditioned_discount_percent is null
    or (
      conditioned_discount_percent > 0
      and conditioned_discount_percent < 100
    )
  );

create index if not exists order_items_conditioned_stock_id_idx
  on public.orden_items(conditioned_stock_id)
  where conditioned_stock_id is not null;

-- La variante vinculada se propone desde la venta original, pero puede
-- corregirse luego de la revisión física si el SKU informado por ML era
-- incorrecto. Antes esta función pisaba esa corrección en cada actualización.
create or replace function public.validate_inventory_return_condition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.mercadolibre_sales%rowtype;
  v_variant_product_id bigint;
begin
  if new.mercadolibre_sale_id is null then
    new.received_quantity := new.quantity;
    new.sellable_quantity := new.quantity;
    new.discounted_quantity := 0;
    new.non_sellable_quantity := 0;
    new.discount_percent := null;
    new.discount_reason := null;
    new.non_sellable_reason := null;
    return new;
  end if;

  select *
  into v_sale
  from public.mercadolibre_sales
  where id = new.mercadolibre_sale_id;

  if not found or v_sale.product_id is null then
    raise exception
      'La venta de Mercado Libre debe estar vinculada a un producto.';
  end if;

  new.product_id := v_sale.product_id;
  if tg_op = 'INSERT' and new.variant_id is null then
    new.variant_id := public.inventory_ml_variant_id(v_sale.raw_data);
  end if;
  new.order_id := null;
  new.order_item_id := null;
  new.quantity := new.sellable_quantity;

  if new.received_quantity > v_sale.quantity then
    raise exception 'No podés recibir más unidades que las vendidas.';
  end if;

  if (
    new.sellable_quantity
    + new.discounted_quantity
    + new.non_sellable_quantity
  ) > new.received_quantity then
    raise exception 'La clasificación supera las unidades recibidas.';
  end if;

  if new.discounted_quantity > 0
     and (
       new.discount_percent is null
       or new.discount_percent <= 0
       or new.discount_percent >= 100
     ) then
    raise exception 'Indicá un descuento entre 0 y 100%%.';
  end if;

  if new.discounted_quantity > 0
     and nullif(btrim(new.discount_reason), '') is null then
    raise exception 'Indicá el motivo del descuento.';
  end if;

  if new.non_sellable_quantity > 0
     and nullif(btrim(new.non_sellable_reason), '') is null then
    raise exception 'Indicá por qué las unidades no son vendibles.';
  end if;

  if new.discounted_quantity = 0 then
    new.discount_percent := null;
    new.discount_reason := null;
    new.conditioned_active := false;
  end if;

  if new.non_sellable_quantity = 0 then
    new.non_sellable_reason := null;
  end if;

  if new.variant_id is not null then
    select producto_id
    into v_variant_product_id
    from public.producto_variantes
    where id = new.variant_id;

    if not found or v_variant_product_id is distinct from new.product_id then
      raise exception 'La variante vinculada no pertenece al producto.';
    end if;
  end if;

  return new;
end;
$$;

drop view if exists public.conditioned_catalog_variants;
drop view if exists public.conditioned_inventory_offers;

create view public.conditioned_inventory_offers
with (security_invoker = true)
as
select
  movements.id,
  movements.product_id,
  movements.variant_id as source_variant_id,
  movements.conditioned_name as name,
  movements.conditioned_sku as sku,
  movements.conditioned_color_hex as color_hex,
  movements.conditioned_images as images,
  movements.discounted_quantity::integer as original_quantity,
  coalesce(sales.quantity, 0)::integer as sold_quantity,
  greatest(
    movements.discounted_quantity - coalesce(sales.quantity, 0),
    0
  )::integer as available_quantity,
  movements.discount_percent,
  movements.discount_reason as reason,
  movements.conditioned_active as active,
  movements.approved_at
from public.inventory_return_movements movements
left join lateral (
  select sum(
    greatest(
      items.cantidad - coalesce(items.return_restocked_quantity, 0),
      0
    )
  ) as quantity
  from public.orden_items items
  join public.ordenes orders on orders.id = items.orden_id
  where items.conditioned_stock_id = movements.id
    and public.inventory_order_consumes_stock(
      orders.estado,
      orders.payment_status
    )
) sales on true
where movements.discounted_quantity > 0;

grant select on public.conditioned_inventory_offers
  to authenticated, service_role;

create view public.conditioned_catalog_variants
with (security_barrier = true, security_invoker = false)
as
select
  movements.id,
  movements.product_id,
  movements.variant_id as source_variant_id,
  movements.conditioned_name as name,
  movements.conditioned_sku as sku,
  movements.conditioned_color_hex as color_hex,
  movements.conditioned_images as images,
  movements.discounted_quantity::integer as original_quantity,
  coalesce(sales.quantity, 0)::integer as sold_quantity,
  greatest(
    movements.discounted_quantity - coalesce(sales.quantity, 0),
    0
  )::integer as available_quantity,
  movements.discount_percent,
  movements.discount_reason as reason,
  movements.approved_at
from public.inventory_return_movements movements
join public.productos products on products.id = movements.product_id
left join lateral (
  select sum(
    greatest(
      items.cantidad - coalesce(items.return_restocked_quantity, 0),
      0
    )
  ) as quantity
  from public.orden_items items
  join public.ordenes orders on orders.id = items.orden_id
  where items.conditioned_stock_id = movements.id
    and public.inventory_order_consumes_stock(
      orders.estado,
      orders.payment_status
    )
) sales on true
where movements.conditioned_active
  and products.activo
  and movements.discounted_quantity > coalesce(sales.quantity, 0)
  and nullif(btrim(movements.conditioned_name), '') is not null
  and nullif(btrim(movements.conditioned_sku), '') is not null
  and movements.conditioned_color_hex ~ '^#[0-9A-Fa-f]{6}$';

revoke all on public.conditioned_catalog_variants from public;
grant select on public.conditioned_catalog_variants
  to anon, authenticated, service_role;

create or replace function public.decrement_checkout_inventory(
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_available integer;
  v_variant_product_id bigint;
  v_offer_product_id bigint;
  v_active boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception
      'No tenés permisos para validar el inventario del checkout.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;

  for v_item in
    select
      item.product_id,
      item.variant_id,
      item.conditioned_stock_id,
      sum(item.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as item(
      product_id bigint,
      variant_id bigint,
      conditioned_stock_id uuid,
      quantity integer
    )
    group by
      item.product_id,
      item.variant_id,
      item.conditioned_stock_id
    order by
      item.product_id,
      item.variant_id nulls first,
      item.conditioned_stock_id nulls first
  loop
    if v_item.product_id is null
       or v_item.product_id <= 0
       or v_item.quantity is null
       or v_item.quantity <= 0
       or (
         v_item.variant_id is not null
         and v_item.conditioned_stock_id is not null
       ) then
      raise exception 'CHECKOUT_ITEMS_INVALID';
    end if;

    perform pg_advisory_xact_lock(93000, v_item.product_id::integer);

    if v_item.conditioned_stock_id is not null then
      select movements.product_id, movements.conditioned_active
      into v_offer_product_id, v_active
      from public.inventory_return_movements movements
      where movements.id = v_item.conditioned_stock_id
      for update;

      if not found
         or v_offer_product_id <> v_item.product_id
         or not coalesce(v_active, false) then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;

      select offers.available_quantity
      into v_available
      from public.conditioned_inventory_offers offers
      where offers.id = v_item.conditioned_stock_id;

      if not found or v_available < v_item.quantity then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;
    elsif v_item.variant_id is not null then
      select
        variants.producto_id,
        coalesce(variants.stock, 0),
        coalesce(variants.activo, false)
      into v_variant_product_id, v_available, v_active
      from public.producto_variantes variants
      where variants.id = v_item.variant_id;

      if not found
         or v_variant_product_id <> v_item.product_id
         or not v_active
         or v_available < v_item.quantity then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;
    else
      if exists (
        select 1
        from public.producto_variantes variants
        where variants.producto_id = v_item.product_id
          and variants.activo
      ) then
        raise exception 'CHECKOUT_VARIANT_REQUIRED';
      end if;

      select coalesce(products.stock, 0), coalesce(products.activo, false)
      into v_available, v_active
      from public.productos products
      where products.id = v_item.product_id;

      if not found or not v_active or v_available < v_item.quantity then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;
    end if;
  end loop;

  return jsonb_build_object('validated', true, 'derived', true);
end;
$$;

revoke all on function public.decrement_checkout_inventory(jsonb)
  from public, anon, authenticated;
grant execute on function public.decrement_checkout_inventory(jsonb)
  to service_role;

create or replace function public.validate_inventory_order_confirmation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_item record;
  v_available integer;
  v_offer_product_id bigint;
begin
  if public.inventory_order_consumes_stock(old.estado, old.payment_status)
     or not public.inventory_order_consumes_stock(
       new.estado,
       new.payment_status
     ) then
    return new;
  end if;

  for v_item in
    select
      items.producto_id,
      items.variante_id,
      items.conditioned_stock_id,
      sum(items.cantidad)::integer as quantity
    from public.orden_items items
    where items.orden_id = new.id
    group by
      items.producto_id,
      items.variante_id,
      items.conditioned_stock_id
    order by
      items.producto_id,
      items.variante_id nulls first,
      items.conditioned_stock_id nulls first
  loop
    perform pg_advisory_xact_lock(93000, v_item.producto_id::integer);

    if v_item.conditioned_stock_id is not null then
      select movements.product_id
      into v_offer_product_id
      from public.inventory_return_movements movements
      where movements.id = v_item.conditioned_stock_id
        and movements.conditioned_active
      for update;

      if not found or v_offer_product_id <> v_item.producto_id then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;

      select offers.available_quantity
      into v_available
      from public.conditioned_inventory_offers offers
      where offers.id = v_item.conditioned_stock_id;
    elsif v_item.variante_id is not null then
      select coalesce(variants.stock, 0)
      into v_available
      from public.producto_variantes variants
      where variants.id = v_item.variante_id
        and variants.producto_id = v_item.producto_id
        and variants.activo;
    else
      select coalesce(products.stock, 0)
      into v_available
      from public.productos products
      where products.id = v_item.producto_id
        and products.activo;
    end if;

    if not found or v_available < v_item.quantity then
      raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
    end if;
  end loop;

  return new;
end;
$$;

create or replace function public.process_order_item_return_inventory(
  p_order_id bigint,
  p_order_item_id bigint,
  p_restocked_quantity integer,
  p_written_off_quantity integer,
  p_note text,
  p_processed_by uuid
)
returns public.orden_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.orden_items%rowtype;
begin
  if p_restocked_quantity < 0 or p_written_off_quantity < 0 then
    raise exception
      'Las cantidades de la devolución no pueden ser negativas.';
  end if;
  if p_written_off_quantity > 0
     and length(trim(coalesce(p_note, ''))) < 3 then
    raise exception 'Indicá el motivo de la baja o pérdida.';
  end if;

  select *
  into v_item
  from public.orden_items
  where id = p_order_item_id
    and orden_id = p_order_id
  for update;

  if not found then
    raise exception 'No se encontró el producto dentro del pedido.';
  end if;
  if v_item.return_inventory_processed_at is not null then
    raise exception 'La recepción de este producto ya fue registrada.';
  end if;
  if p_restocked_quantity + p_written_off_quantity > v_item.cantidad then
    raise exception
      'La cantidad recibida no puede superar la cantidad vendida.';
  end if;

  update public.orden_items
  set return_restocked_quantity = p_restocked_quantity,
      return_written_off_quantity = p_written_off_quantity,
      return_inventory_note =
        nullif(left(trim(coalesce(p_note, '')), 1000), ''),
      return_inventory_processed_at = now(),
      return_inventory_processed_by = p_processed_by
  where id = v_item.id
  returning * into v_item;

  -- Las unidades condicionadas vuelven al mismo lote derivado mediante
  -- return_restocked_quantity. No se convierten silenciosamente en stock normal.
  if p_restocked_quantity > 0
     and v_item.conditioned_stock_id is null then
    insert into public.inventory_return_movements (
      source_key,
      order_id,
      order_item_id,
      product_id,
      variant_id,
      quantity,
      approved_by,
      approved_at
    )
    values (
      'order-item:' || v_item.id,
      v_item.orden_id,
      v_item.id,
      v_item.producto_id,
      v_item.variante_id,
      p_restocked_quantity,
      p_processed_by,
      v_item.return_inventory_processed_at
    )
    on conflict (source_key) do nothing;
  end if;

  insert into public.order_audit_events (
    order_id,
    actor_type,
    actor_id,
    action,
    metadata
  )
  values (
    p_order_id,
    'admin',
    p_processed_by,
    'return_inventory_processed',
    jsonb_build_object(
      'orderItemId', v_item.id,
      'productId', v_item.producto_id,
      'variantId', v_item.variante_id,
      'conditionedStockId', v_item.conditioned_stock_id,
      'restockedQuantity', p_restocked_quantity,
      'writtenOffQuantity', p_written_off_quantity,
      'sourceOfTruth', 'derived_inventory'
    )
  );

  return v_item;
end;
$$;

-- Las ventas de un lote condicionado se explican en su propia proyección y
-- nunca deben descontarse otra vez del stock normal.
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
where items.conditioned_stock_id is null
  and public.inventory_order_consumes_stock(
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
    coalesce(allocations.quantity, 0)
      - greatest(coalesce(generic.balance, 0), 0),
    0
  )::bigint as allocation_overflow,
  greatest(
    greatest(coalesce(generic.balance, 0), 0)
      - coalesce(allocations.quantity, 0),
    0
  )::bigint as unassigned_quantity,
  coalesce(conditioned.available, 0)::bigint as discounted_stock,
  coalesce(returns.non_sellable, 0)::bigint as non_sellable_stock,
  coalesce(returns.pending_review, 0)::bigint as pending_review_stock,
  (
    coalesce(ledger.normal_stock, 0)
    + coalesce(conditioned.available, 0)
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
  select sum(offers.available_quantity) as available
  from public.conditioned_inventory_offers offers
  where offers.product_id = products.id
) conditioned on true
left join lateral (
  select
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

comment on column public.orden_items.conditioned_stock_id is
  'Lote condicionado vendido; es excluyente con variante_id para no descontar stock normal.';
comment on view public.conditioned_inventory_offers is
  'Existencia inicial, ventas netas y disponibilidad de cada variante con descuento.';
comment on view public.conditioned_catalog_variants is
  'Variantes con descuento activas y disponibles expuestas al catálogo público.';
