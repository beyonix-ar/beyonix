-- P0 (continuación de 20260827200001): ensure_cost_catalog_product() --
-- llamada por el trigger link_cost_entry_to_shared_catalog en
-- product_cost_entries (módulo de Compras) -- también insertaba
-- literalmente en cuotas_sin_interes/cuotas_maximas, columnas eliminadas
-- por 20260827100001_installments_financing_cleanup.sql. Cualquier alta de
-- costo/compra que necesitara crear un producto placeholder nuevo (SKU sin
-- vincular todavía a un producto del catálogo) está rota ahora mismo en
-- producción con SQLSTATE 42703.
--
-- El producto placeholder que crea esta función nunca tuvo cuotas
-- habilitadas (siempre insertaba false/null) -- se preserva exactamente
-- ese comportamiento con los 3 flags nuevos en false. No se toca ninguna
-- otra parte del módulo de Compras.

create or replace function public.ensure_cost_catalog_product(
  p_name text,
  p_sku text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(btrim(p_name), '');
  v_sku text := nullif(btrim(p_sku), '');
  v_identity text;
  v_product_id bigint;
begin
  if v_name is null then
    raise exception 'El artículo debe tener un nombre.';
  end if;

  v_identity := coalesce(public.normalized_catalog_sku(v_sku), lower(v_name));
  perform pg_advisory_xact_lock(
    hashtext('cost-catalog-product'),
    hashtext(v_identity)
  );

  if v_sku is not null then
    select registry.product_id
    into v_product_id
    from public.catalog_sku_registry registry
    where registry.normalized_sku = public.normalized_catalog_sku(v_sku)
      and registry.product_id is not null;
  end if;

  if v_product_id is null then
    select products.id
    into v_product_id
    from public.productos products
    where (
      v_sku is not null
      and public.normalized_catalog_sku(products.sku)
        = public.normalized_catalog_sku(v_sku)
    ) or (
      v_sku is null
      and lower(btrim(products.nombre)) = lower(v_name)
    )
    order by products.created_from_costs, products.id
    limit 1
    for update;
  end if;

  if v_product_id is not null then
    update public.productos products
    set sku = coalesce(v_sku, products.sku)
    where products.id = v_product_id
      and products.created_from_costs
      and not exists (
        select 1
        from public.producto_variantes variants
        where variants.producto_id = products.id
      );
    return v_product_id;
  end if;

  insert into public.productos (
    nombre, slug, descripcion, precio, precio_anterior, descuento,
    cuotas_2_habilitadas, cuotas_3_habilitadas, cuotas_6_habilitadas,
    stock, categoria_id, destacado,
    activo, imagen_principal, video_url, sku, created_from_costs
  ) values (
    v_name,
    'compra-' || substr(md5(v_identity), 1, 24),
    null,
    0,
    null,
    null,
    false,
    false,
    false,
    0,
    null,
    false,
    false,
    null,
    null,
    v_sku,
    true
  )
  returning id into v_product_id;

  return v_product_id;
end;
$$;
