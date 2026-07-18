alter table public.orden_items
  add column if not exists return_restocked_quantity integer not null default 0,
  add column if not exists return_written_off_quantity integer not null default 0,
  add column if not exists return_inventory_note text,
  add column if not exists return_inventory_processed_at timestamptz,
  add column if not exists return_inventory_processed_by uuid references auth.users(id) on delete set null;

alter table public.orden_items
  drop constraint if exists orden_items_return_inventory_quantities_check;

alter table public.orden_items
  add constraint orden_items_return_inventory_quantities_check
  check (
    return_restocked_quantity >= 0
    and return_written_off_quantity >= 0
    and return_restocked_quantity + return_written_off_quantity <= cantidad
  );

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
  v_previous_restocked integer;
  v_previous_written_off integer;
  v_stock_delta integer;
  v_product_stock integer;
  v_variant_stock integer;
begin
  if p_restocked_quantity < 0 or p_written_off_quantity < 0 then
    raise exception 'Las cantidades de la devolución no pueden ser negativas.';
  end if;

  if p_written_off_quantity > 0 and length(trim(coalesce(p_note, ''))) < 3 then
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
    raise exception 'La recepción de este producto ya fue registrada y no puede modificarse.';
  end if;

  if p_restocked_quantity + p_written_off_quantity > v_item.cantidad then
    raise exception 'La cantidad recibida no puede superar la cantidad vendida.';
  end if;

  v_previous_restocked := coalesce(v_item.return_restocked_quantity, 0);
  v_previous_written_off := coalesce(v_item.return_written_off_quantity, 0);
  v_stock_delta := p_restocked_quantity - v_previous_restocked;

  select coalesce(stock, 0)
  into v_product_stock
  from public.productos
  where id = v_item.producto_id
  for update;

  if not found then
    raise exception 'No se encontró el producto asociado al pedido.';
  end if;

  if v_product_stock + v_stock_delta < 0 then
    raise exception 'No se puede corregir la recepción porque ese stock ya no está disponible.';
  end if;

  if v_item.variante_id is not null then
    select coalesce(stock, 0)
    into v_variant_stock
    from public.producto_variantes
    where id = v_item.variante_id
      and producto_id = v_item.producto_id
    for update;

    if not found then
      raise exception 'No se encontró la variante asociada al pedido.';
    end if;

    if v_variant_stock + v_stock_delta < 0 then
      raise exception 'No se puede corregir la recepción porque el stock de la variante ya no está disponible.';
    end if;
  end if;

  if v_stock_delta <> 0 then
    update public.productos
    set stock = coalesce(stock, 0) + v_stock_delta
    where id = v_item.producto_id;

    if v_item.variante_id is not null then
      update public.producto_variantes
      set stock = coalesce(stock, 0) + v_stock_delta
      where id = v_item.variante_id;
    end if;
  end if;

  update public.orden_items
  set return_restocked_quantity = p_restocked_quantity,
      return_written_off_quantity = p_written_off_quantity,
      return_inventory_note = nullif(left(trim(coalesce(p_note, '')), 1000), ''),
      return_inventory_processed_at = now(),
      return_inventory_processed_by = p_processed_by
  where id = v_item.id
  returning * into v_item;

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
      'previousRestockedQuantity', v_previous_restocked,
      'previousWrittenOffQuantity', v_previous_written_off,
      'restockedQuantity', p_restocked_quantity,
      'writtenOffQuantity', p_written_off_quantity,
      'stockDelta', v_stock_delta,
      'note', v_item.return_inventory_note
    )
  );

  return v_item;
end;
$$;

revoke all on function public.process_order_item_return_inventory(bigint, bigint, integer, integer, text, uuid)
  from public, anon, authenticated;

grant execute on function public.process_order_item_return_inventory(bigint, bigint, integer, integer, text, uuid)
  to service_role;
