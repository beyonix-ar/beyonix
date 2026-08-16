-- Causa de las compras "Negro" en Compras → Mercadería tras un force-delete:
-- force_delete_product_super_admin / force_delete_product_variant_super_admin
-- usaban `variants.nombre` (el nombre de la variante, que desde la corrección
-- anterior del modelo SIEMPRE es el color, p.ej. "Negro") como el snapshot
-- article_name de product_cost_entries cuando el producto no tenía un
-- article_name propio todavía. Eso convertía el nombre histórico de la
-- compra en el color en vez del nombre del producto comprado.
--
-- Corrección: article_name pasa a construirse siempre con el nombre del
-- PRODUCTO como base ("APOYABRAZOS SARASA"), agregando el color como
-- calificador entre paréntesis sólo si la fila tenía variante
-- ("APOYABRAZOS SARASA (Negro)") — nunca el color solo. Se agrega también
-- el snapshot de sku (antes no se guardaba) y una marca discreta en notes
-- para poder identificar que el producto de origen ya no existe, sin alterar
-- el nombre. buildStandaloneCostItems/getStandaloneHistoricalUnitCost
-- (lib/business/standalone-cost-items.ts) agrupan artículos sueltos por
-- article_name (o sku si no hay nombre): con el nombre del producto como
-- base, dos productos distintos con la misma variante de color ya no
-- colisionan en el mismo artículo histórico.

create or replace function public.force_delete_product_variant_super_admin(
  p_variant_id bigint,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_product_id bigint;
  v_variant_name text;
  v_variant_sku text;
  v_product_name text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para eliminar variantes.';
  end if;

  select rol into v_actor_role
  from public.profiles
  where id = p_actor_id;

  if v_actor_role is distinct from 'super_admin' then
    raise exception 'Solamente un SUPER ADMIN puede forzar la eliminación de una variante.';
  end if;

  select producto_id, nombre, sku
  into v_product_id, v_variant_name, v_variant_sku
  from public.producto_variantes
  where id = p_variant_id
  for update;

  if not found then
    raise exception 'La variante ya no existe.';
  end if;

  perform pg_advisory_xact_lock(93000, v_product_id::integer);

  select nombre into v_product_name
  from public.productos
  where id = v_product_id;

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

  update public.product_cost_entries entries
  set article_name = coalesce(
        nullif(btrim(entries.article_name), ''),
        case
          when nullif(btrim(v_variant_name), '') is not null
            then coalesce(v_product_name, 'Producto eliminado') || ' (' || v_variant_name || ')'
          else v_product_name
        end
      ),
      sku = coalesce(nullif(btrim(entries.sku), ''), v_variant_sku),
      notes = case
        when entries.notes is null or entries.notes !~ 'Producto eliminado'
          then nullif(btrim(coalesce(entries.notes, '') || ' [Producto eliminado]'), '')
        else entries.notes
      end,
      variant_id = null
  where entries.variant_id = p_variant_id;

  update public.business_expenses expenses
  set variant_id = null
  where expenses.variant_id = p_variant_id;

  update public.external_sales sales
  set variant_id = null
  where sales.variant_id = p_variant_id;

  -- mercadolibre_sales no tiene columna variant_id propia: el mapeo vive en
  -- raw_data.beyonix_cost_mapping.variant_id (ver inventory_ml_variant_id).
  -- Se conserva la venta y su product_id (el producto sigue existiendo); sólo
  -- se quita el puntero a la variante que va a desaparecer.
  update public.mercadolibre_sales sales
  set raw_data = sales.raw_data #- '{beyonix_cost_mapping,variant_id}'
  where sales.product_id = v_product_id
    and public.inventory_ml_variant_id(sales.raw_data) = p_variant_id;

  update public.inventory_return_movements movements
  set variant_id = null
  where movements.variant_id = p_variant_id;

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
  delete from public.inventory_operation_log
  where variant_id = p_variant_id;
  alter table public.inventory_operation_log enable trigger prevent_inventory_operation_log_mutation;

  delete from public.inventory_variant_allocations
  where variant_id = p_variant_id;

  delete from public.stock_reservations
  where variant_id = p_variant_id;

  perform public.refresh_inventory_stock(v_product_id);

  begin
    delete from public.producto_variantes
    where id = p_variant_id;
  exception
    when others then
      raise exception
        'No se pudo completar la eliminación forzada de la variante por un estado inesperado (%). Revisá el historial vinculado.',
        sqlerrm;
  end;

  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, before_data, after_data
  ) values (
    'producto_variantes',
    'DELETE',
    p_variant_id::text,
    p_actor_id,
    jsonb_build_object('nombre', v_variant_name, 'producto_id', v_product_id),
    jsonb_build_object('reason', 'super_admin_force_delete')
  );
end;
$$;

