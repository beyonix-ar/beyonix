-- Consolidación de la postventa sobre la matriz de resoluciones
-- (lib/orders/claim-policy.ts). Cambios mínimos y compatibles:
--
-- 1. Nota de crédito sólo para soluciones que mueven dinero. Un reclamo
--    resuelto con reemplazo (o "otra solución") nunca puede emitir una NC
--    ligada al reclamo: la NC es la consecuencia fiscal de un reintegro o de un
--    saldo a favor, no una decisión aparte. Las cancelaciones conservan su
--    circuito propio. Sólo afecta NC nuevas (BEFORE INSERT): el historial no
--    cambia.
--
-- 2. Reemplazo sin devolución (el cliente conserva el original, decisión
--    auditada con motivo): antes un reemplazo nuevo sólo podía enviarse
--    después de un retiro o dentro de un cambio en sucursal. Ahora el Admin
--    puede dispensar la devolución ANTES de cualquier operación Andreani real
--    y enviar el reemplazo por sucursal (VENTA sucursal), con las mismas
--    reservas, tramos, guardas de cierre e idempotencia.
--
-- 3. Resumen congelado al cerrar: nombres comerciales (sin "Nota de crédito"
--    para el cliente). Sólo afecta reclamos que se cierren a partir de ahora.

begin;

-- 1. NC sólo con solución económica ------------------------------------------

create or replace function public.claim_resolution_allows_credit_note(p_resolution text, p_failure_type text)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select coalesce(p_failure_type, '') = 'cancelar_compra'
    or coalesce(p_resolution, '') in ('reintegro_total', 'reintegro_parcial', 'saldo_a_favor', 'cupon_descuento')
$$;

create or replace function public.guard_claim_credit_note_resolution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resolution text;
  v_failure_type text;
begin
  if new.claim_id is null then return new; end if;
  select resolution, failure_type into v_resolution, v_failure_type
  from public.order_claims where id = new.claim_id;
  if not found then return new; end if;
  if not public.claim_resolution_allows_credit_note(v_resolution, v_failure_type) then
    raise exception 'CREDIT_NOTE_CLAIM_NOT_FINANCIAL';
  end if;
  return new;
end;
$$;

drop trigger if exists aa_guard_claim_credit_note_resolution on public.order_credit_notes;
create trigger aa_guard_claim_credit_note_resolution
  before insert on public.order_credit_notes
  for each row execute function public.guard_claim_credit_note_resolution();

-- 2. Reemplazo sin devolución --------------------------------------------------

