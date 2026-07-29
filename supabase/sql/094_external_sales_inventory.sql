-- Incorpora las ventas externas y de Mercado Libre a la fuente única de stock.
-- Las ventas de Mercado Libre sólo descuentan inventario cuando están vinculadas
-- a un producto del catálogo. Las cancelaciones no consumen; una devolución no
-- reingresa automáticamente hasta que exista recepción y aprobación física.
-- MIGRACIÓN HISTÓRICA: no volver a ejecutarla después de la migración 095.
-- Para actualizar únicamente la descripción visible, usar
-- 100_inventory_stock_wording.sql.

do $$
begin
  if to_regclass('public.inventory_variant_allocations') is not null then
    raise exception
      'La migración 094 es histórica y no debe volver a ejecutarse. Aplicá 101_restore_variant_inventory_calculation.sql.';
  end if;
end;
$$;

create or replace function public.inventory_ml_variant_id(
  p_raw_data jsonb
)
returns bigint
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(
      p_raw_data #>> '{beyonix_cost_mapping,variant_id}',
      ''
    ) ~ '^[1-9][0-9]*$'
      then (p_raw_data #>> '{beyonix_cost_mapping,variant_id}')::bigint
    else null
  end;
$$;

create or replace function public.inventory_ml_stock_units(
  p_quantity integer,
  p_raw_data jsonb
)
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
  v_quantity integer := greatest(coalesce(p_quantity, 0), 0);
  v_status text := lower(coalesce(
    p_raw_data -> 'parsed' ->> 'status',
    ''
  ));
begin
  if v_status like '%cancel%'
     or v_status like '%anulad%' then
    return 0;
  end if;

  return v_quantity;
end;
$$;

revoke all on function public.inventory_ml_variant_id(jsonb)
  from public, anon;
revoke all on function public.inventory_ml_stock_units(integer, jsonb)
  from public, anon;
grant execute on function public.inventory_ml_variant_id(jsonb)
  to authenticated, service_role;
grant execute on function public.inventory_ml_stock_units(integer, jsonb)
  to authenticated, service_role;

-- Vincula publicaciones históricas por SKU únicamente cuando la coincidencia
-- es inequívoca y el producto no requiere elegir una variante.
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
  set stock =
    coalesce((
      select sum(entries.received_quantity)
      from public.product_cost_entries entries
      where entries.product_id = variants.producto_id
        and entries.variant_id = variants.id
        and entries.purchase_date <= current_date
    ), 0)
    - coalesce((
      select sum(items.cantidad)
      from public.orden_items items
      join public.ordenes orders on orders.id = items.orden_id
      where items.producto_id = variants.producto_id
        and items.variante_id = variants.id
        and public.inventory_order_consumes_stock(
          orders.estado,
          orders.payment_status
        )
        and orders.created_at::date <= current_date
    ), 0)
    - coalesce((
      select sum(public.inventory_ml_stock_units(
        sales.quantity,
        sales.raw_data
      ))
      from public.mercadolibre_sales sales
      where sales.product_id = variants.producto_id
        and public.inventory_ml_variant_id(sales.raw_data) = variants.id
        and coalesce(
          (sales.sale_date at time zone 'America/Argentina/Buenos_Aires')::date,
          current_date
        ) <= current_date
    ), 0)
    + coalesce((
      select sum(items.quantity)
      from public.inventory_return_movements items
      where items.product_id = variants.producto_id
        and items.variant_id = variants.id
        and items.created_at::date <= current_date
    ), 0)
    - coalesce((
      select sum(costs.quantity)
      from public.business_expenses costs
      where costs.expense_type = 'product'
        and costs.product_id = variants.producto_id
        and costs.variant_id = variants.id
        and costs.expense_date <= current_date
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
    set stock =
      coalesce((
        select sum(entries.received_quantity)
        from public.product_cost_entries entries
        where entries.product_id = products.id
          and entries.variant_id is null
          and entries.purchase_date <= current_date
      ), 0)
      - coalesce((
        select sum(items.cantidad)
        from public.orden_items items
        join public.ordenes orders on orders.id = items.orden_id
        where items.producto_id = products.id
          and items.variante_id is null
          and public.inventory_order_consumes_stock(
            orders.estado,
            orders.payment_status
          )
          and orders.created_at::date <= current_date
      ), 0)
      - coalesce((
        select sum(sales.quantity)
        from public.external_sales sales
        where sales.product_id = products.id
          and sales.sale_date <= current_date
      ), 0)
      - coalesce((
        select sum(public.inventory_ml_stock_units(
          sales.quantity,
          sales.raw_data
        ))
        from public.mercadolibre_sales sales
        where sales.product_id = products.id
          and public.inventory_ml_variant_id(sales.raw_data) is null
          and coalesce(
            (sales.sale_date at time zone 'America/Argentina/Buenos_Aires')::date,
            current_date
          ) <= current_date
      ), 0)
      + coalesce((
        select sum(items.quantity)
        from public.inventory_return_movements items
        where items.product_id = products.id
          and items.variant_id is null
          and items.created_at::date <= current_date
      ), 0)
      - coalesce((
        select sum(costs.quantity)
        from public.business_expenses costs
        where costs.expense_type = 'product'
          and costs.product_id = products.id
          and costs.variant_id is null
          and costs.expense_date <= current_date
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

drop trigger if exists refresh_inventory_after_external_sale
  on public.external_sales;
create trigger refresh_inventory_after_external_sale
after insert or update or delete on public.external_sales
for each row execute function public.refresh_inventory_from_row();

drop trigger if exists refresh_inventory_after_mercadolibre_sale
  on public.mercadolibre_sales;
create trigger refresh_inventory_after_mercadolibre_sale
after insert or update or delete on public.mercadolibre_sales
for each row execute function public.refresh_inventory_from_row();

create or replace view public.inventory_stock_breakdown
with (security_invoker = true)
as
select
  products.id as product_id,
  variants.id as variant_id,
  0::bigint as opening_quantity,
  coalesce(purchases.quantity, 0)::bigint as received_quantity,
  (
    coalesce(store_sales.quantity, 0)
    + coalesce(external_sales.quantity, 0)
    + coalesce(ml_sales.quantity, 0)
  )::bigint as sold_quantity,
  coalesce(returns.quantity, 0)::bigint as restocked_quantity,
  coalesce(expenses.quantity, 0)::bigint as outgoing_quantity,
  case
    when variants.id is not null then coalesce(variants.stock, 0)
    else coalesce(products.stock, 0)
  end::bigint as available_quantity,
  coalesce(store_sales.quantity, 0)::bigint as store_sold_quantity,
  coalesce(external_sales.quantity, 0)::bigint as external_sold_quantity,
  coalesce(ml_sales.quantity, 0)::bigint as mercadolibre_sold_quantity
from public.productos products
left join public.producto_variantes variants
  on variants.producto_id = products.id
left join lateral (
  select sum(entries.received_quantity) as quantity
  from public.product_cost_entries entries
  where entries.product_id = products.id
    and entries.variant_id is not distinct from variants.id
    and entries.purchase_date <= current_date
) purchases on true
left join lateral (
  select sum(items.cantidad) as quantity
  from public.orden_items items
  join public.ordenes orders on orders.id = items.orden_id
  where items.producto_id = products.id
    and items.variante_id is not distinct from variants.id
    and public.inventory_order_consumes_stock(
      orders.estado,
      orders.payment_status
    )
    and orders.created_at::date <= current_date
) store_sales on true
left join lateral (
  select sum(sales.quantity) as quantity
  from public.external_sales sales
  where sales.product_id = products.id
    and variants.id is null
    and sales.sale_date <= current_date
) external_sales on true
left join lateral (
  select sum(public.inventory_ml_stock_units(
    sales.quantity,
    sales.raw_data
  )) as quantity
  from public.mercadolibre_sales sales
  where sales.product_id = products.id
    and public.inventory_ml_variant_id(sales.raw_data)
      is not distinct from variants.id
    and coalesce(
      (sales.sale_date at time zone 'America/Argentina/Buenos_Aires')::date,
      current_date
    ) <= current_date
) ml_sales on true
left join lateral (
  select sum(movements.quantity) as quantity
  from public.inventory_return_movements movements
  where movements.product_id = products.id
    and movements.variant_id is not distinct from variants.id
    and movements.created_at::date <= current_date
) returns on true
left join lateral (
  select sum(costs.quantity) as quantity
  from public.business_expenses costs
  where costs.expense_type = 'product'
    and costs.product_id = products.id
    and costs.variant_id is not distinct from variants.id
    and costs.expense_date <= current_date
) expenses on true;

grant select on public.inventory_stock_breakdown to authenticated;

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
where entries.received_quantity <> 0

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

grant select on public.inventory_movements to authenticated;
grant select on public.inventory_stock_timeline to authenticated;

-- Ya no se conserva ningún stock manual o saldo inicial conciliado. La tabla
-- queda vacía temporalmente por compatibilidad con instalaciones que todavía
-- tengan dependencias de migraciones anteriores; ya no participa en consultas.
truncate table public.inventory_opening_balances;
revoke insert, update, delete on public.inventory_opening_balances
  from authenticated;

comment on function public.inventory_ml_stock_units(integer, jsonb) is
  'Calcula unidades vendidas en Mercado Libre excluyendo sólo cancelaciones; las devoluciones requieren reingreso aprobado.';
comment on view public.inventory_stock_breakdown is
  'Explica el stock usando compras, pedidos web, ventas externas, Mercado Libre, devoluciones y salidas.';
comment on view public.inventory_movements is
  'Libro único de movimientos de inventario con la fecha comercial real de cada compra y venta.';
comment on view public.inventory_stock_timeline is
  'Saldo cronológico de inventario por producto y variante.';
