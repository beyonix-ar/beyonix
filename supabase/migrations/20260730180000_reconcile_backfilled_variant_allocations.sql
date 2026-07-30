-- Cuando una devolución aprobada antes de que existiera la variante se
-- vinculó posteriormente, su unidad vendible dejó de pertenecer al saldo
-- genérico y pasó al libro de la variante. La asignación inicial ya incluía
-- esa unidad, por lo que hay que descontarla una sola vez de la base asignada.
do $$
declare
  v_product record;
  v_variant record;
  v_remaining bigint;
  v_reduction bigint;
begin
  for v_product in
    select
      integrity.product_id,
      integrity.allocation_overflow
    from public.inventory_stock_integrity integrity
    where integrity.allocation_overflow > 0
    order by integrity.product_id
  loop
    v_remaining := v_product.allocation_overflow;

    for v_variant in
      select
        allocations.variant_id,
        allocations.quantity,
        least(
          allocations.quantity,
          coalesce(sum(returns.sellable_quantity), 0)
        )::bigint as historical_return_units
      from public.inventory_variant_allocations allocations
      join public.producto_variantes variants
        on variants.id = allocations.variant_id
       and variants.producto_id = allocations.product_id
      join public.inventory_return_movements returns
        on returns.product_id = allocations.product_id
       and returns.variant_id = allocations.variant_id
       and returns.sellable_quantity > 0
       and coalesce(returns.approved_at, returns.created_at)
           <= variants.created_at
      where allocations.product_id = v_product.product_id
        and allocations.quantity > 0
      group by
        allocations.variant_id,
        allocations.quantity
      having coalesce(sum(returns.sellable_quantity), 0) > 0
      order by allocations.variant_id
    loop
      exit when v_remaining <= 0;

      v_reduction := least(
        v_remaining,
        v_variant.quantity,
        v_variant.historical_return_units
      );

      if v_reduction > 0 then
        update public.inventory_variant_allocations
        set quantity = quantity - v_reduction,
            updated_at = now()
        where product_id = v_product.product_id
          and variant_id = v_variant.variant_id;

        v_remaining := v_remaining - v_reduction;
      end if;
    end loop;

    -- Sólo recalcula cuando toda la diferencia queda explicada por
    -- devoluciones históricas vinculadas después. Una diferencia ambigua
    -- permanece visible para revisión manual.
    if v_remaining = 0 then
      perform public.refresh_inventory_stock(v_product.product_id);
    end if;
  end loop;
end;
$$;

comment on view public.inventory_stock_integrity is
  'Conciliación derivada entre libro, stock almacenado, variantes, devoluciones y distribución.';
