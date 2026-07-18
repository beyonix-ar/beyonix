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
  v_product_stock integer;
  v_product_active boolean;
  v_variant_product_id bigint;
  v_variant_stock integer;
  v_variant_active boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para modificar el inventario del checkout.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(
      product_id bigint,
      variant_id bigint,
      quantity integer
    )
    where item.product_id is null
       or item.product_id <= 0
       or item.quantity is null
       or item.quantity <= 0
       or (item.variant_id is not null and item.variant_id <= 0)
  ) then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;

  -- Los productos se bloquean siempre en el mismo orden para impedir carreras
  -- y reducir el riesgo de interbloqueos entre compras simultáneas.
  for v_item in
    select
      item.product_id,
      sum(item.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as item(
      product_id bigint,
      variant_id bigint,
      quantity integer
    )
    group by item.product_id
    order by item.product_id
  loop
    select coalesce(productos.stock, 0), coalesce(productos.activo, false)
    into v_product_stock, v_product_active
    from public.productos
    where productos.id = v_item.product_id
    for update;

    if not found then
      raise exception 'CHECKOUT_STOCK_INSUFFICIENT: producto inexistente %', v_item.product_id;
    end if;

    if not v_product_active or v_product_stock < v_item.quantity then
      raise exception 'CHECKOUT_STOCK_INSUFFICIENT: producto %', v_item.product_id;
    end if;
  end loop;

  -- Las variantes se bloquean después de los productos y también por ID.
  for v_item in
    select
      item.product_id,
      item.variant_id,
      sum(item.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as item(
      product_id bigint,
      variant_id bigint,
      quantity integer
    )
    where item.variant_id is not null
    group by item.product_id, item.variant_id
    order by item.variant_id
  loop
    select
      producto_variantes.producto_id,
      coalesce(producto_variantes.stock, 0),
      coalesce(producto_variantes.activo, false)
    into v_variant_product_id, v_variant_stock, v_variant_active
    from public.producto_variantes
    where producto_variantes.id = v_item.variant_id
    for update;

    if not found
       or v_variant_product_id <> v_item.product_id
       or not v_variant_active
       or v_variant_stock < v_item.quantity then
      raise exception 'CHECKOUT_STOCK_INSUFFICIENT: variante %', v_item.variant_id;
    end if;
  end loop;

  for v_item in
    select
      item.product_id,
      sum(item.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as item(
      product_id bigint,
      variant_id bigint,
      quantity integer
    )
    group by item.product_id
    order by item.product_id
  loop
    update public.productos
    set stock = stock - v_item.quantity
    where id = v_item.product_id;
  end loop;

  for v_item in
    select
      item.variant_id,
      sum(item.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as item(
      product_id bigint,
      variant_id bigint,
      quantity integer
    )
    where item.variant_id is not null
    group by item.variant_id
    order by item.variant_id
  loop
    update public.producto_variantes
    set stock = stock - v_item.quantity
    where id = v_item.variant_id;
  end loop;

  return jsonb_build_object('updated', true);
end;
$$;

revoke all on function public.decrement_checkout_inventory(jsonb)
  from public, anon, authenticated;
grant execute on function public.decrement_checkout_inventory(jsonb)
  to service_role;

comment on function public.decrement_checkout_inventory(jsonb) is
  'Valida y descuenta de forma atómica el stock general y por variante de una compra.';

create or replace function public.require_formal_claim_for_return_inventory()
returns trigger
language plpgsql
set search_path = public
as $$
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
$$;

drop trigger if exists require_formal_claim_for_return_inventory
  on public.orden_items;

create trigger require_formal_claim_for_return_inventory
before update on public.orden_items
for each row
execute function public.require_formal_claim_for_return_inventory();

comment on function public.require_formal_claim_for_return_inventory() is
  'Impide registrar devoluciones o bajas de inventario en pedidos sin reclamo formal.';
