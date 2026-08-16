-- Eliminación forzada de productos/variantes exclusiva para SUPER_ADMIN.
-- guard_product_variant_delete y las FK en RESTRICT (product_cost_entries,
-- business_expenses, external_sales.variant_id, inventory_return_movements,
-- inventory_operation_log) siguen protegiendo cualquier eliminación normal.
-- Estas RPC son un camino privilegiado y auditado: desacoplan (SET NULL) el
-- historial comercial ya existente en vez de borrarlo, preservando nombre/SKU
-- ya snapshotteados en cada tabla, y sólo purgan inventory_operation_log
-- (log de idempotencia auxiliar, no el documento fuente).

-- inventory_return_movements exigía product_id; lo relajamos para poder
-- desacoplar devoluciones históricas de un producto eliminado a la fuerza,
-- igual que ya se hace con product_cost_entries (ver 083_uncatalogued_product_costs.sql).
alter table public.inventory_return_movements
  alter column product_id drop not null;

-- business_expenses de tipo 'product' exigía product_id no nulo; ya guarda su
-- propio product_name/product_sku, así que puede sobrevivir desacoplada.
alter table public.business_expenses
  drop constraint if exists business_expenses_product_fields_check;
alter table public.business_expenses
  add constraint business_expenses_product_fields_check check (
    (
      expense_type = 'money'
      and product_id is null
      and variant_id is null
      and quantity is null
    )
    or
    (
      expense_type = 'product'
      and product_name is not null
      and quantity is not null
      and quantity > 0
      and amount = 0
      and category in ('Donación/Regalo', 'Sorteo/Evento')
    )
  );

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

  select producto_id, nombre into v_product_id, v_variant_name
  from public.producto_variantes
  where id = p_variant_id
  for update;

  if not found then
    raise exception 'La variante ya no existe.';
  end if;

  perform pg_advisory_xact_lock(93000, v_product_id::integer);

  update public.product_cost_entries entries
  set article_name = coalesce(
        nullif(btrim(entries.article_name), ''),
        v_variant_name
      ),
      variant_id = null
  where entries.variant_id = p_variant_id;

  update public.business_expenses expenses
  set variant_id = null
  where expenses.variant_id = p_variant_id;

  update public.external_sales sales
  set variant_id = null
  where sales.variant_id = p_variant_id;

  alter table public.inventory_return_movements disable trigger validate_inventory_return_condition;
  alter table public.inventory_return_movements disable trigger guard_inventory_return_variant_link;
  update public.inventory_return_movements movements
  set variant_id = null
  where movements.variant_id = p_variant_id;
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

  delete from public.producto_variantes
  where id = p_variant_id;

  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, before_data, after_data
  ) values (
    'producto_variantes',
    'FORCE_DELETE',
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
  'Elimina una variante ignorando stock/historial, desacoplando (SET NULL) el historial comercial en vez de borrarlo. Exclusivo SUPER_ADMIN.';

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

  select nombre into v_product_name
  from public.productos
  where id = p_product_id
  for update;

  if not found then
    raise exception 'El producto ya no existe.';
  end if;

  update public.product_cost_entries entries
  set article_name = coalesce(
        nullif(btrim(entries.article_name), ''),
        (
          select variants.nombre
          from public.producto_variantes variants
          where variants.id = entries.variant_id
        ),
        v_product_name
      ),
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

  alter table public.inventory_return_movements disable trigger validate_inventory_return_condition;
  alter table public.inventory_return_movements disable trigger guard_inventory_return_variant_link;
  update public.inventory_return_movements movements
  set product_id = null,
      variant_id = null
  where movements.product_id = p_product_id;
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

  delete from public.producto_variantes
  where producto_id = p_product_id;

  delete from public.productos
  where id = p_product_id;

  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, before_data, after_data
  ) values (
    'productos',
    'FORCE_DELETE',
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
  'Elimina un producto y sus variantes ignorando stock/compras/ventas/devoluciones/reservas, desacoplando (SET NULL) el historial comercial en vez de borrarlo. Exclusivo SUPER_ADMIN.';
