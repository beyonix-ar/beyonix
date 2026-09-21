-- Auditoría 3/7 (compras/reposición/costos), Fase 3, punto 1 -- CORREGIDO tras
-- verificación en vivo contra producción (solo lectura, 2026-09-18/19).
--
-- El hallazgo original ("audit_business_cost_movement() nunca se adjuntó
-- como trigger") era INCORRECTO: producción SÍ tiene el trigger
-- `audit_product_cost_entries` (AFTER INSERT OR UPDATE OR DELETE, ENABLED)
-- desde supabase/sql/080_business_costs.sql:120-122 -- aplicado directamente
-- a producción antes de existir supabase/migrations/, igual que otros casos
-- ya detectados en esta auditoría. El error del hallazgo original fue no
-- revisar supabase/sql/080 (sólo se había grepeado supabase/migrations/).
-- Confirmado con pg_get_triggerdef en vivo: el trigger real se llama
-- `audit_product_cost_entries`, NO `audit_product_cost_entries_changes`
-- (nombre que se había usado acá antes de esta corrección). Esta migración
-- reproduce el trigger real con su nombre real -- pura reproducibilidad, cero
-- cambio de comportamiento para el alta/edición/borrado normal.
--
-- Lo que SÍ era un bug real, confirmado en vivo: `force_delete_purchase_
-- super_admin` en producción NO desactiva ese trigger antes de su DELETE, así
-- que HOY duplica la fila de auditoría (una del trigger genérico + una del
-- insert manual con reason='super_admin_force_delete_purchase'). Ese es el
-- único cambio de comportamiento real de esta migración.

begin;

create or replace trigger audit_product_cost_entries
  after insert or update or delete on public.product_cost_entries
  for each row execute function public.audit_business_cost_movement();

-- force_delete_purchase_super_admin ya inserta a mano en audit_logs un
-- snapshot completo con action='DELETE' y reason='super_admin_force_delete_
-- purchase' (más informativo que el genérico del trigger). Sin este disable,
-- el DELETE de abajo dispara el trigger `audit_product_cost_entries` (que ya
-- corre hoy en producción) y deja una segunda fila de auditoría redundante
-- para la misma operación -- confirmado que esto pasa HOY en producción,
-- porque la versión en vivo de esta función no hace este disable/enable.
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

  alter table public.product_cost_entries disable trigger audit_product_cost_entries;

  delete from public.product_cost_entries
  where id = p_purchase_id;

  alter table public.product_cost_entries enable trigger audit_product_cost_entries;

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
  'Elimina definitivamente una compra (histórica o vigente) ignorando la protección de stock ya consumido, recalculando el stock derivado si seguía vinculada a un producto. Exclusivo SUPER_ADMIN. Audita a mano (desactiva el trigger genérico audit_product_cost_entries para no duplicar la fila de audit_logs).';

commit;
