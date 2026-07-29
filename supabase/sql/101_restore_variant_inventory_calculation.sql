-- Restaura el cálculo vigente de inventario después de que una migración
-- histórica (093/094/095) haya reemplazado accidentalmente esta función.
--
-- No crea compras ni ventas. Vuelve a sumar los movimientos ya registrados
-- y la distribución del inventario genérico entre variantes.

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
      select sum(movements.quantity_delta)
      from public.inventory_movements movements
      where movements.product_id = variants.producto_id
        and movements.variant_id = variants.id
        and movements.movement_date <= current_date
    ), 0)
    + coalesce((
      select allocations.quantity
      from public.inventory_variant_allocations allocations
      where allocations.variant_id = variants.id
    ), 0)
  where variants.producto_id = p_product_id;

  update public.productos products
  set stock = coalesce((
    select sum(movements.quantity_delta)
    from public.inventory_movements movements
    where movements.product_id = products.id
      and movements.movement_date <= current_date
  ), 0)
  where products.id = p_product_id;

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

comment on function public.refresh_inventory_stock(bigint) is
  'Recalcula el stock total y por variante desde movimientos y distribuciones registradas.';
