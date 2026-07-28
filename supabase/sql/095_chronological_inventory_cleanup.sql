-- Limpieza final del inventario:
-- 1. elimina cualquier saldo manual conciliado;
-- 2. concentra compras, ventas y devoluciones en un libro cronológico;
-- 3. deriva Productos y el desglose desde ese mismo libro, sin repetir fórmulas.

with unique_catalog_skus as (
  select
    upper(trim(products.sku)) as normalized_sku,
    min(products.id) as product_id
  from public.productos products
  where nullif(trim(products.sku), '') is not null
    and not exists (
      select 1
      from public.producto_variantes variants
      where variants.producto_id = products.id
    )
  group by upper(trim(products.sku))
  having count(*) = 1
)
update public.mercadolibre_sales sales
set
  product_id = matches.product_id,
  raw_data = coalesce(sales.raw_data, '{}'::jsonb)
    || jsonb_build_object(
      'beyonix_cost_mapping',
      jsonb_build_object(
        'product_id', matches.product_id,
        'variant_id', null,
        'match_key', 'sku:' || trim(sales.sku),
        'mapped_at', now(),
        'mapped_by', null,
        'mapping_origin', 'automatic_sku'
      )
    )
from unique_catalog_skus matches
where sales.product_id is null
  and nullif(trim(sales.sku), '') is not null
  and upper(trim(sales.sku)) = matches.normalized_sku;

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
  null::bigint,
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
  movements.quantity::bigint
from public.inventory_return_movements movements

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

create or replace function public.refresh_inventory_stock(
  p_product_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_refresh_setting text := coalesce(
    current_setting('beyonix.inventory_refresh', true),
    ''
  );
begin
  if p_product_id is null then
    return;
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  perform set_config('beyonix.inventory_refresh', 'on', true);

  update public.producto_variantes variants
  set stock = coalesce((
    select sum(movements.quantity_delta)
    from public.inventory_movements movements
    where movements.product_id = variants.producto_id
      and movements.variant_id = variants.id
      and movements.movement_date <= current_date
  ), 0)
  where variants.producto_id = p_product_id;

  if exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = p_product_id
  ) then
    update public.productos products
    set stock = coalesce((
      select sum(variants.stock)
      from public.producto_variantes variants
      where variants.producto_id = products.id
    ), 0)
    where products.id = p_product_id;
  else
    update public.productos products
    set stock = coalesce((
      select sum(movements.quantity_delta)
      from public.inventory_movements movements
      where movements.product_id = products.id
        and movements.variant_id is null
        and movements.movement_date <= current_date
    ), 0)
    where products.id = p_product_id;
  end if;

  perform set_config(
    'beyonix.inventory_refresh',
    v_previous_refresh_setting,
    true
  );
exception
  when others then
    perform set_config(
      'beyonix.inventory_refresh',
      v_previous_refresh_setting,
      true
    );
    raise;
end;
$$;

revoke all on function public.refresh_inventory_stock(bigint)
  from public, anon, authenticated;
grant execute on function public.refresh_inventory_stock(bigint)
  to service_role;

create or replace view public.inventory_stock_breakdown
with (security_invoker = true)
as
select
  products.id as product_id,
  variants.id as variant_id,
  0::bigint as opening_quantity,
  coalesce(movements.received_quantity, 0)::bigint as received_quantity,
  (
    coalesce(movements.store_sold_quantity, 0)
    + coalesce(movements.external_sold_quantity, 0)
    + coalesce(movements.mercadolibre_sold_quantity, 0)
  )::bigint as sold_quantity,
  coalesce(movements.restocked_quantity, 0)::bigint as restocked_quantity,
  coalesce(movements.outgoing_quantity, 0)::bigint as outgoing_quantity,
  case
    when variants.id is not null then coalesce(variants.stock, 0)
    else coalesce(products.stock, 0)
  end::bigint as available_quantity,
  coalesce(movements.store_sold_quantity, 0)::bigint
    as store_sold_quantity,
  coalesce(movements.external_sold_quantity, 0)::bigint
    as external_sold_quantity,
  coalesce(movements.mercadolibre_sold_quantity, 0)::bigint
    as mercadolibre_sold_quantity
from public.productos products
left join public.producto_variantes variants
  on variants.producto_id = products.id
left join lateral (
  select
    sum(values.quantity_delta) filter (
      where values.source = 'purchase'
    ) as received_quantity,
    -sum(values.quantity_delta) filter (
      where values.source = 'web_sale'
    ) as store_sold_quantity,
    -sum(values.quantity_delta) filter (
      where values.source = 'external_sale'
    ) as external_sold_quantity,
    -sum(values.quantity_delta) filter (
      where values.source = 'mercadolibre_sale'
    ) as mercadolibre_sold_quantity,
    sum(values.quantity_delta) filter (
      where values.source = 'approved_return'
    ) as restocked_quantity,
    -sum(values.quantity_delta) filter (
      where values.source = 'product_expense'
    ) as outgoing_quantity
  from public.inventory_movements values
  where values.product_id = products.id
    and values.variant_id is not distinct from variants.id
    and values.movement_date <= current_date
) movements on true;

create or replace view public.inventory_stock_timeline
with (security_invoker = true)
as
select
  movements.product_id,
  movements.variant_id,
  movements.movement_date,
  movements.recorded_at,
  movements.source,
  movements.source_id,
  movements.quantity_delta,
  sum(movements.quantity_delta) over (
    partition by
      movements.product_id,
      movements.variant_id
    order by
      movements.movement_date,
      movements.recorded_at,
      movements.source,
      movements.source_id
    rows between unbounded preceding and current row
  )::bigint as running_stock
from public.inventory_movements movements;

grant select on public.inventory_stock_breakdown to authenticated;
grant select on public.inventory_stock_timeline to authenticated;

truncate table public.inventory_opening_balances;
revoke insert, update, delete on public.inventory_opening_balances
  from authenticated;

do $$
declare
  v_product_id bigint;
begin
  for v_product_id in
    select id from public.productos
  loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;
end;
$$;

comment on view public.inventory_movements is
  'Libro único de movimientos con la fecha comercial real de cada compra, venta, devolución y salida.';
comment on view public.inventory_stock_timeline is
  'Saldo cronológico de inventario por producto y variante.';
comment on view public.inventory_stock_breakdown is
  'Resumen actual derivado exclusivamente del libro cronológico de movimientos.';
