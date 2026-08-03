-- Convierte la fila "Variante principal" de productos con stock condicionado
-- en una variante persistida. El padre conserva únicamente la proyección total.

do $migration$
declare
  v_product record;
  v_variant_id bigint;
  v_images jsonb;
  v_stock_before integer;
  v_ledger_before bigint;
  v_parent_after integer;
  v_variants_after bigint;
  v_discounted_before bigint;
  v_discounted_after bigint;
begin
  for v_product in
    select products.*
    from public.productos products
    where not exists (
      select 1
      from public.producto_variantes variants
      where variants.producto_id = products.id
    )
      and exists (
        select 1
        from public.inventory_return_movements returns
        where returns.product_id = products.id
          and returns.discounted_quantity > 0
      )
    order by products.id
  loop
    perform pg_advisory_xact_lock(93000, v_product.id::integer);

    -- Esta segunda comprobación vuelve idempotente la migración si otra
    -- transacción materializó la variante mientras esperaba el bloqueo.
    if exists (
      select 1
      from public.producto_variantes variants
      where variants.producto_id = v_product.id
    ) then
      continue;
    end if;

    select products.stock
    into v_stock_before
    from public.productos products
    where products.id = v_product.id
    for update;

    select coalesce(sum(movements.quantity_delta), 0)::bigint
    into v_ledger_before
    from public.inventory_movements movements
    where movements.product_id = v_product.id
      and movements.movement_date <= current_date;

    if v_stock_before is distinct from v_ledger_before then
      raise exception
        'No se materializó la variante principal del producto %: el stock padre (%) no coincide con el libro (%).',
        v_product.id,
        v_stock_before,
        v_ledger_before;
    end if;

    select coalesce(sum(returns.discounted_quantity), 0)::bigint
    into v_discounted_before
    from public.inventory_return_movements returns
    where returns.product_id = v_product.id;

    select coalesce(
      jsonb_agg(to_jsonb(product_images.url) order by product_images.sort_order, product_images.image_id),
      '[]'::jsonb
    )
    into v_images
    from (
      select
        v_product.imagen_principal::text as url,
        -1::integer as sort_order,
        0::bigint as image_id
      where nullif(btrim(coalesce(v_product.imagen_principal, '')), '') is not null

      union all

      select
        images.url,
        coalesce(images.orden, 0),
        images.id
      from public.imagenes_producto images
      where images.producto_id = v_product.id
        and nullif(btrim(coalesce(images.url, '')), '') is not null
        and btrim(images.url) is distinct from btrim(v_product.imagen_principal)
    ) product_images;

    insert into public.producto_variantes (
      producto_id,
      nombre,
      sku,
      color_hex,
      stock,
      imagenes,
      activo,
      orden,
      peso_empaquetado_kg,
      alto_paquete_cm,
      ancho_paquete_cm,
      largo_paquete_cm
    ) values (
      v_product.id,
      'Principal',
      nullif(btrim(coalesce(v_product.sku, '')), ''),
      '#000000',
      0,
      v_images,
      v_product.activo,
      1,
      v_product.peso_empaquetado_kg,
      v_product.alto_paquete_cm,
      v_product.ancho_paquete_cm,
      v_product.largo_paquete_cm
    )
    returning id into v_variant_id;

    -- Se reasignan las fuentes del libro. No se crean movimientos
    -- compensatorios ni se modifica el historial inmutable de operaciones.
    update public.product_cost_entries entries
    set variant_id = v_variant_id
    where entries.product_id = v_product.id
      and entries.variant_id is null;

    perform set_config('beyonix.inventory_variant_link', 'on', true);
    update public.inventory_return_movements returns
    set variant_id = v_variant_id
    where returns.product_id = v_product.id
      and returns.variant_id is null;

    -- Esta tabla existió en instalaciones anteriores y quedó vacía en el
    -- esquema actual. El bloque condicional mantiene compatible la migración.
    if to_regclass('public.inventory_opening_balances') is not null then
      execute
        'update public.inventory_opening_balances
         set variant_id = $1
         where product_id = $2 and variant_id is null'
      using v_variant_id, v_product.id;
    end if;

    -- Las fuentes de egreso se trasladan después de los ingresos para que los
    -- controles de stock nunca observen un saldo negativo transitorio.
    update public.orden_items items
    set variante_id = v_variant_id
    where items.producto_id = v_product.id
      and items.variante_id is null
      and items.conditioned_stock_id is null;

    update public.external_sales sales
    set variant_id = v_variant_id
    where sales.product_id = v_product.id
      and sales.variant_id is null;

    update public.mercadolibre_sales sales
    set raw_data = coalesce(sales.raw_data, '{}'::jsonb)
      || jsonb_build_object(
        'beyonix_cost_mapping',
        coalesce(sales.raw_data -> 'beyonix_cost_mapping', '{}'::jsonb)
          || jsonb_build_object('variant_id', v_variant_id)
      )
    where sales.product_id = v_product.id
      and public.inventory_ml_variant_id(sales.raw_data) is null;

    update public.business_expenses expenses
    set variant_id = v_variant_id
    where expenses.product_id = v_product.id
      and expenses.variant_id is null;

    update public.stock_reservations reservations
    set variant_id = v_variant_id
    where reservations.product_id = v_product.id
      and reservations.variant_id is null
      and reservations.conditioned_stock_id is null;

    delete from public.inventory_variant_allocations allocations
    where allocations.product_id = v_product.id;

    perform public.refresh_inventory_stock(v_product.id);

    if exists (
      select 1
      from public.inventory_movements movements
      where movements.product_id = v_product.id
        and movements.variant_id is null
    ) then
      raise exception
        'La variante principal del producto % dejó movimientos sin variante.',
        v_product.id;
    end if;

    select
      products.stock,
      coalesce(sum(variants.stock), 0)::bigint
    into v_parent_after, v_variants_after
    from public.productos products
    left join public.producto_variantes variants
      on variants.producto_id = products.id
    where products.id = v_product.id
    group by products.id, products.stock;

    if v_parent_after is distinct from v_stock_before
       or v_variants_after is distinct from v_parent_after then
      raise exception
        'La migración del producto % alteró el stock: antes %, padre %, variantes %.',
        v_product.id,
        v_stock_before,
        v_parent_after,
        v_variants_after;
    end if;

    select coalesce(sum(returns.discounted_quantity), 0)::bigint
    into v_discounted_after
    from public.inventory_return_movements returns
    where returns.product_id = v_product.id;

    if v_discounted_after is distinct from v_discounted_before then
      raise exception
        'La migración del producto % alteró el stock con descuento.',
        v_product.id;
    end if;
  end loop;
end;
$migration$;

comment on column public.productos.stock is
  'Proyección derivada del libro de inventario; en productos con variantes equivale a la suma del stock de sus variantes.';
