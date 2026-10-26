-- Analítica: histórico de vistas que sobrevive a borrados, renombres y fusiones.
--
-- 1. analytics_events.product_id pasa a ser una referencia LÓGICA (sin FK):
--    borrar un producto ya no borra (ni anula) sus eventos. Los ids de
--    productos son identity y nunca se reutilizan, así que la referencia
--    sigue siendo inequívoca aunque el producto ya no exista.
-- 2. analytics_product_snapshots: UNA fila por producto con su último
--    nombre/slug/imagen conocidos (no una copia por evento). Se actualiza al
--    registrar una vista (sólo si cambió) y justo antes de borrar el producto,
--    así el ranking histórico sigue siendo entendible.
-- 3. admin_product_view_stats: datos actuales si el producto existe; si no,
--    el snapshot. Informa si hoy tiene PDP pública (activo) para no enlazar
--    productos archivados o eliminados. Las vistas siempre cuentan.
-- 4. merge_catalog_products: las vistas del absorbido pasan al conservado en
--    la misma transacción de la fusión (antes, el borrado del absorbido las
--    eliminaba por cascada).
--
-- Retención (política futura, no implementada): ver la nota al final.

begin;

-- 1. Referencia lógica --------------------------------------------------------

alter table public.analytics_events
  drop constraint if exists analytics_events_product_id_fkey;

comment on column public.analytics_events.product_id is
  'Referencia lógica a productos.id (sin FK a propósito): el histórico sobrevive al borrado del producto. Las fusiones la remapean al producto conservado.';

-- 2. Snapshot mínimo por producto ---------------------------------------------

create table if not exists public.analytics_product_snapshots (
  product_id bigint primary key,
  product_name text not null,
  product_slug text not null,
  product_image text,
  updated_at timestamptz not null default now()
);

alter table public.analytics_product_snapshots enable row level security;

revoke all on table public.analytics_product_snapshots from public, anon, authenticated;
grant select, insert, update, delete on table public.analytics_product_snapshots to service_role;

comment on table public.analytics_product_snapshots is
  'Último nombre/slug/imagen conocidos de cada producto con eventos de analítica, para leer el histórico aunque el producto se renombre o se elimine. Acceso exclusivo server-side.';

-- Imagen representativa: la misma regla que usa el ranking.
create or replace function public.analytics_product_image(p_product_id bigint, p_main_image text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(btrim(p_main_image), ''),
    (
      select i.url
      from public.imagenes_producto i
      where i.producto_id = p_product_id
      order by i.orden nulls last, i.id
      limit 1
    )
  );
$$;

insert into public.analytics_product_snapshots (product_id, product_name, product_slug, product_image)
select p.id, p.nombre, p.slug, public.analytics_product_image(p.id, p.imagen_principal)
from public.productos p
where exists (select 1 from public.analytics_events e where e.product_id = p.id)
on conflict (product_id) do nothing;

-- Última foto del producto antes de borrarlo (BEFORE: sus imágenes todavía existen).
create or replace function public.analytics_snapshot_deleted_product()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.analytics_events where product_id = old.id) then
    insert into public.analytics_product_snapshots as s (product_id, product_name, product_slug, product_image, updated_at)
    values (old.id, old.nombre, old.slug, public.analytics_product_image(old.id, old.imagen_principal), now())
    on conflict (product_id) do update
      set product_name = excluded.product_name,
          product_slug = excluded.product_slug,
          product_image = excluded.product_image,
          updated_at = excluded.updated_at;
  end if;
  return old;
end;
$$;

drop trigger if exists analytics_snapshot_deleted_product on public.productos;
create trigger analytics_snapshot_deleted_product
  before delete on public.productos
  for each row execute function public.analytics_snapshot_deleted_product();

-- 3. Registro de vistas (misma política; además mantiene el snapshot) ---------

