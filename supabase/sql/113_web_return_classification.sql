-- Permite clasificar devoluciones web con el mismo modelo físico que ML.

create or replace function public.validate_inventory_return_condition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

  new.quantity := new.sellable_quantity + new.discounted_quantity;

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
$$;

comment on function public.validate_inventory_return_condition() is
  'Valida devoluciones web y ML sin reclasificar automáticamente todo como stock normal.';

