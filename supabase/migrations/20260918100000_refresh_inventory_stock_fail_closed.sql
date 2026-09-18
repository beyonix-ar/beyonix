-- FASE 1 (hardening P0/P1 de inventario), punto 2: refresh_inventory_stock
-- recalcula stock desde el ledger (inventory_movements) sin ningún piso en
-- cero -- si el ledger tuviera un dato corrupto (venta duplicada, ajuste
-- mal cargado, movimiento histórico con signo invertido), la función
-- escribía el negativo tal cual, sin avisar. Confirmado leyendo la
-- definición real de producción (pg_get_functiondef, 2026-09-18): no había
-- ningún GREATEST(0, ...) ni chequeo posterior.
--
-- Política elegida (pedida explícitamente): FAIL CLOSED, no
-- GREATEST(0, ...). Convertir un -3 en 0 en silencio disimula una
-- corrupción real del ledger -- el producto quedaría mostrando "0
-- unidades" cuando en realidad hay un movimiento mal cargado en algún lado
-- que nadie va a investigar nunca. En cambio, si el recompute da negativo,
-- la función aborta con una excepción que nombra el producto/variante y el
-- valor calculado, y aborta TODA la transacción que la llamó (venta,
-- cancelación, ajuste, etc.) -- nada queda a medio aplicar ni el stock
-- queda escrito con un número que sabemos que está mal.
--
-- Ningún flujo normal debería disparar esto nunca (todos los caminos de
-- escritura -- checkout, ajuste manual, compra, devolución -- ya validan
-- disponibilidad bajo el mismo advisory lock antes de dejar un movimiento
-- negativo en el ledger). Esta excepción es explícitamente para el caso en
-- que ese invariante ya se rompió por otro motivo -- un backstop de
-- diagnóstico, no una regla de negocio nueva.
--
-- Se preserva EXACTAMENTE el resto de la función (misma fórmula, mismo
-- advisory lock, mismo manejo de beyonix.inventory_refresh) -- comparado
-- byte a byte contra pg_get_functiondef de producción antes de escribir
-- este archivo. Grants reafirmados idénticos a los confirmados en
-- producción (revoke de public/anon/authenticated, sólo service_role).

begin;

create or replace function public.refresh_inventory_stock(p_product_id bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_previous_refresh_setting text := coalesce(
    current_setting('beyonix.inventory_refresh', true),
    ''
  );
  v_negative_variant_id bigint;
  v_negative_variant_stock numeric;
  v_negative_product_stock numeric;
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

  select variants.id, variants.stock
  into v_negative_variant_id, v_negative_variant_stock
  from public.producto_variantes variants
  where variants.producto_id = p_product_id
    and variants.stock < 0
  order by variants.id
  limit 1;

  if found then
    perform set_config(
      'beyonix.inventory_refresh',
      v_previous_refresh_setting,
      true
    );
    raise exception
      'INVENTORY_CORRUPTION_NEGATIVE_STOCK: producto_variantes.id=%, producto_id=%, stock_calculado=% -- revisar inventory_movements/inventory_variant_allocations antes de reintentar',
      v_negative_variant_id, p_product_id, v_negative_variant_stock;
  end if;

  update public.productos products
  set stock = coalesce((
    select sum(movements.quantity_delta)
    from public.inventory_movements movements
    where movements.product_id = products.id
      and movements.movement_date <= current_date
  ), 0)
  where products.id = p_product_id;

  select products.stock
  into v_negative_product_stock
  from public.productos products
  where products.id = p_product_id
    and products.stock < 0;

  if found then
    perform set_config(
      'beyonix.inventory_refresh',
      v_previous_refresh_setting,
      true
    );
    raise exception
      'INVENTORY_CORRUPTION_NEGATIVE_STOCK: productos.id=%, stock_calculado=% -- revisar inventory_movements antes de reintentar',
      p_product_id, v_negative_product_stock;
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
$function$;

revoke all on function public.refresh_inventory_stock(bigint) from public, anon, authenticated;
grant execute on function public.refresh_inventory_stock(bigint) to service_role;

comment on function public.refresh_inventory_stock(bigint) is
  'Recalcula stock derivado (productos/producto_variantes) desde inventory_movements + inventory_variant_allocations. FAIL CLOSED: si el recompute da negativo, aborta con excepción en vez de pisar con 0 -- nunca esconde una corrupción del ledger. Fix 20260918100000.';

notify pgrst, 'reload schema';

commit;
