-- adjust_variant_stock_idempotent nunca fijaba el actor de la operación
-- (beyonix.actor_id) antes de recalcular el stock, así que la fila de
-- audit_logs que genera el trigger genérico sobre producto_variantes
-- quedaba con actor_user_id/actor_email en null. Como la Auditoría oculta
-- los eventos sin actor identificado (ver isGeneralAdminAuditLog), los
-- ajustes manuales de stock eran invisibles en el panel a pesar de haberse
-- aplicado correctamente.
--
-- Además, el motivo obligatorio del ajuste (inventory_stock_adjustments.reason)
-- nunca quedaba asociado a la fila de auditoría de producto_variantes: sólo
-- vivía en la tabla de negocio. Esta migración adjunta el motivo y el delta
-- aplicado a esa misma fila (merge sobre after_data) para que la Auditoría
-- pueda mostrarlo sin joins adicionales, sin duplicar ni alterar el resto
-- de la información ya registrada.
create or replace function public.adjust_variant_stock_idempotent(
  p_variant_id bigint,
  p_new_quantity integer,
  p_reason text,
  p_actor_id uuid,
  p_idempotency_key text
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_delta integer;
  v_audit_log_id bigint;
begin
  if v_key is null or length(v_key) < 8 or length(v_key) > 240 then
    raise exception 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_new_quantity is null or p_new_quantity < 0 then
    raise exception 'La cantidad no puede ser negativa.';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Indicá un motivo para el ajuste.';
  end if;

  perform pg_advisory_xact_lock(hashtext('inventory-stock-adjustment'), hashtext(v_key));

  if exists (
    select 1 from public.inventory_operation_log log
    where log.idempotency_key = v_key
  ) then
    select * into v_variant
    from public.producto_variantes
    where id = p_variant_id;
    if not found then
      raise exception 'La variante ya no existe.';
    end if;
    return v_variant;
  end if;

  select * into v_variant
  from public.producto_variantes
  where id = p_variant_id
  for update;
  if not found then
    raise exception 'La variante ya no existe.';
  end if;

  perform pg_advisory_xact_lock(93000, v_variant.producto_id::integer);

  v_delta := p_new_quantity - coalesce(v_variant.stock, 0);
  if v_delta = 0 then
    return v_variant;
  end if;

  insert into public.inventory_stock_adjustments (
    product_id, variant_id, quantity_delta, reason, created_by, idempotency_key
  ) values (
    v_variant.producto_id, p_variant_id, v_delta, v_reason, p_actor_id, v_key
  );

  -- Identifica al actor de la operación para el trigger genérico de
  -- auditoría (mismo patrón que el resto de las funciones RPC atómicas de
  -- Productos, ver update_product_variant_metadata_atomic y afines).
  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  perform public.refresh_inventory_stock(v_variant.producto_id);

  -- Adjunta motivo y delta a la fila de auditoría que el trigger genérico
  -- acaba de insertar para esta variante (misma transacción, mismo lock),
  -- sin tocar antes/después originales.
  select id into v_audit_log_id
  from public.audit_logs
  where table_name = 'producto_variantes'
    and record_id = p_variant_id::text
    and action = 'UPDATE'
  order by id desc
  limit 1;

  if v_audit_log_id is not null then
    update public.audit_logs
    set after_data = coalesce(after_data, '{}'::jsonb) || jsonb_build_object(
      'stock_adjustment_reason', v_reason,
      'stock_adjustment_delta', v_delta
    )
    where id = v_audit_log_id;
  end if;

  insert into public.inventory_operation_log (
    product_id, variant_id, movement_type, quantity, origin, effective_at,
    actor_user_id, actor_process, idempotency_key, source_table, source_id,
    document_reference, metadata
  ) values (
    v_variant.producto_id, p_variant_id, 'adjustment', abs(v_delta),
    'admin_stock_adjustment', now(), p_actor_id,
    'adjust_variant_stock_idempotent', v_key, 'inventory_stock_adjustments',
    v_key, v_reason,
    jsonb_build_object(
      'previousStock', coalesce(v_variant.stock, 0),
      'newStock', p_new_quantity,
      'delta', v_delta
    )
  ) on conflict (idempotency_key) do nothing;

  select * into v_variant
  from public.producto_variantes
  where id = p_variant_id;
  return v_variant;
end;
$$;

revoke all on function public.adjust_variant_stock_idempotent(bigint, integer, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.adjust_variant_stock_idempotent(bigint, integer, text, uuid, text)
  to service_role;
