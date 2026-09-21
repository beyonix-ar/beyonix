-- Auditoría 4/7 (devoluciones), Fase 1 punto 1 + Fase 2 punto 3.
--
-- P0 confirmado: existían DOS escritores de inventory_return_movements para
-- la misma devolución de pedido web -- process_order_item_return_inventory
-- (vía reclamos) y un upsert directo hecho por app/api/admin/orders/[id]/
-- credit-note/route.ts -- sin coordinación entre sí. Uno marcaba orden_items.
-- return_inventory_processed_at, el otro nunca lo tocaba, así que el mismo
-- ítem podía procesarse por ambos caminos y duplicar el reingreso de stock.
--
-- Esta migración crea una única autoridad -- record_order_item_return_
-- reception() -- que:
--   - toma lock (FOR UPDATE) sobre la fila de orden_items
--   - es idempotente por source_key (reintento con la misma key = mismo
--     resultado, sin reaplicar)
--   - valida cantidad acumulada contra un tope (cantidad vendida, o la
--     cantidad reclamada cuando el llamador la pasa) -- soporta MÚLTIPLES
--     eventos de devolución parcial sucesivos sobre el mismo ítem, algo que
--     el diseño anterior (un único booleano return_inventory_processed_at
--     que bloqueaba cualquier segundo intento) no permitía
--   - escribe el ledger (inventory_return_movements) y el agregado derivado
--     en orden_items en la misma transacción
--   - deja auditoría (order_audit_events + audit_logs vía el trigger
--     genérico ya adjuntado en 20260920100000)
--
-- process_claim_return_inventory (el único llamador real hoy, confirmado en
-- la auditoría) pasa a delegar en esta función. credit-note/route.ts se
-- actualiza en el mismo cambio (código de aplicación) para llamarla también,
-- en vez de hacer upsert directo -- ver ese archivo.
--
-- process_order_item_return_inventory (la función vieja) queda SIN
-- llamadores nuevos pero NO se elimina (evita romper cualquier invocación
-- externa desconocida); es código muerto seguro, no una segunda autoridad.

begin;

-- El agregado en orden_items ahora se actualiza más de una vez por ítem
-- (una por cada evento de devolución parcial) -- el trigger que lo protegía
-- necesita distinguir "otro camino escribiendo directo" (bloqueado, como
-- siempre) de "la propia RPC acumulando un evento más" (permitido). Mismo
-- patrón que guard_derived_inventory_stock/beyonix.inventory_refresh.
create or replace function public.prevent_return_inventory_reprocessing()
returns trigger
set search_path to 'public'
language plpgsql
as $function$
begin
  if old.return_inventory_processed_at is not null
     and coalesce(current_setting('beyonix.return_reception_rpc', true), '') <> 'on'
     and (
       new.return_restocked_quantity is distinct from old.return_restocked_quantity
       or new.return_written_off_quantity is distinct from old.return_written_off_quantity
       or new.return_inventory_note is distinct from old.return_inventory_note
       or new.return_inventory_processed_at is distinct from old.return_inventory_processed_at
       or new.return_inventory_processed_by is distinct from old.return_inventory_processed_by
     ) then
    raise exception 'La recepción de este producto ya fue registrada y no puede modificarse.';
  end if;

  return new;
end;
$function$;

create or replace trigger prevent_return_inventory_reprocessing
  before update on public.orden_items
  for each row execute function public.prevent_return_inventory_reprocessing();

