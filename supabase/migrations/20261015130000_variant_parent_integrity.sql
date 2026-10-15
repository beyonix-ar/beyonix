-- Reconstruida el 2026-10-15 desde supabase_migrations.schema_migrations.statements:
-- ya estaba aplicada en el proyecto remoto sin su archivo en el repo.

-- Integridad entre variantes y producto padre (incidente LEGATUS, 15/10/2026).
--
-- 1. productos.catalog_revision: contador que sube cada vez que cambia la
--    ficha comercial. El editor guarda contra la revisión que cargó; si otra
--    pestaña, otro usuario, una fusión o un evento comercial la cambió, el
--    guardado se rechaza en vez de pisar esos datos (lost update).
-- 2. merge_catalog_products: el producto absorbido ya no se borra con su
--    ficha. Lo vacío del producto que se conserva se completa con los datos
--    del absorbido (descripción, precio, categoría, logística, video,
--    destacado, especificaciones, imágenes y método de precio) y el snapshot
--    completo del absorbido queda en audit_logs.
-- 3. delete_or_archive_product_variant: una variante con historial (stock,
--    compras, ventas, movimientos, reservas, despachos, códigos) nunca se
--    borra: se archiva (inactiva). Sólo una variante sin ninguna actividad se
--    elimina físicamente.
-- 4. create_product_variant_for_purchase: alta de la variante + su código de
--    barras en UNA transacción (bloque interno de la operación 5).
-- 5. create_variant_and_purchase: una variante física nueva nace SÓLO junto
--    con su compra. Producto (si es nuevo), variante, SKU, código, compra,
--    costo, stock y movimiento de inventario en una sola transacción e
--    idempotente por clave: o queda todo, o no queda nada.
-- 6. update_product_catalog_atomic: el guardado de la ficha ya no borra el
--    bloqueo de una promoción activa (promo_event_id / promo_original_*):
--    si el editor no manda esas claves, se conservan.

-- 1. Revisión de la ficha comercial -----------------------------------------

alter table public.productos
  add column if not exists catalog_revision bigint not null default 0;

create or replace function public.bump_product_catalog_revision()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (
    new.nombre, new.sku, new.slug, new.descripcion, new.video_url,
    new.precio, new.precio_anterior, new.descuento, new.categoria_id,
    new.destacado, new.activo, new.peso_empaquetado_kg, new.alto_paquete_cm,
    new.ancho_paquete_cm, new.largo_paquete_cm, new.promo_event_id,
    new.promo_original_precio, new.promo_original_precio_anterior,
    new.promo_original_descuento
  ) is distinct from (
    old.nombre, old.sku, old.slug, old.descripcion, old.video_url,
    old.precio, old.precio_anterior, old.descuento, old.categoria_id,
    old.destacado, old.activo, old.peso_empaquetado_kg, old.alto_paquete_cm,
    old.ancho_paquete_cm, old.largo_paquete_cm, old.promo_event_id,
    old.promo_original_precio, old.promo_original_precio_anterior,
    old.promo_original_descuento
  ) then
    new.catalog_revision := old.catalog_revision + 1;
  else
    -- Stock, imagen principal derivada y demás campos internos no cuentan, y
    -- la revisión nunca se escribe a mano.
    new.catalog_revision := old.catalog_revision;
  end if;
  return new;
end;
$$;

drop trigger if exists bump_product_catalog_revision on public.productos;

create trigger bump_product_catalog_revision
before update on public.productos
for each row execute function public.bump_product_catalog_revision();

