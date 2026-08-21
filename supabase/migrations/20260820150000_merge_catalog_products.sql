-- Fusiona dos productos del catálogo en uno solo: mueve las variantes y todo
-- el historial comercial (compras, gastos, ventas externas/ML, devoluciones,
-- reservas, pedidos) del producto absorbido hacia el que se conserva, y
-- elimina el producto absorbido. Pensado para el caso típico de Compras: dos
-- colores del mismo artículo terminaron en dos productos separados porque
-- cada compra traía un SKU distinto (ensure_cost_catalog_product solo
-- deduplica por SKU, nunca por nombre cuando hay SKU).
--
-- Reutiliza exactamente el mismo bloque de triggers que
-- force_delete_product_super_admin (20260817140000) deshabilita/rehabilita
-- para poder tocar product_id/variant_id en bloque sin disparar validaciones
-- pensadas para altas normales ni el registro inmutable de operaciones.

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
      'absorbedName', v_absorb.nombre
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
  'Fusiona dos productos: mueve variantes e historial comercial (compras, gastos, ventas externas/ML, devoluciones, reservas, pedidos) del absorbido al conservado, y elimina el absorbido. Rechaza la fusión si hay variantes con el mismo nombre o color en ambos productos.';
