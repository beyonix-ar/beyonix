-- Corrige 20260817100000_super_admin_force_delete.sql: audit_logs.action
-- sólo admite 'INSERT' | 'UPDATE' | 'DELETE' (audit_logs_action_check,
-- ver supabase/sql/020_roles_and_permissions.sql). Las RPC de eliminación
-- forzada insertaban 'FORCE_DELETE', que viola ese constraint y abortaba
-- toda la transacción. Se reutiliza 'DELETE' (semánticamente correcto: la
-- fila se borra) y se conserva el detalle en after_data.reason, ya
-- soportado por app/admin/sections/auditoria/audit-helpers.ts.

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
  'Elimina un producto y sus variantes ignorando stock/compras/ventas/devoluciones/reservas, desacoplando (SET NULL) el historial comercial en vez de borrarlo. Exclusivo SUPER_ADMIN.';