create or replace function public.update_product_commercial_configuration_checked(
  p_product_id bigint,
  p_catalog jsonb,
  p_primary_sku text,
  p_variant_states jsonb,
  p_actor_id uuid,
  p_pricing_mode text,
  p_target_margin_percent numeric,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_revision bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para actualizar la configuración comercial.';
  end if;
  if p_product_id is null then
    raise exception 'El producto indicado no es válido.';
  end if;

  -- Mismo bloqueo por producto que Compras, Inventario y el guardado
  -- comercial: la comparación y la escritura son una sola operación.
  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select products.catalog_revision
  into v_revision
  from public.productos products
  where products.id = p_product_id
  for update;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;
  if p_expected_revision is not null and v_revision <> p_expected_revision then
    raise exception 'El producto cambió desde que abriste el editor (otra pestaña, otro usuario o un evento comercial). Recargalo antes de guardar para no pisar esos cambios.'
      using errcode = '40001';
  end if;

  return public.update_product_commercial_configuration_with_pricing_atomic(
    p_product_id,
    p_catalog,
    p_primary_sku,
    p_variant_states,
    p_actor_id,
    p_pricing_mode,
    p_target_margin_percent
  );
end;
$$;

revoke all on function public.update_product_commercial_configuration_checked(
  bigint, jsonb, text, jsonb, uuid, text, numeric, bigint
) from public, anon, authenticated;

grant execute on function public.update_product_commercial_configuration_checked(
  bigint, jsonb, text, jsonb, uuid, text, numeric, bigint
) to service_role;

-- 2. Fusión que conserva la ficha comercial ---------------------------------

create or replace function public.merge_catalog_products(
  p_keep_product_id bigint,
  p_absorb_product_id bigint,
  p_actor_id uuid
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keep public.productos%rowtype;
  v_absorb public.productos%rowtype;
  v_absorbed_specifications jsonb;
  v_absorbed_images jsonb;
  v_absorbed_pricing jsonb;
  v_keep_has_logistics boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para fusionar productos.';
  end if;
  if p_keep_product_id is null or p_absorb_product_id is null then
    raise exception 'Los productos a fusionar no son válidos.';
  end if;
  if p_keep_product_id = p_absorb_product_id then
    raise exception 'No podés fusionar un producto consigo mismo.';
  end if;

  perform pg_advisory_xact_lock(
    93000, least(p_keep_product_id, p_absorb_product_id)::integer
  );
  perform pg_advisory_xact_lock(
    93000, greatest(p_keep_product_id, p_absorb_product_id)::integer
  );

  select * into v_keep
  from public.productos
  where id = p_keep_product_id
  for update;
  if not found then
    raise exception 'El producto que querés conservar ya no existe.';
  end if;

  select * into v_absorb
  from public.productos
  where id = p_absorb_product_id
  for update;
  if not found then
    raise exception 'El producto que querés fusionar ya no existe.';
  end if;

  -- Snapshot completo del absorbido ANTES de tocar nada: lo que no se
  -- traslada queda recuperable desde audit_logs.
  select coalesce(jsonb_agg(to_jsonb(specs) order by specs.orden, specs.id), '[]'::jsonb)
  into v_absorbed_specifications
  from public.producto_especificaciones specs
  where specs.producto_id = p_absorb_product_id;
  select coalesce(jsonb_agg(to_jsonb(images) order by images.orden, images.id), '[]'::jsonb)
  into v_absorbed_images
  from public.imagenes_producto images
  where images.producto_id = p_absorb_product_id;
  select to_jsonb(pricing)
  into v_absorbed_pricing
  from public.product_pricing pricing
  where pricing.product_id = p_absorb_product_id;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);

  alter table public.product_cost_entries disable trigger link_cost_entry_to_shared_catalog;
  alter table public.product_cost_entries disable trigger sync_cost_catalog_product_sku;
  alter table public.product_cost_entries disable trigger refresh_inventory_after_purchase;
  alter table public.business_expenses disable trigger refresh_inventory_after_expense;
  alter table public.external_sales disable trigger lock_inventory_external_sale;
  alter table public.external_sales disable trigger refresh_inventory_after_external_sale;
  alter table public.external_sales disable trigger zz_reject_negative_external_sale;
  alter table public.mercadolibre_sales disable trigger lock_inventory_mercadolibre_sale;
  alter table public.mercadolibre_sales disable trigger refresh_inventory_after_mercadolibre_sale;
  alter table public.mercadolibre_sales disable trigger zz_reject_negative_mercadolibre_sale;
  alter table public.inventory_return_movements disable trigger refresh_inventory_after_return_movement;
  alter table public.inventory_return_movements disable trigger validate_inventory_return_condition;
  alter table public.inventory_return_movements disable trigger guard_inventory_return_variant_link;

  -- Mueve las variantes primero: si el producto a conservar ya tiene una
  -- variante con el mismo nombre (color) o color_hex, el guard
  -- prevent_duplicate_product_variant_identity corta acá con un mensaje claro.
  update public.producto_variantes
  set producto_id = p_keep_product_id
  where producto_id = p_absorb_product_id;

  update public.product_cost_entries
  set product_id = p_keep_product_id
  where product_id = p_absorb_product_id;

  update public.business_expenses
  set product_id = p_keep_product_id
  where product_id = p_absorb_product_id;

  update public.external_sales
  set product_id = p_keep_product_id
  where product_id = p_absorb_product_id;

  update public.mercadolibre_sales
  set product_id = p_keep_product_id
  where product_id = p_absorb_product_id;

  update public.inventory_return_movements
  set product_id = p_keep_product_id
  where product_id = p_absorb_product_id;

  update public.inventory_variant_allocations
  set product_id = p_keep_product_id
  where product_id = p_absorb_product_id;

  update public.stock_reservations
  set product_id = p_keep_product_id
  where product_id = p_absorb_product_id;

  update public.orden_items
  set producto_id = p_keep_product_id
  where producto_id = p_absorb_product_id;

  alter table public.product_cost_entries enable trigger link_cost_entry_to_shared_catalog;
  alter table public.product_cost_entries enable trigger sync_cost_catalog_product_sku;
  alter table public.product_cost_entries enable trigger refresh_inventory_after_purchase;
  alter table public.business_expenses enable trigger refresh_inventory_after_expense;
  alter table public.external_sales enable trigger lock_inventory_external_sale;
  alter table public.external_sales enable trigger refresh_inventory_after_external_sale;
  alter table public.external_sales enable trigger zz_reject_negative_external_sale;
  alter table public.mercadolibre_sales enable trigger lock_inventory_mercadolibre_sale;
  alter table public.mercadolibre_sales enable trigger refresh_inventory_after_mercadolibre_sale;
  alter table public.mercadolibre_sales enable trigger zz_reject_negative_mercadolibre_sale;
  alter table public.inventory_return_movements enable trigger refresh_inventory_after_return_movement;
  alter table public.inventory_return_movements enable trigger guard_inventory_return_variant_link;
  alter table public.inventory_return_movements enable trigger validate_inventory_return_condition;

  alter table public.inventory_operation_log disable trigger prevent_inventory_operation_log_mutation;
  update public.inventory_operation_log
  set product_id = p_keep_product_id
  where product_id = p_absorb_product_id;
  alter table public.inventory_operation_log enable trigger prevent_inventory_operation_log_mutation;

  -- La ficha comercial nunca se pierde: lo vacío del producto que se conserva
  -- se completa con lo del absorbido; lo que ya tiene cargado no se toca.
  v_keep_has_logistics :=
    v_keep.peso_empaquetado_kg is not null
    or v_keep.alto_paquete_cm is not null
    or v_keep.ancho_paquete_cm is not null
    or v_keep.largo_paquete_cm is not null;

  update public.productos products
  set descripcion = coalesce(nullif(btrim(products.descripcion), ''), v_absorb.descripcion),
      video_url = coalesce(nullif(btrim(products.video_url), ''), v_absorb.video_url),
      precio = case
        when coalesce(products.precio, 0) <= 0 and coalesce(v_absorb.precio, 0) > 0
          then v_absorb.precio
        else products.precio
      end,
      precio_anterior = case
        when coalesce(products.precio, 0) <= 0 and coalesce(v_absorb.precio, 0) > 0
          then v_absorb.precio_anterior
        else products.precio_anterior
      end,
      descuento = case
        when coalesce(products.precio, 0) <= 0 and coalesce(v_absorb.precio, 0) > 0
          then v_absorb.descuento
        else products.descuento
      end,
      categoria_id = coalesce(products.categoria_id, v_absorb.categoria_id),
      destacado = products.destacado or coalesce(v_absorb.destacado, false),
      peso_empaquetado_kg = case when v_keep_has_logistics then products.peso_empaquetado_kg else v_absorb.peso_empaquetado_kg end,
      alto_paquete_cm = case when v_keep_has_logistics then products.alto_paquete_cm else v_absorb.alto_paquete_cm end,
      ancho_paquete_cm = case when v_keep_has_logistics then products.ancho_paquete_cm else v_absorb.ancho_paquete_cm end,
      largo_paquete_cm = case when v_keep_has_logistics then products.largo_paquete_cm else v_absorb.largo_paquete_cm end
  where products.id = p_keep_product_id;

  if not exists (
    select 1 from public.producto_especificaciones where producto_id = p_keep_product_id
  ) then
    update public.producto_especificaciones
    set producto_id = p_keep_product_id
    where producto_id = p_absorb_product_id;
  end if;

  if not exists (
    select 1 from public.imagenes_producto where producto_id = p_keep_product_id
  ) then
    update public.imagenes_producto
    set producto_id = p_keep_product_id
    where producto_id = p_absorb_product_id;
  end if;

  if not exists (
    select 1 from public.product_pricing where product_id = p_keep_product_id
  ) then
    update public.product_pricing
    set product_id = p_keep_product_id
    where product_id = p_absorb_product_id;
  end if;

  -- El SKU/código de barra a nivel producto solo tiene sentido cuando el
  -- producto no tiene variantes propias (ver 102_variant_only_skus.sql); si
  -- el que se conserva ahora tiene variantes, esos campos pasan a vivir
  -- únicamente en cada variante.
  if exists (
    select 1 from public.producto_variantes where producto_id = p_keep_product_id
  ) then
    update public.productos
    set sku = null,
        codigo_barra = null
    where id = p_keep_product_id;
  end if;

  perform public.refresh_inventory_stock(p_keep_product_id);
  perform public.sync_product_primary_variant_image(p_keep_product_id);

  delete from public.productos where id = p_absorb_product_id;

  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, before_data, after_data
  ) values (
    'productos',
    'UPDATE',
    p_keep_product_id::text,
    p_actor_id,
    jsonb_build_object(
      'absorbedProductId', p_absorb_product_id,
      'absorbedName', v_absorb.nombre,
      'absorbedProduct', to_jsonb(v_absorb),
      'absorbedSpecifications', v_absorbed_specifications,
      'absorbedImages', v_absorbed_images,
      'absorbedPricing', v_absorbed_pricing,
      'keptProductBefore', to_jsonb(v_keep)
    ),
    jsonb_build_object('reason', 'merge_catalog_products')
  );

  select * into v_keep from public.productos where id = p_keep_product_id;
  return v_keep;