-- Devolución dispensada: hay originales, todos quedaron con el cliente y nunca
-- hubo un retiro ni un cambio vigente.
create or replace function public.order_claim_return_waived(p_claim_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original')
    and not exists (select 1 from public.order_claim_units
                    where claim_id = p_claim_id and role = 'original' and location <> 'conservada_cliente')
    and not exists (select 1 from public.order_claim_shipments
                    where claim_id = p_claim_id and status <> 'cancelada' and direction in ('devolucion', 'cambio'))
$$;

-- Igual a 20261001100000 salvo el reenvío: también se habilita con la
-- devolución dispensada (order_claim_return_waived), además del plan
-- Retiro + revisión con el retiro generado.
create or replace function public.request_order_claim_logistics(
  p_claim_id bigint,
  p_actor_id uuid,
  p_direction text,
  p_note text,
  p_branch_id text,
  p_branch_name text,
  p_branch_address text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_open public.order_claim_shipments%rowtype;
  v_leg public.order_claim_shipments%rowtype;
  v_current_plan text;
  v_new_plan text := case p_direction when 'cambio' then 'cambio' else 'retiro' end;
  v_branch_id text := nullif(btrim(coalesce(p_branch_id, '')), '');
  v_note text := btrim(coalesce(p_note, ''));
  v_plan_change boolean := false;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_direction not in ('devolucion', 'cambio', 'reemplazo') then raise exception 'CLAIM_SHIPMENT_INVALID'; end if;
  if v_branch_id is null then raise exception 'CLAIM_LOGISTICS_BRANCH_REQUIRED'; end if;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if not public.order_claim_is_accepted(v_claim) then raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED'; end if;
  if p_direction = 'devolucion'
     and v_claim.resolution not in ('cambio_producto', 'reintegro_total', 'reintegro_parcial', 'saldo_a_favor', 'cupon_descuento') then
    raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
  end if;
  if p_direction in ('cambio', 'reemplazo') and v_claim.resolution <> 'cambio_producto' then
    raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open)
     or exists (select 1 from public.order_claim_shipments where claim_id = p_claim_id and review_required) then
    raise exception 'CLAIM_LOGISTICS_INCIDENT';
  end if;
  -- Legacy: nunca se transforma un reclamo que ya tuvo movimientos.
  if v_claim.logistics_legacy and not exists (select 1 from public.order_claim_units where claim_id = p_claim_id) then
    if exists (select 1 from public.order_replacements where claim_id = p_claim_id)
       or exists (select 1 from public.order_claim_shipments where claim_id = p_claim_id and status <> 'cancelada')
       or exists (select 1 from public.order_credit_notes where claim_id = p_claim_id and status in ('processing', 'authorized'))
       or exists (
         select 1 from public.inventory_return_movements m
         where m.order_id = v_claim.order_id and m.created_at >= v_claim.created_at
           and m.order_item_id in (select (x->>'order_item_id')::bigint from jsonb_array_elements(v_claim.affected_items) x)
       ) then
      raise exception 'CLAIM_LOGISTICS_LEGACY';
    end if;
    perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_legacy_opt_in',
      jsonb_build_object('direction', p_direction));
  end if;

  v_current_plan := public.order_claim_logistics_plan(p_claim_id);
  if p_direction = 'reemplazo' then
    -- Nunca antes de la inspección: sólo después de un retiro generado
    -- (Retiro + revisión) o con la devolución dispensada explícitamente.
    if not (
      (v_current_plan = 'retiro' and exists (select 1 from public.order_claim_shipments
         where claim_id = p_claim_id and direction = 'devolucion' and status <> 'cancelada' and creation_status = 'created'))
      or public.order_claim_return_waived(p_claim_id)
    ) then
      raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
    end if;
    if not public.order_claim_originals_inspected(p_claim_id) then raise exception 'CLAIM_LOGISTICS_REQUIRES_INSPECTION'; end if;
  elsif v_current_plan is not null and v_current_plan <> v_new_plan then
    v_plan_change := true;
    if exists (
      select 1 from public.order_claim_shipments
      where claim_id = p_claim_id and status <> 'cancelada' and creation_status in ('processing', 'created', 'manual_review')
    ) then
      if length(v_note) < 10 then raise exception 'CLAIM_LOGISTICS_PLAN_LOCKED'; end if;
      perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_plan_changed',
        jsonb_build_object('from', v_current_plan, 'to', v_new_plan, 'notes', left(v_note, 1000)));
    end if;
  end if;

  select * into v_open from public.order_claim_shipments where claim_id = p_claim_id and closed_at is null
  order by legacy desc, id desc limit 1 for update;
  if found then
    if v_open.legacy then raise exception 'CLAIM_LOGISTICS_OPEN'; end if;
    if v_open.direction = p_direction then return v_open; end if;
    if v_open.status <> 'pendiente' or v_open.creation_status not in ('not_started', 'failed') then
      raise exception 'CLAIM_LOGISTICS_OPEN';
    end if;
    update public.order_claim_shipments
    set status = 'cancelada', closed_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_open.id;
    perform public.release_order_claim_leg_units(v_open.id);
    perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_cancelled',
      jsonb_build_object('shipmentId', v_open.id, 'direction', v_open.direction, 'reason', 'plan_change',
        'notes', left(v_note, 1000)));
  end if;

  if v_plan_change then
    if exists (select 1 from public.order_claim_units
               where claim_id = p_claim_id and role = 'reemplazo' and location = 'reservada') then
      raise exception 'CLAIM_LOGISTICS_RESERVATION_ACTIVE';
    end if;
    if exists (select 1 from public.order_credit_notes
               where claim_id = p_claim_id and status in ('processing', 'authorized')) then
      raise exception 'CLAIM_LOGISTICS_CREDIT_NOTE_ACTIVE';
    end if;
  end if;

  v_leg := public.open_order_claim_leg(v_claim, p_direction, p_actor_id, v_branch_id, p_branch_name, p_branch_address);
  if p_direction in ('devolucion', 'cambio') and not exists (
    select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original' and location = 'con_cliente'
  ) then
    raise exception 'CLAIM_LOGISTICS_NOT_NEEDED';
  end if;
  perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_plan_selected',
    jsonb_build_object('plan', v_new_plan, 'direction', p_direction, 'shipmentId', v_leg.id, 'branchId', v_leg.branch_id,
      'notes', nullif(left(v_note, 1000), '')));
  return v_leg;