create or replace function public.record_order_item_return_reception(
  p_order_id bigint,
  p_order_item_id bigint,
  p_sellable_quantity integer,
  p_discounted_quantity integer,
  p_non_sellable_quantity integer,
  p_idempotency_key text,
  p_processed_by uuid,
  p_note text default null,
  p_discount_percent numeric default null,
  p_discount_reason text default null,
  p_non_sellable_reason text default null,
  p_conditioned_name text default null,
  p_conditioned_sku text default null,
  p_conditioned_color_hex text default null,
  p_conditioned_images jsonb default '[]'::jsonb,
  p_occurred_at timestamptz default now(),
  p_max_quantity_override integer default null,
  -- Un order_item vendido desde stock condicionado (conditioned_stock_id)
  -- no tiene variante propia en orden_items -- su variante real es la del
  -- lote condicionado original. Permite que el llamador la resuelva y la
  -- pase explícita; si no se pasa, se usa v_item.variante_id (caso normal).
  p_variant_id_override bigint default null
)
returns public.inventory_return_movements
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item public.orden_items%rowtype;
  v_existing public.inventory_return_movements%rowtype;
  v_movement public.inventory_return_movements%rowtype;
  v_already integer;
  v_requested integer;
  v_cap integer;
  v_source_key text;
  v_non_sellable_reason text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'RETURN_FORBIDDEN';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'RETURN_IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if p_sellable_quantity < 0 or p_discounted_quantity < 0 or p_non_sellable_quantity < 0 then
    raise exception 'Las cantidades de la devolución no pueden ser negativas.';
  end if;

  v_requested := p_sellable_quantity + p_discounted_quantity + p_non_sellable_quantity;
  if v_requested <= 0 then
    raise exception 'Indicá al menos una unidad recibida para registrar la devolución.';
  end if;
  -- validate_inventory_return_condition (trigger) exige non_sellable_reason
  -- en la FILA -- no alcanza con validar acá y seguir insertando el
  -- p_non_sellable_reason original: si vino vacío, el motivo pasado en
  -- p_note (ya validado abajo) es el que efectivamente se persiste.
  v_non_sellable_reason := nullif(trim(coalesce(p_non_sellable_reason, '')), '');
  if v_non_sellable_reason is null then
    v_non_sellable_reason := nullif(trim(coalesce(p_note, '')), '');
  end if;
  if p_non_sellable_quantity > 0
     and (v_non_sellable_reason is null or length(v_non_sellable_reason) < 3) then
    raise exception 'Indicá el motivo de la baja o pérdida.';
  end if;

  v_source_key := 'order-item:' || p_order_item_id || ':' || p_idempotency_key;

  -- Idempotencia: reintento (doble click, retry, dos pestañas) con la misma
  -- key devuelve el resultado ya aplicado, sin volver a tocar stock/auditoría.
  select * into v_existing
  from public.inventory_return_movements
  where source_key = v_source_key;
  if found then
    return v_existing;
  end if;

  select * into v_item
  from public.orden_items
  where id = p_order_item_id and orden_id = p_order_id
  for update;
  if not found then
    raise exception 'No se encontró el producto dentro del pedido.';
  end if;

  select coalesce(sum(received_quantity), 0) into v_already
  from public.inventory_return_movements
  where order_item_id = p_order_item_id;

  v_cap := coalesce(p_max_quantity_override, v_item.cantidad);
  if v_already + v_requested > v_cap then
    raise exception
      'RETURN_EXCEEDS_REMAINING: quedan % unidad(es) disponibles para devolver de este producto (ya se registraron % de %).',
      greatest(v_cap - v_already, 0), v_already, v_cap;
  end if;

  -- El trigger genérico inventory_return_movements_audit_log_trigger (ver
  -- 20260920100000) audita este INSERT automáticamente; esto sólo le da el
  -- actor correcto vía auth.uid().
  perform set_config('beyonix.actor_id', p_processed_by::text, true);

  insert into public.inventory_return_movements (
    source_key, order_id, order_item_id, product_id, variant_id,
    quantity, received_quantity, sellable_quantity, discounted_quantity, non_sellable_quantity,
    discount_percent, discount_reason, non_sellable_reason, review_notes,
    conditioned_active, conditioned_name, conditioned_sku, conditioned_color_hex, conditioned_images,
    occurred_at, approved_by, approved_at
  ) values (
    v_source_key, p_order_id, p_order_item_id, v_item.producto_id, coalesce(p_variant_id_override, v_item.variante_id),
    p_sellable_quantity, v_requested, p_sellable_quantity, p_discounted_quantity, p_non_sellable_quantity,
    p_discount_percent, p_discount_reason, v_non_sellable_reason, nullif(left(trim(coalesce(p_note, '')), 1000), ''),
    p_discounted_quantity > 0, p_conditioned_name, p_conditioned_sku, p_conditioned_color_hex,
    coalesce(p_conditioned_images, '[]'::jsonb),
    p_occurred_at, p_processed_by, now()
  )
  returning * into v_movement;

  perform set_config('beyonix.return_reception_rpc', 'on', true);
  update public.orden_items
  set return_restocked_quantity = (
        select coalesce(sum(sellable_quantity + discounted_quantity), 0)
        from public.inventory_return_movements
        where order_item_id = p_order_item_id
      ),
      return_written_off_quantity = (
        select coalesce(sum(non_sellable_quantity), 0)
        from public.inventory_return_movements
        where order_item_id = p_order_item_id
      ),
      return_inventory_note = case
        when nullif(trim(coalesce(p_note, '')), '') is null then return_inventory_note
        when return_inventory_note is null then left(trim(p_note), 1000)
        else left(return_inventory_note || E'\n---\n' || trim(p_note), 1000)
      end,
      return_inventory_processed_at = now(),
      return_inventory_processed_by = p_processed_by
  where id = p_order_item_id;

  insert into public.order_audit_events (
    order_id, actor_type, actor_id, action, metadata
  ) values (
    p_order_id, 'admin', p_processed_by, 'return_inventory_processed',
    jsonb_build_object(
      'orderItemId', p_order_item_id,
      'productId', v_item.producto_id,
      'variantId', v_item.variante_id,
      'sellableQuantity', p_sellable_quantity,
      'discountedQuantity', p_discounted_quantity,
      'nonSellableQuantity', p_non_sellable_quantity,
      'sourceKey', v_source_key,
      'cumulativeReturned', v_already + v_requested,
      'soldQuantity', v_item.cantidad,
      'remaining', v_item.cantidad - (v_already + v_requested)
    )
  );

  return v_movement;