revoke all on function public.force_delete_product_variant_super_admin(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.force_delete_product_variant_super_admin(bigint, uuid)
  to service_role;

comment on function public.force_delete_product_variant_super_admin(bigint, uuid) is
  'Elimina una variante ignorando stock/historial, desacoplando (SET NULL) el historial comercial (incluida Mercado Libre) en vez de borrarlo, con snapshot correcto (nombre del producto, no del color) y sin re-vincularlo al catálogo de costos. Exclusivo SUPER_ADMIN.';

create or replace function public.force_delete_product_super_admin(
  p_product_id bigint,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_product_name text;
  v_product_sku text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para eliminar productos.';
  end if;

  select rol into v_actor_role
  from public.profiles
  where id = p_actor_id;

  if v_actor_role is distinct from 'super_admin' then
    raise exception 'Solamente un SUPER ADMIN puede forzar la eliminación de un producto.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  select nombre, sku into v_product_name, v_product_sku
  from public.productos
  where id = p_product_id
  for update;

  if not found then
    raise exception 'El producto ya no existe.';
  end if;

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

  update public.product_cost_entries entries
  set article_name = coalesce(
        nullif(btrim(entries.article_name), ''),
        case
          when entries.variant_id is not null then
            coalesce(v_product_name, 'Producto eliminado') || coalesce(
              (
                select ' (' || variants.nombre || ')'
                from public.producto_variantes variants
                where variants.id = entries.variant_id
                  and nullif(btrim(variants.nombre), '') is not null
              ),
              ''
            )
          else v_product_name
        end
      ),
      sku = coalesce(
        nullif(btrim(entries.sku), ''),
        (
          select variants.sku
          from public.producto_variantes variants
          where variants.id = entries.variant_id
        ),
        v_product_sku
      ),
      notes = case
        when entries.notes is null or entries.notes !~ 'Producto eliminado'
          then nullif(btrim(coalesce(entries.notes, '') || ' [Producto eliminado]'), '')
        else entries.notes
      end,
      product_id = null,
      variant_id = null
  where entries.product_id = p_product_id;

  update public.business_expenses expenses
  set product_name = coalesce(nullif(btrim(expenses.product_name), ''), v_product_name),
      product_id = null,
      variant_id = null
  where expenses.product_id = p_product_id;

  update public.external_sales sales
  set product_id = null,
      variant_id = null
  where sales.product_id = p_product_id;

  -- Ver comentario equivalente en force_delete_product_variant_super_admin:
  -- mercadolibre_sales.product_id ya es ON DELETE SET NULL, pero eso sólo se
  -- aplica cuando corre el DELETE FROM productos final; si no se desacopla
  -- explícitamente acá, el recálculo de stock (más abajo y en cualquier
  -- trigger intermedio) sigue viendo la venta como una salida vigente.
  update public.mercadolibre_sales sales
  set product_id = null
  where sales.product_id = p_product_id;

  update public.inventory_return_movements movements
  set product_id = null,
      variant_id = null
  where movements.product_id = p_product_id;

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
  delete from public.inventory_operation_log
  where product_id = p_product_id;
  alter table public.inventory_operation_log enable trigger prevent_inventory_operation_log_mutation;

  delete from public.inventory_variant_allocations
  where product_id = p_product_id;

  delete from public.stock_reservations
  where product_id = p_product_id;

  perform public.refresh_inventory_stock(p_product_id);

  begin
    delete from public.producto_variantes
    where producto_id = p_product_id;

    delete from public.productos
    where id = p_product_id;
  exception
    when others then
      raise exception
        'No se pudo completar la eliminación forzada del producto por un estado inesperado (%). Revisá el historial vinculado.',
        sqlerrm;
  end;

  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, before_data, after_data
  ) values (
    'productos',
    'DELETE',
    p_product_id::text,
    p_actor_id,
    jsonb_build_object('nombre', v_product_name),
    jsonb_build_object('reason', 'super_admin_force_delete')
  );
end;
$$;

revoke all on function public.force_delete_product_super_admin(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.force_delete_product_super_admin(bigint, uuid)
  to service_role;

comment on function public.force_delete_product_super_admin(bigint, uuid) is
  'Elimina un producto y sus variantes ignorando stock/compras/ventas/devoluciones/reservas, desacoplando (SET NULL) el historial comercial (incluida Mercado Libre) en vez de borrarlo, con snapshot correcto (nombre del producto, no del color) y sin re-vincularlo al catálogo de costos. Exclusivo SUPER_ADMIN.';

-- SUPER_ADMIN Y COMPRAS: delete_product_purchase_atomic (admins normales) ya
-- permite eliminar una compra desacoplada/histórica (product_id null) sin
-- restricción, porque no hay stock que proteger. La única restricción real
-- que existe hoy es STOCK_INSUFICIENTE cuando la compra sigue vinculada a un
-- producto vigente y parte de ese stock ya se vendió. Esta RPC nueva es la
-- única vía para que SUPER_ADMIN pueda saltear esa protección puntual
-- (prueba cargada por error, compra que ya no corresponde, etc.), sin tocar
-- delete_product_purchase_atomic ni la restricción para el resto de roles.
create or replace function public.force_delete_purchase_super_admin(
  p_purchase_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_entry public.product_cost_entries%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para eliminar compras.';
  end if;

  select rol into v_actor_role
  from public.profiles
  where id = p_actor_id;

  if v_actor_role is distinct from 'super_admin' then
    raise exception 'Solamente un SUPER ADMIN puede forzar la eliminación de una compra.';
  end if;

  select * into v_entry
  from public.product_cost_entries entries
  where entries.id = p_purchase_id
  for update;

  if not found then
    raise exception 'La compra ya no existe.';
  end if;

  if v_entry.product_id is not null then
    perform pg_advisory_xact_lock(93000, v_entry.product_id::integer);
  end if;

  delete from public.product_cost_entries
  where id = p_purchase_id;

  if v_entry.product_id is not null then
    perform public.refresh_inventory_stock(v_entry.product_id);
  end if;

  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, before_data, after_data
  ) values (
    'product_cost_entries',
    'DELETE',
    p_purchase_id::text,
    p_actor_id,
    to_jsonb(v_entry),
    jsonb_build_object('reason', 'super_admin_force_delete_purchase')
  );
end;
$$;

revoke all on function public.force_delete_purchase_super_admin(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.force_delete_purchase_super_admin(uuid, uuid)
  to service_role;

comment on function public.force_delete_purchase_super_admin(uuid, uuid) is
  'Elimina definitivamente una compra (histórica o vigente) ignorando la protección de stock ya consumido, recalculando el stock derivado si seguía vinculada a un producto. Exclusivo SUPER_ADMIN.';