end;
$$;

-- Reemplazo sin devolución: dispensa la devolución de TODAS las unidades
-- reclamadas (el cliente las conserva) y abre el envío del reemplazo, en una
-- sola transacción. Sólo antes de cualquier operación Andreani real, sin
-- reservas, sin NC y sin incidencias. Reintentar devuelve el mismo tramo.
create or replace function public.request_order_claim_resend_without_return(
  p_claim_id bigint,
  p_actor_id uuid,
  p_note text,
  p_branch_id text,
  p_branch_name text,
  p_branch_address text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_open public.order_claim_shipments%rowtype;
  v_note text := btrim(coalesce(p_note, ''));
  v_count integer;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if length(v_note) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  if nullif(btrim(coalesce(p_branch_id, '')), '') is null then raise exception 'CLAIM_LOGISTICS_BRANCH_REQUIRED'; end if;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if not public.order_claim_is_accepted(v_claim) or v_claim.resolution is distinct from 'cambio_producto' then
    raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
  end if;

  -- Reintento: la devolución ya se dispensó; request_order_claim_logistics
  -- devuelve el tramo abierto (o abre el siguiente intento).
  if public.order_claim_return_waived(p_claim_id) then
    return public.request_order_claim_logistics(p_claim_id, p_actor_id, 'reemplazo', v_note, p_branch_id, p_branch_name, p_branch_address);
  end if;

  if v_claim.logistics_legacy and (
    exists (select 1 from public.order_replacements where claim_id = p_claim_id)
    or exists (
      select 1 from public.inventory_return_movements m
      where m.order_id = v_claim.order_id and m.created_at >= v_claim.created_at
        and m.order_item_id in (select (x->>'order_item_id')::bigint from jsonb_array_elements(v_claim.affected_items) x)
    )
  ) then
    raise exception 'CLAIM_LOGISTICS_LEGACY';
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open)
     or exists (select 1 from public.order_claim_shipments where claim_id = p_claim_id and review_required) then
    raise exception 'CLAIM_LOGISTICS_INCIDENT';
  end if;
  if exists (select 1 from public.order_claim_shipments
             where claim_id = p_claim_id and status <> 'cancelada' and creation_status in ('processing', 'created', 'manual_review')) then
    raise exception 'CLAIM_RETURN_ALREADY_STARTED';
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'reemplazo') then
    raise exception 'CLAIM_LOGISTICS_RESERVATION_ACTIVE';
  end if;
  if exists (select 1 from public.order_credit_notes where claim_id = p_claim_id and status in ('processing', 'authorized')) then
    raise exception 'CLAIM_LOGISTICS_CREDIT_NOTE_ACTIVE';
  end if;

  -- Un tramo pendiente que nunca llegó a Andreani se cancela (auditado).
  select * into v_open from public.order_claim_shipments
  where claim_id = p_claim_id and closed_at is null order by id desc limit 1 for update;
  if found then
    if v_open.legacy or v_open.status <> 'pendiente' or v_open.creation_status not in ('not_started', 'failed') then
      raise exception 'CLAIM_LOGISTICS_OPEN';
    end if;
    update public.order_claim_shipments
    set status = 'cancelada', closed_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_open.id;
    perform public.release_order_claim_leg_units(v_open.id);
    perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_cancelled',
      jsonb_build_object('shipmentId', v_open.id, 'direction', v_open.direction, 'reason', 'return_waived',
        'notes', left(v_note, 1000)));
  end if;

  perform public.ensure_order_claim_original_units(v_claim);
  if exists (select 1 from public.order_claim_units
             where claim_id = p_claim_id and role = 'original' and location <> 'con_cliente') then
    raise exception 'CLAIM_RETURN_ALREADY_STARTED';
  end if;
  update public.order_claim_units set location = 'conservada_cliente', updated_at = clock_timestamp()
  where claim_id = p_claim_id and role = 'original' and location = 'con_cliente';
  get diagnostics v_count = row_count;
  perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_original_return_waived',
    jsonb_build_object('mode', 'before_resend', 'quantity', v_count, 'notes', left(v_note, 1000)));
  perform public.post_order_claim_system_message(p_claim_id, 'resend_without_return',
    'No hace falta que devuelvas el producto. Te vamos a enviar el reemplazo a una sucursal Andreani y te avisamos cuando esté en camino.');

  return public.request_order_claim_logistics(p_claim_id, p_actor_id, 'reemplazo', v_note, p_branch_id, p_branch_name, p_branch_address);
