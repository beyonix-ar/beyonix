-- Consolida el catálogo comercial sin convertirlo en otra fuente de stock.
-- Todas las operaciones toman el mismo bloqueo por producto que Compras e
-- Inventario, y conservan la configuración interna de las variantes.

-- La disponibilidad comercial se resuelve como producto.activo AND
-- variante.activo. Estos triggers históricos destruían la preferencia de la
-- variante al pausar el padre y hacían imposible restaurarla fielmente.
drop trigger if exists deactivate_product_variants_trigger
  on public.productos;
drop trigger if exists prevent_active_variant_on_inactive_product_trigger
  on public.producto_variantes;

create or replace function public.sync_product_primary_variant_image(
  p_product_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary_image text;
begin
  select images.value
  into v_primary_image
  from public.producto_variantes variants
  cross join lateral jsonb_array_elements_text(
    coalesce(variants.imagenes, '[]'::jsonb)
  ) with ordinality as images(value, position)
  where variants.producto_id = p_product_id
    and nullif(btrim(images.value), '') is not null
  order by variants.orden, variants.id, images.position
  limit 1;

  update public.productos
  set imagen_principal = v_primary_image
  where id = p_product_id
    and imagen_principal is distinct from v_primary_image;
end;
$$;

revoke all on function public.sync_product_primary_variant_image(bigint)
  from public, anon, authenticated;
grant execute on function public.sync_product_primary_variant_image(bigint)
  to service_role;

-- Una compra libre reutiliza un SKU de catálogo exacto y, si es realmente un
-- artículo nuevo, crea un producto base inactivo. El advisory lock evita dos
-- productos automáticos para la misma identidad bajo concurrencia.
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
    cuotas_sin_interes, cuotas_maximas, stock, categoria_id, destacado,
    activo, imagen_principal, video_url, sku, created_from_costs
  ) values (
    v_name,
    'compra-' || substr(md5(v_identity), 1, 24),
    null,
    0,
    null,
    null,
    false,
    null,
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

create or replace function public.link_cost_entry_to_shared_catalog()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_registry_product_id bigint;
  v_registry_variant_id bigint;
begin
  if new.product_id is null and nullif(btrim(new.article_name), '') is not null then
    if public.normalized_catalog_sku(new.sku) is not null then
      select
        coalesce(registry.product_id, variants.producto_id),
        registry.variant_id
      into v_registry_product_id, v_registry_variant_id
      from public.catalog_sku_registry registry
      left join public.producto_variantes variants
        on variants.id = registry.variant_id
      where registry.normalized_sku = public.normalized_catalog_sku(new.sku);
    end if;

    if v_registry_product_id is not null then
      new.product_id := v_registry_product_id;
      new.variant_id := v_registry_variant_id;
    else
      new.product_id := public.ensure_cost_catalog_product(
        new.article_name,
        new.sku
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists link_cost_entry_to_shared_catalog
  on public.product_cost_entries;
create trigger link_cost_entry_to_shared_catalog
before insert or update of product_id, article_name, sku
on public.product_cost_entries
for each row execute function public.link_cost_entry_to_shared_catalog();

create or replace function public.sync_cost_catalog_product_sku()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.product_id is not null and nullif(btrim(new.sku), '') is not null then
    update public.productos products
    set sku = btrim(new.sku)
    where products.id = new.product_id
      and products.created_from_costs
      and not exists (
        select 1
        from public.producto_variantes variants
        where variants.producto_id = products.id
      );
  end if;
  return new;
end;
$$;

drop trigger if exists sync_cost_catalog_product_sku
  on public.product_cost_entries;
create trigger sync_cost_catalog_product_sku
after insert or update of sku
on public.product_cost_entries
for each row execute function public.sync_cost_catalog_product_sku();

create or replace function public.update_product_catalog_atomic(
  p_product_id bigint,
  p_catalog jsonb,
  p_primary_sku text,
  p_actor_id uuid
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
  v_primary_variant_id bigint;
  v_name text := nullif(btrim(coalesce(p_catalog ->> 'nombre', '')), '');
  v_slug text := nullif(btrim(coalesce(p_catalog ->> 'slug', '')), '');
  v_price numeric := nullif(p_catalog ->> 'precio', '')::numeric;
  v_active boolean := coalesce((p_catalog ->> 'activo')::boolean, false);
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para actualizar el catálogo.';
  end if;
  if p_product_id is null
     or jsonb_typeof(coalesce(p_catalog, 'null'::jsonb)) <> 'object'
     or v_name is null
     or v_slug is null
     or v_price is null
     or v_price < 0 then
    raise exception 'Los datos comerciales del producto no son válidos.';
  end if;
  if v_active and v_price <= 0 then
    raise exception 'El producto no puede activarse porque no tiene precio.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select * into v_product
  from public.productos products
  where products.id = p_product_id
  for update;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;

  select variants.id
  into v_primary_variant_id
  from public.producto_variantes variants
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id
  limit 1
  for update;

  if v_active
     and v_primary_variant_id is not null
     and not exists (
       select 1
       from public.producto_variantes variants
       where variants.producto_id = p_product_id
         and variants.activo
     ) then
    raise exception 'El producto no puede activarse porque no tiene ninguna variante activa.';
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);

  if v_primary_variant_id is not null then
    update public.producto_variantes
    set sku = nullif(left(btrim(coalesce(p_primary_sku, '')), 120), '')
    where id = v_primary_variant_id;
  end if;

  update public.productos products
  set nombre = left(v_name, 240),
      sku = case
        when v_primary_variant_id is null
          then nullif(left(btrim(coalesce(p_primary_sku, '')), 120), '')
        else null
      end,
      slug = left(v_slug, 240),
      descripcion = nullif(p_catalog ->> 'descripcion', ''),
      video_url = nullif(p_catalog ->> 'video_url', ''),
      precio = v_price,
      precio_anterior = nullif(p_catalog ->> 'precio_anterior', '')::numeric,
      descuento = nullif(p_catalog ->> 'descuento', '')::numeric,
      cuotas_sin_interes = coalesce(
        (p_catalog ->> 'cuotas_sin_interes')::boolean,
        false
      ),
      cuotas_maximas = nullif(p_catalog ->> 'cuotas_maximas', '')::integer,
      promo_event_id = nullif(p_catalog ->> 'promo_event_id', '')::uuid,
      promo_original_precio = nullif(
        p_catalog ->> 'promo_original_precio',
        ''
      )::numeric,
      promo_original_precio_anterior = nullif(
        p_catalog ->> 'promo_original_precio_anterior',
        ''
      )::numeric,
      promo_original_descuento = nullif(
        p_catalog ->> 'promo_original_descuento',
        ''
      )::numeric,
      promo_original_cuotas_sin_interes = nullif(
        p_catalog ->> 'promo_original_cuotas_sin_interes',
        ''
      )::boolean,
      promo_original_cuotas_maximas = nullif(
        p_catalog ->> 'promo_original_cuotas_maximas',
        ''
      )::integer,
      categoria_id = nullif(p_catalog ->> 'categoria_id', '')::bigint,
      destacado = coalesce((p_catalog ->> 'destacado')::boolean, false),
      activo = v_active,
      peso_empaquetado_kg = nullif(p_catalog ->> 'peso_empaquetado_kg', '')::numeric,
      alto_paquete_cm = nullif(p_catalog ->> 'alto_paquete_cm', '')::numeric,
      ancho_paquete_cm = nullif(p_catalog ->> 'ancho_paquete_cm', '')::numeric,
      largo_paquete_cm = nullif(p_catalog ->> 'largo_paquete_cm', '')::numeric
  where products.id = p_product_id
  returning * into v_product;

  return v_product;
end;
$$;

revoke all on function public.update_product_catalog_atomic(bigint, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function public.update_product_catalog_atomic(bigint, jsonb, text, uuid)
  to service_role;

create or replace function public.set_product_commercial_state_atomic(
  p_product_id bigint,
  p_active boolean,
  p_actor_id uuid
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cambiar el estado comercial.';
  end if;
  if p_product_id is null or p_active is null then
    raise exception 'El estado comercial no es válido.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select * into v_product
  from public.productos products
  where products.id = p_product_id
  for update;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;
  if p_active and coalesce(v_product.precio, 0) <= 0 then
    raise exception 'El producto no puede activarse porque no tiene precio.';
  end if;
  if p_active
     and exists (
       select 1 from public.producto_variantes variants
       where variants.producto_id = p_product_id
     )
     and not exists (
       select 1 from public.producto_variantes variants
       where variants.producto_id = p_product_id and variants.activo
     ) then
    raise exception 'El producto no puede activarse porque no tiene ninguna variante activa.';
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  update public.productos
  set activo = p_active
  where id = p_product_id
  returning * into v_product;

  return v_product;
end;
$$;

revoke all on function public.set_product_commercial_state_atomic(bigint, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.set_product_commercial_state_atomic(bigint, boolean, uuid)
  to service_role;

create or replace function public.set_product_variant_state_atomic(
  p_product_id bigint,
  p_variant_id bigint,
  p_active boolean,
  p_actor_id uuid
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_active boolean;
  v_variant public.producto_variantes%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cambiar el estado de la variante.';
  end if;
  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  select products.activo into v_product_active
  from public.productos products
  where products.id = p_product_id
  for update;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;

  select * into v_variant
  from public.producto_variantes variants
  where variants.id = p_variant_id
    and variants.producto_id = p_product_id
  for update;
  if not found then
    raise exception 'La variante ya no existe.';
  end if;
  if not p_active
     and v_product_active
     and not exists (
       select 1
       from public.producto_variantes variants
       where variants.producto_id = p_product_id
         and variants.id <> p_variant_id
         and variants.activo
     ) then
    raise exception 'No podés desactivar la única variante activa. Desactivá primero el producto.';
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  update public.producto_variantes
  set activo = p_active
  where id = p_variant_id
  returning * into v_variant;

  return v_variant;
end;
$$;

revoke all on function public.set_product_variant_state_atomic(bigint, bigint, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.set_product_variant_state_atomic(bigint, bigint, boolean, uuid)
  to service_role;

create or replace function public.update_product_variant_metadata_atomic(
  p_product_id bigint,
  p_variant_id bigint,
  p_metadata jsonb,
  p_actor_id uuid
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para actualizar la variante.';
  end if;
  if jsonb_typeof(coalesce(p_metadata, 'null'::jsonb)) <> 'object' then
    raise exception 'Los datos de la variante no son válidos.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  perform set_config('beyonix.actor_id', p_actor_id::text, true);

  update public.producto_variantes variants
  set nombre = case when p_metadata ? 'nombre'
        then left(btrim(p_metadata ->> 'nombre'), 160) else variants.nombre end,
      sku = case when p_metadata ? 'sku'
        then nullif(left(btrim(coalesce(p_metadata ->> 'sku', '')), 120), '')
        else variants.sku end,
      color_hex = case when p_metadata ? 'color_hex'
        then upper(p_metadata ->> 'color_hex') else variants.color_hex end,
      imagenes = case when p_metadata ? 'imagenes'
        then p_metadata -> 'imagenes' else variants.imagenes end,
      orden = case when p_metadata ? 'orden'
        then (p_metadata ->> 'orden')::integer else variants.orden end,
      peso_empaquetado_kg = case when p_metadata ? 'peso_empaquetado_kg'
        then nullif(p_metadata ->> 'peso_empaquetado_kg', '')::numeric
        else variants.peso_empaquetado_kg end,
      alto_paquete_cm = case when p_metadata ? 'alto_paquete_cm'
        then nullif(p_metadata ->> 'alto_paquete_cm', '')::numeric
        else variants.alto_paquete_cm end,
      ancho_paquete_cm = case when p_metadata ? 'ancho_paquete_cm'
        then nullif(p_metadata ->> 'ancho_paquete_cm', '')::numeric
        else variants.ancho_paquete_cm end,
      largo_paquete_cm = case when p_metadata ? 'largo_paquete_cm'
        then nullif(p_metadata ->> 'largo_paquete_cm', '')::numeric
        else variants.largo_paquete_cm end
  where variants.id = p_variant_id
    and variants.producto_id = p_product_id
  returning * into v_variant;

  if not found then
    raise exception 'La variante ya no existe.';
  end if;
  perform public.sync_product_primary_variant_image(p_product_id);
  return v_variant;
end;
$$;

revoke all on function public.update_product_variant_metadata_atomic(bigint, bigint, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.update_product_variant_metadata_atomic(bigint, bigint, jsonb, uuid)
  to service_role;

create or replace function public.reorder_product_variants_atomic(
  p_product_id bigint,
  p_variant_ids jsonb,
  p_actor_id uuid
)
returns setof public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested_count integer;
  v_catalog_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para reordenar variantes.';
  end if;
  if jsonb_typeof(coalesce(p_variant_ids, 'null'::jsonb)) <> 'array' then
    raise exception 'El orden de variantes no es válido.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select count(*) into v_catalog_count
  from public.producto_variantes variants
  where variants.producto_id = p_product_id;
  select count(*) into v_requested_count
  from jsonb_array_elements_text(p_variant_ids);

  if v_requested_count <> v_catalog_count
     or (
       select count(distinct value::bigint)
       from jsonb_array_elements_text(p_variant_ids)
     ) <> v_requested_count
     or exists (
       select 1
       from jsonb_array_elements_text(p_variant_ids) requested(value)
       left join public.producto_variantes variants
         on variants.id = requested.value::bigint
        and variants.producto_id = p_product_id
       where variants.id is null
     ) then
    raise exception 'El orden debe incluir exactamente todas las variantes del producto.';
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  update public.producto_variantes variants
  set orden = requested.position::integer
  from jsonb_array_elements_text(p_variant_ids)
    with ordinality as requested(value, position)
  where variants.id = requested.value::bigint
    and variants.producto_id = p_product_id;

  perform public.sync_product_primary_variant_image(p_product_id);
  return query
  select variants.*
  from public.producto_variantes variants
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id;
end;
$$;

revoke all on function public.reorder_product_variants_atomic(bigint, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.reorder_product_variants_atomic(bigint, jsonb, uuid)
  to service_role;

create or replace function public.guard_product_variant_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(93000, old.producto_id::integer);

  if coalesce(old.stock, 0) <> 0
     or exists (
       select 1
       from public.inventory_variant_allocations allocations
       where allocations.variant_id = old.id
         and allocations.quantity > 0
     ) then
    raise exception
      'No se puede eliminar la variante % porque tiene unidades vinculadas. Reasigná primero el stock.',
      old.nombre;
  end if;
  if exists (
    select 1
    from public.inventory_movements movements
    where movements.variant_id = old.id
  ) then
    raise exception
      'No se puede eliminar la variante % porque tiene movimientos históricos. Desactivala para conservar la trazabilidad.',
      old.nombre;
  end if;

  return old;
end;
$$;

create or replace function public.get_product_inventory_distribution(
  p_product_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_normal bigint;
  v_discounted bigint;
  v_non_sellable bigint;
  v_pending_review bigint;
  v_generic_balance bigint;
  v_allocated bigint;
  v_normal_reserved bigint;
  v_discounted_reserved bigint;
  v_variants jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para consultar el inventario.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select products.stock into v_normal
  from public.productos products
  where products.id = p_product_id;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;

  select coalesce(sum(movements.quantity_delta), 0)
  into v_generic_balance
  from public.inventory_movements movements
  where movements.product_id = p_product_id
    and movements.variant_id is null
    and movements.movement_date <= current_date;

  select coalesce(sum(allocations.quantity), 0)
  into v_allocated
  from public.inventory_variant_allocations allocations
  where allocations.product_id = p_product_id;

  select coalesce(sum(offers.available_quantity), 0)
  into v_discounted
  from public.conditioned_inventory_offers offers
  where offers.product_id = p_product_id;

  select
    coalesce(sum(returns.non_sellable_quantity), 0),
    coalesce(sum(greatest(
      returns.received_quantity
        - returns.sellable_quantity
        - returns.discounted_quantity
        - returns.non_sellable_quantity,
      0
    )), 0)
  into v_non_sellable, v_pending_review
  from public.inventory_return_movements returns
  where returns.product_id = p_product_id;

  select
    coalesce(sum(reservations.quantity) filter (
      where reservations.conditioned_stock_id is null
    ), 0),
    coalesce(sum(reservations.quantity) filter (
      where reservations.conditioned_stock_id is not null
    ), 0)
  into v_normal_reserved, v_discounted_reserved
  from public.stock_reservations reservations
  where reservations.product_id = p_product_id
    and reservations.expires_at > now();

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'variant_id', variants.id,
      'allocated_quantity', coalesce(allocations.quantity, 0),
      'reserved_quantity', coalesce(reserved.quantity, 0),
      'available_quantity', greatest(
        coalesce(variants.stock, 0) - coalesce(reserved.quantity, 0),
        0
      )
    ) order by variants.orden, variants.id
  ), '[]'::jsonb)
  into v_variants
  from public.producto_variantes variants
  left join public.inventory_variant_allocations allocations
    on allocations.variant_id = variants.id
  left join lateral (
    select coalesce(sum(reservations.quantity), 0) as quantity
    from public.stock_reservations reservations
    where reservations.product_id = p_product_id
      and reservations.variant_id = variants.id
      and reservations.conditioned_stock_id is null
      and reservations.expires_at > now()
  ) reserved on true
  where variants.producto_id = p_product_id;

  return jsonb_build_object(
    'totalStock', v_normal,
    'normalStock', v_normal,
    'discountedStock', v_discounted,
    'nonSellableStock', v_non_sellable,
    'pendingReviewStock', v_pending_review,
    'sellableStock', v_normal + v_discounted,
    'quarantineStock', v_pending_review,
    'physicalStock', v_normal + v_discounted + v_non_sellable + v_pending_review,
    'reservedStock', v_normal_reserved + v_discounted_reserved,
    'availableStock',
      greatest(v_normal - v_normal_reserved, 0)
        + greatest(v_discounted - v_discounted_reserved, 0),
    'genericBalance', v_generic_balance,
    'assignableQuantity', greatest(v_generic_balance, 0),
    'allocatedQuantity', v_allocated,
    'unassignedQuantity', greatest(greatest(v_generic_balance, 0) - v_allocated, 0),
    'allocationOverflow', greatest(v_allocated - greatest(v_generic_balance, 0), 0),
    'variants', v_variants
  );
end;
$$;

revoke all on function public.get_product_inventory_distribution(bigint)
  from public, anon, authenticated;
grant execute on function public.get_product_inventory_distribution(bigint)
  to service_role;

create or replace function public.set_product_variant_allocations(
  p_product_id bigint,
  p_allocations jsonb,
  p_actor_id uuid default null
)
returns table (
  variant_id bigint,
  allocated_quantity integer,
  available_quantity integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignable_quantity bigint;
  v_current_quantity bigint;
  v_requested_quantity bigint;
  v_requested_increase bigint;
  v_unassigned_quantity bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para distribuir inventario.';
  end if;
  if p_product_id is null
     or jsonb_typeof(coalesce(p_allocations, '[]'::jsonb)) <> 'array' then
    raise exception 'La distribución indicada no es válida.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  if not exists (select 1 from public.productos where id = p_product_id) then
    raise exception 'El producto ya no existe.';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
      as requested(variant_id bigint, quantity integer)
    where requested.variant_id is null
       or requested.quantity is null
       or requested.quantity < 0
  ) then
    raise exception 'Las cantidades deben ser números enteros iguales o mayores que cero.';
  end if;
  if (
    select count(*)
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
      as requested(variant_id bigint, quantity integer)
  ) <> (
    select count(distinct requested.variant_id)
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
      as requested(variant_id bigint, quantity integer)
  ) then
    raise exception 'Hay variantes repetidas en la distribución.';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
      as requested(variant_id bigint, quantity integer)
    left join public.producto_variantes variants
      on variants.id = requested.variant_id
     and variants.producto_id = p_product_id
    where variants.id is null
  ) then
    raise exception 'Una de las variantes no pertenece al producto.';
  end if;

  select coalesce(sum(movements.quantity_delta), 0)
  into v_assignable_quantity
  from public.inventory_movements movements
  where movements.product_id = p_product_id
    and movements.variant_id is null
    and movements.movement_date <= current_date;

  select coalesce(sum(allocations.quantity), 0)
  into v_current_quantity
  from public.inventory_variant_allocations allocations
  where allocations.product_id = p_product_id;

  select coalesce(sum(requested.quantity), 0)
  into v_requested_quantity
  from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
    as requested(variant_id bigint, quantity integer);

  if v_requested_quantity > greatest(v_assignable_quantity, 0) then
    v_requested_increase := greatest(v_requested_quantity - v_current_quantity, 0);
    v_unassigned_quantity := greatest(
      greatest(v_assignable_quantity, 0) - v_current_quantity,
      0
    );
    raise exception
      'No podés asignar % unidades nuevas. Solo quedan % unidades sin asignar.',
      v_requested_increase,
      v_unassigned_quantity;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
      as requested(variant_id bigint, quantity integer)
    left join lateral (
      select coalesce(sum(movements.quantity_delta), 0) as physical_quantity
      from public.inventory_movements movements
      where movements.product_id = p_product_id
        and movements.variant_id = requested.variant_id
        and movements.movement_date <= current_date
    ) physical on true
    where physical.physical_quantity + requested.quantity < 0
  ) then
    raise exception 'No podés asignar menos unidades que las ya vendidas en una variante.';
  end if;

  delete from public.inventory_variant_allocations allocations
  where allocations.product_id = p_product_id;
  insert into public.inventory_variant_allocations (
    product_id, variant_id, quantity, updated_by, updated_at
  )
  select
    p_product_id,
    requested.variant_id,
    requested.quantity,
    p_actor_id,
    now()
  from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
    as requested(variant_id bigint, quantity integer)
  where requested.quantity > 0;

  perform public.refresh_inventory_stock(p_product_id);
  return query
  select
    variants.id,
    coalesce(allocations.quantity, 0),
    coalesce(variants.stock, 0)
  from public.producto_variantes variants
  left join public.inventory_variant_allocations allocations
    on allocations.variant_id = variants.id
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id;
end;
$$;

revoke all on function public.set_product_variant_allocations(bigint, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.set_product_variant_allocations(bigint, jsonb, uuid)
  to service_role;

drop trigger if exists guard_product_variant_delete
  on public.producto_variantes;
create trigger guard_product_variant_delete
before delete on public.producto_variantes
for each row execute function public.guard_product_variant_delete();

create or replace function public.sync_product_after_variant_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_product_primary_variant_image(old.producto_id);
  return old;
end;
$$;

drop trigger if exists sync_product_after_variant_delete
  on public.producto_variantes;
create trigger sync_product_after_variant_delete
after delete on public.producto_variantes
for each row execute function public.sync_product_after_variant_delete();

-- Mantiene imagen principal y datos logísticos dentro de la misma transacción
-- que crea o redistribuye la variante.
create or replace function public.create_product_variant_with_allocation_v2(
  p_product_id bigint, p_name text, p_sku text, p_color_hex text,
  p_images jsonb, p_quantity integer, p_actor_id uuid,
  p_peso_empaquetado_kg numeric, p_alto_paquete_cm numeric,
  p_ancho_paquete_cm numeric, p_largo_paquete_cm numeric
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
begin
  v_variant := public.create_product_variant_with_allocation(
    p_product_id, p_name, p_sku, p_color_hex, p_images, p_quantity, p_actor_id
  );
  update public.producto_variantes
  set peso_empaquetado_kg = p_peso_empaquetado_kg,
      alto_paquete_cm = p_alto_paquete_cm,
      ancho_paquete_cm = p_ancho_paquete_cm,
      largo_paquete_cm = p_largo_paquete_cm
  where id = v_variant.id
  returning * into v_variant;
  perform public.sync_product_primary_variant_image(p_product_id);
  return v_variant;
end;
$$;

create or replace function public.update_product_variant_with_allocation_v2(
  p_product_id bigint, p_variant_id bigint, p_name text, p_sku text,
  p_color_hex text, p_images jsonb, p_quantity integer, p_actor_id uuid,
  p_peso_empaquetado_kg numeric, p_alto_paquete_cm numeric,
  p_ancho_paquete_cm numeric, p_largo_paquete_cm numeric
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
begin
  v_variant := public.update_product_variant_with_allocation(
    p_product_id, p_variant_id, p_name, p_sku, p_color_hex,
    p_images, p_quantity, p_actor_id
  );
  update public.producto_variantes
  set peso_empaquetado_kg = p_peso_empaquetado_kg,
      alto_paquete_cm = p_alto_paquete_cm,
      ancho_paquete_cm = p_ancho_paquete_cm,
      largo_paquete_cm = p_largo_paquete_cm
  where id = v_variant.id
  returning * into v_variant;
  perform public.sync_product_primary_variant_image(p_product_id);
  return v_variant;
end;
$$;

comment on function public.update_product_catalog_atomic(bigint, jsonb, text, uuid) is
  'Guarda producto y SKU principal en una única transacción, sin modificar stock.';
comment on function public.set_product_commercial_state_atomic(bigint, boolean, uuid) is
  'Cambia el estado del padre sin sobrescribir la configuración de sus variantes.';
comment on function public.guard_product_variant_delete() is
  'Impide eliminar variantes con stock o trazabilidad asociada.';