end;
$$;

revoke all on function public.merge_catalog_products(bigint, bigint, uuid)
  from public, anon, authenticated;

grant execute on function public.merge_catalog_products(bigint, bigint, uuid)
  to service_role;

comment on function public.merge_catalog_products(bigint, bigint, uuid) is
  'Fusiona dos productos: mueve variantes e historial comercial del absorbido al conservado, completa lo vacío de la ficha del conservado con la del absorbido (nunca pisa lo cargado) y elimina el absorbido dejando su snapshot completo en audit_logs.';

-- 3. Borrar o archivar una variante -----------------------------------------

-- Motivos por los que una variante tiene trazabilidad y no puede borrarse.
-- Recorre todas las FK que apuntan a producto_variantes (salvo los índices de
-- identidad, que se recalculan solos) y las referencias sin FK conocidas.
create or replace function public.product_variant_history_reasons(
  p_variant_id bigint
)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_reasons text[] := array[]::text[];
  v_reference record;
  v_found boolean;
begin
  select * into v_variant
  from public.producto_variantes
  where id = p_variant_id;
  if not found then
    return v_reasons;
  end if;

  if coalesce(v_variant.stock, 0) <> 0 then
    v_reasons := array_append(v_reasons, 'tiene stock');
  end if;
  if nullif(btrim(coalesce(v_variant.codigo_barra, '')), '') is not null then
    v_reasons := array_append(v_reasons, 'tiene código de barras vinculado');
  end if;

  for v_reference in
    select
      referencing.relname::text as table_name,
      attribute.attname::text as column_name
    from pg_constraint constraints
    join pg_class referencing on referencing.oid = constraints.conrelid
    join pg_namespace namespace on namespace.oid = referencing.relnamespace
    join pg_attribute attribute
      on attribute.attrelid = constraints.conrelid
     and attribute.attnum = constraints.conkey[1]
    where constraints.contype = 'f'
      and constraints.confrelid = 'public.producto_variantes'::regclass
      and namespace.nspname = 'public'
      and array_length(constraints.conkey, 1) = 1
      and referencing.relname not in ('catalog_sku_registry', 'catalog_barcode_registry')
    union
    select known.table_name, known.column_name
    from (values
      ('orden_items', 'variante_id'),
      ('orden_items', 'reserved_variant_id'),
      ('product_cost_entries', 'variant_id')
    ) as known(table_name, column_name)
    where exists (
      select 1
      from information_schema.columns columns
      where columns.table_schema = 'public'
        and columns.table_name = known.table_name
        and columns.column_name = known.column_name
    )
  loop
    execute format(
      'select exists (select 1 from public.%I where %I = $1)',
      v_reference.table_name,
      v_reference.column_name
    )
    into v_found
    using p_variant_id;
    if v_found then
      v_reasons := array_append(v_reasons, (
        case v_reference.table_name
          when 'product_cost_entries' then 'tiene compras registradas'
          when 'orden_items' then 'tiene ventas web'
          when 'external_sales' then 'tiene ventas externas'
          when 'inventory_operation_log' then 'tiene movimientos de inventario'
          when 'inventory_stock_adjustments' then 'tiene ajustes de stock'
          when 'inventory_return_movements' then 'tiene devoluciones'
          when 'inventory_variant_allocations' then 'tiene stock asignado'
          when 'stock_reservations' then 'tiene reservas de stock'
          when 'order_replacements' then 'tiene reemplazos de pedidos'
          when 'order_preparation_lines' then 'tiene despachos'
          when 'order_preparation_scans' then 'tiene escaneos de despacho'
          when 'catalog_barcode_aliases' then 'tiene códigos equivalentes'
          else format('tiene registros en %s', v_reference.table_name)
        end
      ));
    end if;
  end loop;

  return (
    select coalesce(array_agg(distinct reason order by reason), array[]::text[])
    from unnest(v_reasons) as reason
  );