end;
$$;

-- Igual a 20261001100000 salvo la recepción previa: con la devolución
-- dispensada (order_claim_return_waived) el reemplazo se reserva sin que el
-- original vuelva, igual que el intercambio simultáneo.
create or replace function public.create_order_replacement(
  p_original_order_id bigint, p_original_order_item_id bigint,
  p_replacement_variant_id bigint, p_quantity integer, p_reason text,
  p_actor_id uuid, p_idempotency_key text,
  p_condition_note text default null, p_notes text default null, p_claim_id bigint default null
) returns public.order_replacements language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_existing public.order_replacements;
  v_item public.orden_items;
  v_claim public.order_claims;
  v_used integer;
  v_claimed integer;
  v_claim_used integer;
  v_exchange boolean := false;
  v_waived boolean := false;
  v_result public.order_replacements;
begin
  if auth.role() is distinct from 'service_role' or not exists (
    select 1 from public.profiles where id = p_actor_id and rol in ('admin','super_admin')
  ) then raise exception 'REPLACEMENT_FORBIDDEN'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    raise exception 'REPLACEMENT_IDEMPOTENCY_KEY_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('replacement:' || p_idempotency_key, 0));
  select * into v_existing from public.order_replacements where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.original_order_id <> p_original_order_id or v_existing.original_order_item_id <> p_original_order_item_id
      or v_existing.replacement_variant_id <> p_replacement_variant_id or v_existing.quantity <> p_quantity
      or v_existing.reason <> p_reason or v_existing.created_by <> p_actor_id
      or v_existing.claim_id is distinct from p_claim_id then raise exception 'REPLACEMENT_CONFLICT'; end if;
    return v_existing;
  end if;

  if p_claim_id is not null then
    select * into v_claim from public.order_claims where id = p_claim_id and order_id = p_original_order_id for update;
    if not found or v_claim.status in ('recibido','en_revision','falta_informacion','cerrado','rechazado')
       or coalesce(v_claim.resolution, '') not in ('cambio_producto', 'envio_unidad_faltante') then
      raise exception 'REPLACEMENT_INVALID_CLAIM';
    end if;
    select sum((x->>'quantity')::integer) into v_claimed from jsonb_array_elements(v_claim.affected_items) x
    where (x->>'order_item_id')::bigint = p_original_order_item_id;
    if v_claimed is null then raise exception 'REPLACEMENT_INVALID_ITEM'; end if;
    if exists (select 1 from public.order_claim_shipments
               where claim_id = p_claim_id and closed_at is null and direction in ('cambio', 'reemplazo')
                 and creation_status in ('processing', 'created', 'manual_review')) then
      raise exception 'REPLACEMENT_LOGISTICS_LOCKED';
    end if;
    v_exchange := exists (select 1 from public.order_claim_shipments
                          where claim_id = p_claim_id and closed_at is null and direction = 'cambio' and status = 'pendiente');
    v_waived := public.order_claim_return_waived(p_claim_id);
    if not v_claim.logistics_legacy and v_claim.resolution = 'cambio_producto'
       and coalesce(v_claim.failure_type, '') not in ('faltante', 'cantidad_menor')
       and not exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original') then
      raise exception 'REPLACEMENT_REQUIRES_PLAN';
    end if;
    if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original') then
      if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open) then
        raise exception 'REPLACEMENT_REQUIRES_INSPECTION';
      end if;
      if not exists (select 1 from public.order_claim_shipments
                     where claim_id = p_claim_id and closed_at is null and status = 'pendiente'
                       and direction in ('cambio', 'reemplazo')) then
        raise exception 'REPLACEMENT_REQUIRES_PLAN';
      end if;
      if exists (select 1 from public.order_claim_shipments
                 where claim_id = p_claim_id and closed_at is null and direction = 'reemplazo')
         and not public.order_claim_originals_inspected(p_claim_id) then
        raise exception 'REPLACEMENT_REQUIRES_INSPECTION';
      end if;
    end if;
  end if;

  select * into v_item from public.orden_items where id = p_original_order_item_id and orden_id = p_original_order_id for update;
  if not found then raise exception 'REPLACEMENT_INVALID_ITEM'; end if;
  select coalesce(sum(quantity - reverted_quantity),0) into v_used
  from public.order_replacements where original_order_item_id = p_original_order_item_id;
  if p_quantity is null or p_quantity <= 0 or p_quantity + v_used > v_item.cantidad then
    raise exception 'REPLACEMENT_QUANTITY_EXCEEDED';
  end if;
  if p_claim_id is not null then
    select coalesce(sum(quantity - reverted_quantity),0) into v_claim_used
    from public.order_replacements where claim_id = p_claim_id and original_order_item_id = p_original_order_item_id;
    if p_quantity + v_claim_used > v_claimed then raise exception 'REPLACEMENT_QUANTITY_EXCEEDED'; end if;
  end if;
  if p_reason <> 'garantia' and not v_exchange and not v_waived
     and p_quantity + v_used > coalesce(v_item.return_restocked_quantity,0) + coalesce(v_item.return_written_off_quantity,0) then
    raise exception 'REPLACEMENT_REQUIRES_RECEIVED_ITEM';
  end if;
  if not exists (select 1 from public.producto_variantes v join public.productos p on p.id = v.producto_id
    where v.id = p_replacement_variant_id and v.activo and p.activo) then raise exception 'REPLACEMENT_UNAVAILABLE'; end if;
  v_result := public.create_order_replacement_internal(p_original_order_id,p_original_order_item_id,p_replacement_variant_id,
    p_quantity,p_reason,p_actor_id,p_idempotency_key,p_condition_note,p_notes,p_claim_id);
  return v_result;