create or replace function public.record_product_view(
  p_session_id uuid,
  p_product_id bigint,
  p_user_id uuid default null,
  p_source text default null,
  p_device_type text default null,
  p_client_key text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dedup_window constant interval := interval '30 minutes';
  v_rate_window constant interval := interval '1 hour';
  v_max_per_session constant integer := 120;
  v_max_per_client constant integer := 600;
  v_product public.productos%rowtype;
begin
  if p_session_id is null or p_product_id is null or p_product_id <= 0 then
    return 'invalid';
  end if;

  select * into v_product from public.productos where id = p_product_id and activo is true;
  if not found then
    return 'invalid_product';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('analytics:product_view:' || p_session_id::text || ':' || p_product_id::text, 0)
  );

  if exists (
    select 1
    from public.analytics_events
    where event_type = 'product_view'
      and session_id = p_session_id
      and product_id = p_product_id
      and occurred_at > now() - v_dedup_window
  ) then
    return 'duplicate';
  end if;

  if (
    select count(*)
    from public.analytics_events
    where event_type = 'product_view'
      and session_id = p_session_id
      and occurred_at > now() - v_rate_window
  ) >= v_max_per_session then
    return 'rate_limited';
  end if;

  -- Ventana móvil real de 60 minutos: el client_key es estable (ver
  -- lib/analytics/product-view-event.ts), así que no se parte a medianoche.
  if p_client_key is not null and (
    select count(*)
    from public.analytics_events
    where client_key = p_client_key
      and occurred_at > now() - v_rate_window
  ) >= v_max_per_client then
    return 'rate_limited';
  end if;

  insert into public.analytics_events (
    event_type, session_id, user_id, product_id, source, device_type, client_key
  ) values (
    'product_view', p_session_id, p_user_id, p_product_id, p_source, p_device_type, p_client_key
  );

  insert into public.analytics_product_snapshots as s (product_id, product_name, product_slug, product_image, updated_at)
  values (
    v_product.id,
    v_product.nombre,
    v_product.slug,
    public.analytics_product_image(v_product.id, v_product.imagen_principal),
    now()
  )
  on conflict (product_id) do update
    set product_name = excluded.product_name,
        product_slug = excluded.product_slug,
        product_image = excluded.product_image,
        updated_at = excluded.updated_at
    where (s.product_name, s.product_slug, s.product_image)
      is distinct from (excluded.product_name, excluded.product_slug, excluded.product_image);

  return 'recorded';
end;
$$;

-- 4. Ranking histórico ----------------------------------------------------------

drop function if exists public.admin_product_view_stats(date, date);

create function public.admin_product_view_stats(
  p_from date,
  p_to date
)
returns table (
  product_id bigint,
  product_name text,
  product_slug text,
  product_image text,
  product_available boolean,
  views bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with counted as (
    select e.product_id, count(*)::bigint as views
    from public.analytics_events e
    where e.event_type = 'product_view'
      and e.product_id is not null
      and e.occurred_at >= (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
      and e.occurred_at < ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
    group by e.product_id
  )
  select
    c.product_id,
    coalesce(p.nombre, s.product_name, 'Producto eliminado'),
    coalesce(p.slug, s.product_slug, ''),
    case
      when p.id is not null then public.analytics_product_image(p.id, p.imagen_principal)
      else s.product_image
    end,
    coalesce(p.activo, false),
    c.views
  from counted c
  left join public.productos p on p.id = c.product_id
  left join public.analytics_product_snapshots s on s.product_id = c.product_id
  where p_from is not null and p_to is not null and p_from <= p_to
  order by c.views desc, coalesce(p.nombre, s.product_name, 'Producto eliminado') asc, c.product_id asc;
$$;

revoke all on function public.record_product_view(uuid, bigint, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_product_view_stats(date, date) from public, anon, authenticated;
revoke all on function public.analytics_product_image(bigint, text) from public, anon, authenticated;
revoke all on function public.analytics_snapshot_deleted_product() from public, anon, authenticated;
grant execute on function public.record_product_view(uuid, bigint, uuid, text, text, text) to service_role;
grant execute on function public.admin_product_view_stats(date, date) to service_role;
grant execute on function public.analytics_product_image(bigint, text) to service_role;

-- 5. Fusión de productos ----------------------------------------------------------
-- Cuerpo idéntico al de 20261015130000_variant_parent_integrity.sql (verificado
-- contra pg_proc remoto) más el bloque de Analítica antes de borrar el absorbido.

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

  -- Analítica: las vistas del absorbido pasan a ser del conservado (una
  -- sola vez: se mueven, no se copian). Su snapshot deja de hacer falta.
  update public.analytics_events
  set product_id = p_keep_product_id
  where product_id = p_absorb_product_id;
  delete from public.analytics_product_snapshots
  where product_id = p_absorb_product_id;

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
  'Fusiona dos productos: mueve variantes e historial comercial y de analítica del absorbido al conservado, completa lo vacío de la ficha del conservado con la del absorbido (nunca pisa lo cargado) y elimina el absorbido dejando su snapshot completo en audit_logs.';

-- Retención recomendada (NO implementada todavía):
--   * Eventos crudos de analytics_events: 13 meses (permite comparar contra el
--     mismo mes del año anterior). client_key se anula a los 30 días: sólo
--     sirve para el límite de abuso de la última hora.
--   * Antes de purgar, consolidar en una tabla agregada diaria permanente
--     (día de Argentina, event_type, product_id, source, device_type, vistas).
--   * Conviene hacerlo cuando la tabla supere ~5-10 M de filas o cuando los
--     rangos largos de Admin > Analítica dejen de responder en < 1 s; hasta
--     entonces los índices por (event_type, occurred_at) alcanzan.

commit;