end;
$$;

revoke all on function public.product_variant_history_reasons(bigint)
  from public, anon, authenticated;

grant execute on function public.product_variant_history_reasons(bigint)
  to service_role;

create or replace function public.delete_or_archive_product_variant(
  p_product_id bigint,
  p_variant_id bigint,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_reasons text[];
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para eliminar variantes.';
  end if;
  if p_product_id is null or p_variant_id is null then
    raise exception 'La variante indicada no es válida.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select * into v_variant
  from public.producto_variantes
  where id = p_variant_id
    and producto_id = p_product_id
  for update;
  if not found then
    raise exception 'La variante ya no existe.';
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  v_reasons := public.product_variant_history_reasons(p_variant_id);

  if cardinality(v_reasons) > 0 then
    -- Con trazabilidad: nunca se destruye. Se archiva (inactiva) respetando
    -- las mismas reglas que el interruptor de estado de la variante.
    if v_variant.activo then
      perform public.set_product_variant_state_atomic(
        p_product_id, p_variant_id, false, p_actor_id
      );
    end if;
    insert into public.audit_logs (
      table_name, action, record_id, actor_user_id, before_data, after_data
    ) values (
      'producto_variantes', 'UPDATE', p_variant_id::text, p_actor_id,
      jsonb_build_object('nombre', v_variant.nombre, 'producto_id', p_product_id, 'activo', v_variant.activo),
      jsonb_build_object('reason', 'archive_variant_with_history', 'historyReasons', to_jsonb(v_reasons))
    );
    return jsonb_build_object(
      'mode', 'archived',
      'reasons', to_jsonb(v_reasons),
      'variant', (select to_jsonb(variants) from public.producto_variantes variants where variants.id = p_variant_id)
    );
  end if;

  delete from public.producto_variantes
  where id = p_variant_id
    and producto_id = p_product_id;
  return jsonb_build_object('mode', 'deleted', 'reasons', '[]'::jsonb, 'variant', to_jsonb(v_variant));
end;
$$;

revoke all on function public.delete_or_archive_product_variant(bigint, bigint, uuid)
  from public, anon, authenticated;

grant execute on function public.delete_or_archive_product_variant(bigint, bigint, uuid)
  to service_role;

-- 4. Alta de variante desde Compras, atómica con su código -------------------

create or replace function public.create_product_variant_for_purchase(
  p_product_id bigint,
  p_name text,
  p_sku text,
  p_color_hex text,
  p_barcode text,
  p_generate_barcode boolean,
  p_actor_id uuid
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_barcode text := nullif(btrim(coalesce(p_barcode, '')), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para crear variantes.';
  end if;
  if v_barcode is not null and coalesce(p_generate_barcode, false) then
    raise exception 'Elegí escanear un código o generar uno BEYONIX, no ambos.';
  end if;

  v_variant := public.create_product_variant_with_allocation_v2(
    p_product_id, p_name, p_sku, p_color_hex, '[]'::jsonb, 0, p_actor_id,
    null, null, null, null
  );

  -- Mismo statement que la escritura del código desde Compras: los triggers
  -- de identidad validan el código y, si falla, se revierte también el alta.
  if v_barcode is not null then
    update public.producto_variantes
    set codigo_barra = v_barcode
    where id = v_variant.id
    returning * into v_variant;
  elsif coalesce(p_generate_barcode, false) then
    v_variant := public.generate_beyonix_variant_barcode(
      p_product_id, v_variant.id, p_actor_id
    );
  end if;

  return v_variant;
end;
$$;

revoke all on function public.create_product_variant_for_purchase(
  bigint, text, text, text, text, boolean, uuid
) from public, anon, authenticated;

grant execute on function public.create_product_variant_for_purchase(
  bigint, text, text, text, text, boolean, uuid
) to service_role;

-- 5. Variante nueva + compra: una sola operación ------------------------------

create or replace function public.create_variant_and_purchase(
  p_product_id bigint,
  p_product_name text,
  p_variant jsonb,
  p_purchase jsonb,
  p_actor_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_existing public.product_cost_entries%rowtype;
  v_product_id bigint := p_product_id;
  v_name text := nullif(btrim(coalesce(p_variant ->> 'name', '')), '');
  v_sku text := nullif(left(btrim(coalesce(p_variant ->> 'sku', '')), 120), '');
  v_color text := upper(nullif(btrim(coalesce(p_variant ->> 'color_hex', '')), ''));
  v_barcode text := nullif(btrim(coalesce(p_variant ->> 'barcode', '')), '');
  v_generate boolean := coalesce((p_variant ->> 'generate_barcode')::boolean, false);
  v_status text := coalesce(nullif(p_purchase ->> 'reception_status', ''), 'recibida');
  v_quantity integer := nullif(p_purchase ->> 'quantity', '')::integer;
  v_unit_cost numeric := nullif(p_purchase ->> 'unit_cost', '')::numeric;
  v_variant public.producto_variantes%rowtype;
  v_purchase public.product_cost_entries%rowtype;
  v_stock integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para registrar compras.';
  end if;
  if v_key is null or length(v_key) < 8 or length(v_key) > 240 then
    raise exception 'IDEMPOTENCY_KEY_INVALID';
  end if;

  -- Mismo bloqueo por clave que save_product_purchase_idempotent: un doble
  -- click, un timeout con reintento o una respuesta perdida esperan acá y
  -- reciben la misma operación ya confirmada, nunca una segunda.
  perform pg_advisory_xact_lock(hashtext('inventory-purchase'), hashtext(v_key));
  select * into v_existing
  from public.product_cost_entries entries
  where entries.idempotency_key = v_key;
  if found then
    -- Sólo es un reintento si esa clave creó una variante con su compra; una
    -- compra común con la misma clave no se hace pasar por esta operación.
    if v_existing.variant_id is null or not exists (
      select 1 from public.audit_logs logs
      where logs.after_data ->> 'reason' = 'create_variant_and_purchase'
        and logs.after_data ->> 'idempotencyKey' = v_key
    ) then
      raise exception 'Esa clave de operación ya se usó para otra compra.';
    end if;
    return jsonb_build_object(
      'replayed', true,
      'productId', v_existing.product_id,
      'variantId', v_existing.variant_id,
      'purchase', to_jsonb(v_existing),
      'variant', (select to_jsonb(variants) from public.producto_variantes variants where variants.id = v_existing.variant_id)
    );
  end if;

  -- Validaciones antes de escribir nada.
  if p_variant is null or jsonb_typeof(p_variant) <> 'object'
     or p_purchase is null or jsonb_typeof(p_purchase) <> 'object' then
    raise exception 'Los datos de la variante o de la compra no son válidos.';
  end if;
  if v_name is null then
    raise exception 'La variante nueva necesita un nombre de color.';
  end if;
  if v_color is null or v_color !~ '^#[0-9A-F]{6}$' then
    raise exception 'El color de la variante no es válido.';
  end if;
  if v_sku is null then
    raise exception 'La variante nueva necesita un SKU.';
  end if;
  if exists (
    select 1 from public.catalog_sku_registry registry
    where registry.normalized_sku = public.normalized_catalog_sku(v_sku)
  ) then
    raise exception 'El SKU % ya pertenece a otro artículo del catálogo.', v_sku;
  end if;
  if v_barcode is not null and v_generate then
    raise exception 'Elegí escanear un código o generar uno BEYONIX, no ambos.';
  end if;
  if v_quantity is null or v_quantity <= 0 then
    raise exception 'La cantidad comprada debe ser mayor que cero.';
  end if;
  if v_unit_cost is null or v_unit_cost <= 0 then
    raise exception 'Una variante nueva necesita el costo unitario de su compra.';
  end if;
  if v_status = 'anulada' then
    raise exception 'Una variante nueva no puede nacer de una compra anulada.';
  end if;

  -- Producto: existente (validado) o nuevo artículo de Compras.
  if v_product_id is not null then
    perform pg_advisory_xact_lock(93000, v_product_id::integer);
    if not exists (select 1 from public.productos where id = v_product_id) then
      raise exception 'El producto ya no existe.';
    end if;
  else
    if nullif(btrim(coalesce(p_product_name, '')), '') is null then
      raise exception 'El artículo nuevo debe tener un nombre.';
    end if;
    v_product_id := public.ensure_cost_catalog_product(p_product_name, v_sku);
    perform pg_advisory_xact_lock(93000, v_product_id::integer);
  end if;

  -- Variante + código (identidad y unicidad validadas por sus triggers).
  v_variant := public.create_product_variant_for_purchase(
    v_product_id, v_name, v_sku, v_color, v_barcode, v_generate, p_actor_id
  );

  -- Compra, costo, stock y movimiento con la misma clave de operación.
  v_purchase := public.save_product_purchase_idempotent(
    (p_purchase - 'id' - 'article_name')
      || jsonb_build_object(
        'product_id', v_product_id,
        'variant_id', v_variant.id,
        'sku', v_sku,
        'quantity', v_quantity,
        'unit_cost', v_unit_cost,
        'reception_status', v_status
      ),
    p_actor_id,
    v_key
  );

  -- Trazabilidad completa o nada.
  if v_purchase.id is null
     or v_purchase.variant_id is distinct from v_variant.id
     or v_purchase.product_id is distinct from v_product_id then
    raise exception 'La compra no quedó vinculada a la variante nueva.';
  end if;
  select variants.stock into v_stock
  from public.producto_variantes variants
  where variants.id = v_variant.id;
  if coalesce(v_stock, 0) <> v_purchase.received_quantity then
    raise exception 'El stock de la variante nueva (%) no coincide con lo recibido en la compra (%).',
      coalesce(v_stock, 0), v_purchase.received_quantity;
  end if;
  if v_purchase.received_quantity > 0 and not exists (
    select 1 from public.inventory_operation_log operations
    where operations.idempotency_key = v_key
      and operations.variant_id = v_variant.id
      and operations.movement_type = 'purchase'
      and operations.quantity = v_purchase.received_quantity
  ) then
    raise exception 'El movimiento de inventario de la compra no quedó registrado.';
  end if;

  -- Trazabilidad: la variante nació de esta compra.
  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, before_data, after_data
  ) values (
    'producto_variantes',
    'INSERT',
    v_variant.id::text,
    p_actor_id,
    null,
    jsonb_build_object(
      'reason', 'create_variant_and_purchase',
      'idempotencyKey', v_key,
      'productId', v_product_id,
      'purchaseId', v_purchase.id,
      'sku', v_sku,
      'receivedQuantity', v_purchase.received_quantity,
      'unitCost', v_purchase.unit_cost
    )
  );

  return jsonb_build_object(
    'replayed', false,
    'productId', v_product_id,
    'variantId', v_variant.id,
    'purchase', to_jsonb(v_purchase),
    'variant', (select to_jsonb(variants) from public.producto_variantes variants where variants.id = v_variant.id)
  );
end;
$$;

revoke all on function public.create_variant_and_purchase(
  bigint, text, jsonb, jsonb, uuid, text
) from public, anon, authenticated;

grant execute on function public.create_variant_and_purchase(
  bigint, text, jsonb, jsonb, uuid, text
) to service_role;

-- 6. Guardado de ficha sin borrar promociones activas --------------------------

-- Misma función que 20260929100000_product_installments_without_surcharge.sql
-- salvo las columnas promo_*: antes una clave ausente se guardaba como null y
-- el editor borraba el bloqueo y el precio original de un evento en curso.
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
  v_category_id bigint := nullif(p_catalog ->> 'categoria_id', '')::bigint;
  v_legacy_cuotas_sin_interes boolean := coalesce((p_catalog ->> 'cuotas_sin_interes')::boolean, false);
  v_legacy_cuotas_maximas text := p_catalog ->> 'cuotas_maximas';
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para actualizar el catálogo.';
  end if;
  if p_product_id is null
     or jsonb_typeof(coalesce(p_catalog, 'null'::jsonb)) <> 'object'
     or v_slug is null then
    raise exception 'Los datos comerciales del producto no son válidos.';
  end if;
  if v_active and v_name is null then
    raise exception 'Falta completar el título.';
  end if;
  if v_name is null then
    raise exception 'Los datos comerciales del producto no son válidos.';
  end if;
  if v_active and coalesce(v_price, 0) <= 0 then
    raise exception 'El precio debe ser mayor a $0.';
  end if;
  if v_price is null or v_price < 0 then
    raise exception 'Los datos comerciales del producto no son válidos.';
  end if;
  if v_active and (
    v_category_id is null
    or not exists (
      select 1 from public.categorias categories
      where categories.id = v_category_id
    )
  ) then
    raise exception 'Seleccioná una categoría.';
  end if;
  if v_active and (
    coalesce(nullif(p_catalog ->> 'peso_empaquetado_kg', '')::numeric, 0) <= 0
    or coalesce(nullif(p_catalog ->> 'alto_paquete_cm', '')::numeric, 0) <= 0
    or coalesce(nullif(p_catalog ->> 'ancho_paquete_cm', '')::numeric, 0) <= 0
    or coalesce(nullif(p_catalog ->> 'largo_paquete_cm', '')::numeric, 0) <= 0
  ) then
    raise exception 'Completá peso, profundidad, ancho y largo.';
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
      cuotas_2_habilitadas = coalesce(
        (p_catalog ->> 'cuotas_2_habilitadas')::boolean,
        false
      ),
      cuotas_3_habilitadas = coalesce(
        (p_catalog ->> 'cuotas_3_habilitadas')::boolean,
        v_legacy_cuotas_sin_interes and v_legacy_cuotas_maximas = '3'
      ),
      cuotas_6_habilitadas = coalesce(
        (p_catalog ->> 'cuotas_6_habilitadas')::boolean,
        v_legacy_cuotas_sin_interes and v_legacy_cuotas_maximas = '6'
      ),
      cuotas_sin_recargo = coalesce(
        nullif(p_catalog ->> 'cuotas_sin_recargo', '')::boolean,
        products.cuotas_sin_recargo
      ),
      -- El bloqueo de una promoción activa (eventos masivos) lo administra
      -- el evento: si el editor no manda estas claves, se conservan.
      promo_event_id = case when p_catalog ? 'promo_event_id'
        then nullif(p_catalog ->> 'promo_event_id', '')::uuid
        else products.promo_event_id end,
      promo_original_precio = case when p_catalog ? 'promo_original_precio'
        then nullif(p_catalog ->> 'promo_original_precio', '')::numeric
        else products.promo_original_precio end,
      promo_original_precio_anterior = case when p_catalog ? 'promo_original_precio_anterior'
        then nullif(p_catalog ->> 'promo_original_precio_anterior', '')::numeric
        else products.promo_original_precio_anterior end,
      promo_original_descuento = case when p_catalog ? 'promo_original_descuento'
        then nullif(p_catalog ->> 'promo_original_descuento', '')::numeric
        else products.promo_original_descuento end,
      promo_original_cuotas_2_habilitadas = case when p_catalog ? 'promo_original_cuotas_2_habilitadas'
        then nullif(p_catalog ->> 'promo_original_cuotas_2_habilitadas', '')::boolean
        else products.promo_original_cuotas_2_habilitadas end,
      promo_original_cuotas_3_habilitadas = case when p_catalog ? 'promo_original_cuotas_3_habilitadas'
        then nullif(p_catalog ->> 'promo_original_cuotas_3_habilitadas', '')::boolean
        else products.promo_original_cuotas_3_habilitadas end,
      promo_original_cuotas_6_habilitadas = case when p_catalog ? 'promo_original_cuotas_6_habilitadas'
        then nullif(p_catalog ->> 'promo_original_cuotas_6_habilitadas', '')::boolean
        else products.promo_original_cuotas_6_habilitadas end,
      categoria_id = v_category_id,
      destacado = coalesce((p_catalog ->> 'destacado')::boolean, false),
      activo = v_active,
      peso_empaquetado_kg = nullif(p_catalog ->> 'peso_empaquetado_kg', '')::numeric,
      alto_paquete_cm = nullif(p_catalog ->> 'alto_paquete_cm', '')::numeric,
      ancho_paquete_cm = nullif(p_catalog ->> 'ancho_paquete_cm', '')::numeric,
      largo_paquete_cm = nullif(p_catalog ->> 'largo_paquete_cm', '')::numeric
  where products.id = p_product_id
  returning * into v_product;

  if v_active then
    perform public.assert_product_can_activate(p_product_id);
  end if;

  return v_product;
end;
$$;

revoke all on function public.update_product_catalog_atomic(bigint, jsonb, text, uuid)
  from public, anon, authenticated;

grant execute on function public.update_product_catalog_atomic(bigint, jsonb, text, uuid)
  to service_role;
