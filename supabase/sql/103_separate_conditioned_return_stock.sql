-- Separa el stock nuevo del inventario devuelto con descuento o no vendible.
-- Solamente las devoluciones clasificadas como vendibles vuelven al stock normal.

alter table public.inventory_return_movements
  add column if not exists discount_reason text,
  add column if not exists non_sellable_reason text;

drop trigger if exists validate_inventory_return_condition
  on public.inventory_return_movements;

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_movements_condition_check;

update public.inventory_return_movements
set quantity = sellable_quantity
where mercadolibre_sale_id is not null
  and quantity is distinct from sellable_quantity;

alter table public.inventory_return_movements
  add constraint inventory_return_movements_condition_check check (
    received_quantity >= 0
    and sellable_quantity >= 0
    and discounted_quantity >= 0
    and non_sellable_quantity >= 0
    and (
      sellable_quantity
      + discounted_quantity
      + non_sellable_quantity
    ) <= received_quantity
    and quantity = sellable_quantity
    and (
      (
        discounted_quantity = 0
        and discount_percent is null
      )
      or (
        discounted_quantity > 0
        and discount_percent > 0
        and discount_percent < 100
      )
    )
  );

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
    raise exception 'La venta de Mercado Libre debe estar vinculada a un producto.';
  end if;

  new.product_id := v_sale.product_id;
  new.variant_id := public.inventory_ml_variant_id(v_sale.raw_data);
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
  end if;

  if new.non_sellable_quantity = 0 then
    new.non_sellable_reason := null;
  end if;

  if new.variant_id is not null then
    select producto_id
    into v_variant_product_id
    from public.producto_variantes
    where id = new.variant_id;

    if v_variant_product_id is distinct from new.product_id then
      raise exception 'La variante vinculada no pertenece al producto.';
    end if;
  end if;

  return new;
end;
$$;

create trigger validate_inventory_return_condition
before insert or update on public.inventory_return_movements
for each row execute function public.validate_inventory_return_condition();

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

comment on column public.inventory_return_movements.discount_reason is
  'Motivo obligatorio cuando una devolución queda disponible con descuento.';
comment on column public.inventory_return_movements.non_sellable_reason is
  'Motivo obligatorio cuando una devolución queda fuera del stock comercial.';
