-- Revisión física de devoluciones de Mercado Libre.
-- Se reutiliza el libro de devoluciones existente para no duplicar inventario.

alter table public.inventory_return_movements
  alter column order_id drop not null,
  alter column order_item_id drop not null,
  add column if not exists mercadolibre_sale_id uuid
    references public.mercadolibre_sales(id) on delete cascade,
  add column if not exists received_quantity integer not null default 0,
  add column if not exists sellable_quantity integer not null default 0,
  add column if not exists discounted_quantity integer not null default 0,
  add column if not exists non_sellable_quantity integer not null default 0,
  add column if not exists discount_percent numeric(5, 2),
  add column if not exists review_notes text;

update public.inventory_return_movements
set
  received_quantity = quantity,
  sellable_quantity = quantity
where mercadolibre_sale_id is null
  and received_quantity = 0
  and sellable_quantity = 0;

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_movements_quantity_check,
  drop constraint if exists inventory_return_movements_source_check,
  drop constraint if exists inventory_return_movements_condition_check,
  add constraint inventory_return_movements_quantity_check
    check (quantity >= 0),
  add constraint inventory_return_movements_source_check check (
    (
      order_id is not null
      and order_item_id is not null
      and mercadolibre_sale_id is null
    )
    or (
      order_id is null
      and order_item_id is null
      and mercadolibre_sale_id is not null
    )
  ),
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
    and quantity = sellable_quantity + discounted_quantity
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

create unique index if not exists inventory_return_movements_ml_sale_unique
  on public.inventory_return_movements(mercadolibre_sale_id)
  where mercadolibre_sale_id is not null;

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
  new.quantity := new.sellable_quantity + new.discounted_quantity;

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

  if new.discounted_quantity = 0 then
    new.discount_percent := null;
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

drop trigger if exists validate_inventory_return_condition
  on public.inventory_return_movements;
create trigger validate_inventory_return_condition
before insert or update on public.inventory_return_movements
for each row execute function public.validate_inventory_return_condition();

create or replace view public.inventory_conditioned_stock
with (security_invoker = true)
as
select
  movements.product_id,
  movements.variant_id,
  sum(movements.sellable_quantity)::bigint as normal_returned_quantity,
  sum(movements.discounted_quantity)::bigint as discounted_quantity,
  sum(movements.non_sellable_quantity)::bigint as non_sellable_quantity,
  sum(
    movements.received_quantity
    - movements.sellable_quantity
    - movements.discounted_quantity
    - movements.non_sellable_quantity
  )::bigint as pending_review_quantity
from public.inventory_return_movements movements
where movements.mercadolibre_sale_id is not null
group by movements.product_id, movements.variant_id;

grant select on public.inventory_conditioned_stock to authenticated;

comment on view public.inventory_conditioned_stock is
  'Resume devoluciones ML vendibles normales, vendibles con descuento, no vendibles y pendientes.';
