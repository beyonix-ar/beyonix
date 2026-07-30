-- Ningún movimiento nuevo puede quedar en el pool genérico si el artículo ya
-- requiere una variante. Los movimientos históricos conservan su imputación.

drop trigger if exists validate_external_sale_variant
  on public.external_sales;
create trigger validate_external_sale_variant
before insert or update
on public.external_sales
for each row execute function public.validate_external_sale_variant();

create or replace function public.validate_ml_sale_variant()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_variant_id bigint;
  v_variant_product_id bigint;
  v_old_variant_id bigint;
begin
  if new.product_id is null
     or public.inventory_ml_stock_units(new.quantity, new.raw_data) = 0 then
    return new;
  end if;

  v_variant_id := public.inventory_ml_variant_id(new.raw_data);

  if v_variant_id is not null then
    select variants.producto_id
    into v_variant_product_id
    from public.producto_variantes variants
    where variants.id = v_variant_id;

    if not found or v_variant_product_id <> new.product_id then
      raise exception
        'La variante de la venta de Mercado Libre no pertenece al producto.';
    end if;
  elsif exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = new.product_id
  ) then
    -- Una reimportación debe ser idempotente: no se reclasifican ventas que
    -- ocurrieron antes de convertir el producto en variantes.
    if tg_op = 'UPDATE' then
      v_old_variant_id := public.inventory_ml_variant_id(old.raw_data);
      if old.product_id = new.product_id
         and v_old_variant_id is null then
        return new;
      end if;
    end if;

    raise exception
      'La venta de Mercado Libre requiere una variante de catálogo.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_ml_sale_variant
  on public.mercadolibre_sales;
create trigger validate_ml_sale_variant
before insert or update of product_id, raw_data, quantity
on public.mercadolibre_sales
for each row execute function public.validate_ml_sale_variant();

create or replace function public.validate_order_item_variant_identity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_variant_product_id bigint;
begin
  if new.variante_id is not null then
    select variants.producto_id
    into v_variant_product_id
    from public.producto_variantes variants
    where variants.id = new.variante_id;

    if not found or v_variant_product_id <> new.producto_id then
      raise exception 'La variante del pedido no pertenece al producto.';
    end if;
  elsif exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = new.producto_id
  ) then
    raise exception 'CHECKOUT_VARIANT_REQUIRED';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_order_item_variant_identity
  on public.orden_items;
create trigger validate_order_item_variant_identity
before insert or update of producto_id, variante_id
on public.orden_items
for each row execute function public.validate_order_item_variant_identity();