end;
$$;

-- 3. Resumen congelado con nombres comerciales ---------------------------------

-- Igual a 20261001130000 salvo los nombres: "Reemplazo del producto" y
-- "Saldo a favor" (nunca "Nota de crédito" para el cliente).
create or replace function public.build_order_claim_resolution_summary(p_claim public.order_claims)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_amount numeric;
  v_reason text := nullif(btrim(coalesce(p_claim.rejection_reason, '')), '');
  v_response text := nullif(btrim(coalesce(p_claim.admin_response, '')), '');
begin
  if p_claim.status not in ('cerrado', 'rechazado') then
    return null;
  end if;

  if p_claim.cancelled_at is not null then
    return jsonb_build_object(
      'kind', 'cancelado', 'label', 'Reclamo cancelado',
      'detail', 'Motivo: ' || btrim(p_claim.cancellation_reason),
      'amount', null, 'notice', 'El reclamo fue cancelado.'
    );
  end if;

  if p_claim.failure_type = 'consulta_pedido' then
    return jsonb_build_object(
      'kind', 'consulta',
      'label', case when p_claim.status = 'cerrado' then 'Consulta resuelta' else 'Consulta cerrada' end,
      'detail', null, 'amount', null,
      'notice', 'BEYONIX finalizó tu consulta.'
    );
  end if;

  if p_claim.failure_type = 'cancelar_compra' then
    if p_claim.status = 'rechazado' then
      return jsonb_build_object(
        'kind', 'cancelacion_rechazada', 'label', 'Cancelación no aprobada',
        'detail', case when v_reason is not null then 'Motivo: ' || v_reason end,
        'amount', null, 'notice', 'La cancelación no fue aprobada.'
      );
    end if;
    return jsonb_build_object(
      'kind', 'cancelacion', 'label', 'Cancelación aprobada',
      'detail', v_response, 'amount', null, 'notice', 'La cancelación fue aprobada.'
    );
  end if;

  if p_claim.status = 'rechazado' then
    return jsonb_build_object(
      'kind', 'rechazado', 'label', 'Reclamo no aprobado',
      'detail', case when v_reason is not null then 'Motivo: ' || v_reason end,
      'amount', null, 'notice', 'El reclamo no fue aprobado.'
    );
  end if;

  if p_claim.resolution = 'cambio_producto' then
    return jsonb_build_object(
      'kind', 'cambio_producto', 'label', 'Reemplazo del producto',
      'detail', 'Se registró el reemplazo correspondiente.',
      'amount', null, 'notice', 'Se resolvió con el reemplazo del producto.'
    );
  end if;

  if p_claim.resolution = 'envio_unidad_faltante' then
    return jsonb_build_object(
      'kind', 'envio_unidad_faltante', 'label', 'Envío de unidad faltante',
      'detail', 'Se registró el envío de la unidad faltante.',
      'amount', null, 'notice', 'Se registró el envío de la unidad faltante.'
    );
  end if;

  if p_claim.resolution in ('saldo_a_favor', 'cupon_descuento') then
    select sum(total_amount) into v_amount
    from public.order_credit_notes
    where claim_id = p_claim.id and status = 'authorized'
      and destination = 'customer_balance' and settlement_status = 'completado';
    return jsonb_build_object(
      'kind', p_claim.resolution,
      'label', 'Saldo a favor',
      'detail', case when v_amount > 0
        then 'Se acreditaron ' || public.format_claim_resolution_amount(v_amount) || ' en tu cuenta BEYONIX.'
        else 'Se acreditó saldo a favor en tu cuenta BEYONIX.' end,
      'amount', case when v_amount > 0 then v_amount end,
      'notice', 'Se acreditó saldo a favor en tu cuenta.'
    );
  end if;

  if p_claim.resolution in ('reintegro_total', 'reintegro_parcial') then
    select sum(total_amount) into v_amount
    from public.order_credit_notes
    where claim_id = p_claim.id and status = 'authorized'
      and destination = 'external_refund' and settlement_status = 'completado';
    return jsonb_build_object(
      'kind', p_claim.resolution,
      'label', case when p_claim.resolution = 'reintegro_total' then 'Reintegro total' else 'Reintegro parcial' end,
      'detail', case when v_amount > 0
        then 'Se gestionó un reintegro por ' || public.format_claim_resolution_amount(v_amount) || '.'
        else 'Se gestionó el reintegro correspondiente.' end,
      'amount', case when v_amount > 0 then v_amount end,
      'notice', 'Se gestionó un reintegro.'
    );
  end if;

  if p_claim.resolution = 'otro' then
    return jsonb_build_object(
      'kind', 'otro', 'label', 'Otra solución', 'detail', v_response,
      'amount', null, 'notice', 'BEYONIX aplicó una solución a tu reclamo.'
    );
  end if;

  return null;
end;
$$;

-- Permisos -----------------------------------------------------------------------

revoke all on function public.claim_resolution_allows_credit_note(text, text) from public, anon, authenticated;
revoke all on function public.guard_claim_credit_note_resolution() from public, anon, authenticated;
revoke all on function public.order_claim_return_waived(bigint) from public, anon, authenticated;
revoke all on function public.request_order_claim_logistics(bigint, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_order_claim_logistics(bigint, uuid, text, text, text, text, text) to service_role;
revoke all on function public.request_order_claim_resend_without_return(bigint, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_order_claim_resend_without_return(bigint, uuid, text, text, text, text) to service_role;
revoke all on function public.create_order_replacement(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.create_order_replacement(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint) to service_role;
revoke all on function public.build_order_claim_resolution_summary(public.order_claims) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