end;
$function$;

revoke all on function public.record_order_item_return_reception(
  bigint, bigint, integer, integer, integer, text, uuid, text, numeric, text, text,
  text, text, text, jsonb, timestamptz, integer, bigint
) from public, anon, authenticated;
grant execute on function public.record_order_item_return_reception(
  bigint, bigint, integer, integer, integer, text, uuid, text, numeric, text, text,
  text, text, text, jsonb, timestamptz, integer, bigint
) to service_role;

-- process_claim_return_inventory delega ahora en la autoridad única. Cambia
-- de firma (agrega p_idempotency_key) -- su único llamador conocido
-- (app/api/admin/pedidos/[id]/return-inventory/[itemId]/route.ts) se
-- actualiza en el mismo cambio para pasarlo.
drop function if exists public.process_claim_return_inventory(bigint, bigint, bigint, integer, integer, text, uuid);

create or replace function public.process_claim_return_inventory(
  p_claim_id bigint,
  p_order_id bigint,
  p_order_item_id bigint,
  p_restocked_quantity integer,
  p_written_off_quantity integer,
  p_note text,
  p_processed_by uuid,
  p_idempotency_key text
)
returns public.orden_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_quantity integer;
  v_result public.orden_items%rowtype;
begin
  if auth.role() is distinct from 'service_role'
     or not exists (select 1 from public.profiles where id = p_processed_by and rol in ('admin', 'super_admin')) then
    raise exception 'CLAIM_FORBIDDEN';
  end if;
  perform id from public.ordenes where id = p_order_id for update;
  select * into v_claim from public.order_claims where id = p_claim_id and order_id = p_order_id for update;
  if not found or coalesce(v_claim.failure_type, '') in ('cancelar_compra', 'consulta_pedido') then
    raise exception 'CLAIM_INVALID';
  end if;

  select (x->>'quantity')::integer into v_quantity
  from jsonb_array_elements(v_claim.affected_items) x
  where (x->>'order_item_id')::bigint = p_order_item_id;
  if v_quantity is null
     or p_restocked_quantity is null or p_written_off_quantity is null
     or p_restocked_quantity < 0 or p_written_off_quantity < 0
     or p_restocked_quantity + p_written_off_quantity > v_quantity then
    raise exception 'CLAIM_INVALID_ITEMS';
  end if;

  -- El tope real de esta llamada es lo reclamado para este ítem, no sólo lo
  -- vendido (record_order_item_return_reception igual vuelve a validar
  -- contra lo vendido como defensa en profundidad).
  perform public.record_order_item_return_reception(
    p_order_id := p_order_id,
    p_order_item_id := p_order_item_id,
    p_sellable_quantity := p_restocked_quantity,
    p_discounted_quantity := 0,
    p_non_sellable_quantity := p_written_off_quantity,
    p_idempotency_key := p_idempotency_key,
    p_processed_by := p_processed_by,
    p_note := p_note,
    p_max_quantity_override := v_quantity
  );

  select * into v_result from public.orden_items where id = p_order_item_id;
  return v_result;
end;
$$;
revoke all on function public.process_claim_return_inventory(bigint, bigint, bigint, integer, integer, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.process_claim_return_inventory(bigint, bigint, bigint, integer, integer, text, uuid, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
