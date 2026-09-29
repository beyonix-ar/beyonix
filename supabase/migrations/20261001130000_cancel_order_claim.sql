-- "Cancelar reclamo": interrumpir un reclamo en curso (distinto de rechazarlo
-- -no corresponde- o finalizarlo -solución aplicada-).
--
-- Modelo: estado terminal 'cerrado' + cancelled_at / cancelled_by /
-- cancellation_reason. Así todas las reglas terminales existentes (un reclamo
-- activo por pedido, guardas de logística, liberación de unidades, vistas del
-- cliente, avisos) siguen valiendo sin reescribirlas; la interfaz lo muestra
-- como "Cancelado" y el resumen congelado es kind 'cancelado'.
--
-- La base es la autoridad: sólo Admin, motivo obligatorio, CAS por
-- updated_at, idempotente (un segundo intento devuelve el mismo reclamo sin
-- duplicar aviso ni auditoría) y nunca con efectos reales pendientes
-- (order_claim_cancellation_blockers). Idempotente como migración.

alter table public.order_claims
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users(id),
  add column if not exists cancellation_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_claims_cancellation_consistent') then
    alter table public.order_claims add constraint order_claims_cancellation_consistent check (
      cancelled_at is null
      or (status = 'cerrado' and cancelled_by is not null and length(btrim(coalesce(cancellation_reason, ''))) >= 10)
    );
  end if;
end;
$$;

-- Resumen congelado: igual a 20260924160000 + la rama 'cancelado'.
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
      'kind', 'cambio_producto', 'label', 'Cambio de producto',
      'detail', 'Se registró el reemplazo correspondiente.',
      'amount', null, 'notice', 'Se aprobó un cambio de producto.'
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
      'label', case when p_claim.resolution = 'saldo_a_favor' then 'Saldo a favor' else 'Nota de crédito' end,
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

-- Qué impide cancelar el reclamo hoy (códigos; la aplicación los traduce).
-- Mismos hechos que usan las guardas de cierre, NC y reintegro.
create or replace function public.order_claim_cancellation_blockers(p_claim_id bigint)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_blockers text[] := '{}';
  v_refund boolean := false;
begin
  select * into v_claim from public.order_claims where id = p_claim_id;
  if not found then return v_blockers; end if;

  if exists (select 1 from public.order_claim_shipments
             where claim_id = p_claim_id and creation_status in ('processing', 'manual_review')) then
    v_blockers := array_append(v_blockers, 'andreani_uncertain');
  end if;
  if exists (select 1 from public.order_claim_shipments
             where claim_id = p_claim_id and closed_at is null and creation_status = 'created') then
    v_blockers := array_append(v_blockers, 'andreani_open');
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'reemplazo' and location = 'reservada') then
    v_blockers := array_append(v_blockers, 'reservation');
  end if;
  if exists (select 1 from public.order_claim_units
             where claim_id = p_claim_id and role = 'reemplazo' and location in ('en_andreani', 'recibida_beyonix')) then
    v_blockers := array_append(v_blockers, 'replacement_in_transit');
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'reemplazo' and location = 'entregada_cliente')
     or (not exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'reemplazo')
         and exists (select 1 from public.order_replacements
                     where claim_id = p_claim_id and quantity - coalesce(reverted_quantity, 0) > 0)) then
    v_blockers := array_append(v_blockers, 'replacement_delivered');
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original' and location = 'en_andreani') then
    v_blockers := array_append(v_blockers, 'return_in_transit');
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original' and location = 'recibida_beyonix') then
    v_blockers := array_append(v_blockers, 'inspection_pending');
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open)
     or exists (select 1 from public.order_claim_shipments where claim_id = p_claim_id and review_required) then
    v_blockers := array_append(v_blockers, 'incident');
  end if;
  if exists (select 1 from public.order_credit_notes where claim_id = p_claim_id and status = 'processing') then
    v_blockers := array_append(v_blockers, 'credit_note_pending');
  end if;
  if exists (select 1 from public.order_credit_notes where claim_id = p_claim_id and status = 'authorized') then
    v_blockers := array_append(v_blockers, 'credit_note_issued');
  end if;
  if exists (select 1 from public.customer_credit_movements where claim_id = p_claim_id) then
    v_blockers := array_append(v_blockers, 'credit_applied');
  end if;
  -- Refund real de Mercado Pago del pedido en curso (la tabla puede no existir en entornos parciales).
  if to_regclass('public.mercadopago_order_refunds') is not null then
    execute 'select exists (select 1 from public.mercadopago_order_refunds where order_id = $1 and status in (''processing'', ''requested''))'
      into v_refund using v_claim.order_id;
    if v_refund then v_blockers := array_append(v_blockers, 'refund_pending'); end if;
  end if;
  return v_blockers;
end;
$$;

create or replace function public.cancel_order_claim(
  p_claim_id bigint,
  p_actor_id uuid,
  p_expected_updated_at timestamptz,
  p_reason text
)
-- applied = esta llamada canceló el reclamo (un reintento devuelve false:
-- el servidor no repite el email).
returns table (claim_id bigint, applied boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_claim public.order_claims%rowtype;
  v_result public.order_claims%rowtype;
  v_role text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_blockers text[];
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CLAIM_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id = p_actor_id;
  if coalesce(v_role, '') not in ('admin', 'super_admin') then raise exception 'CLAIM_FORBIDDEN'; end if;
  if length(v_reason) < 10 or length(v_reason) > 1000 then raise exception 'CLAIM_CANCEL_REASON_REQUIRED'; end if;

  -- Mismo orden de locks que mutate_admin_order_claim: pedido -> reclamo.
  perform 1 from public.ordenes where id = (select order_id from public.order_claims where id = p_claim_id) for update;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  -- Doble click / dos Admin: el segundo recibe el reclamo ya cancelado, sin duplicar efectos.
  if v_claim.cancelled_at is not null then
    return query select v_claim.id, false;
    return;
  end if;
  if v_claim.status in ('cerrado', 'rechazado') then raise exception 'CLAIM_TERMINAL'; end if;
  if coalesce(v_claim.failure_type, '') in ('consulta_pedido', 'cancelar_compra') then raise exception 'CLAIM_CANCEL_NOT_ALLOWED'; end if;
  if p_expected_updated_at is null or v_claim.updated_at <> p_expected_updated_at then raise exception 'CLAIM_CONFLICT'; end if;

  v_blockers := public.order_claim_cancellation_blockers(v_claim.id);
  if coalesce(array_length(v_blockers, 1), 0) > 0 then
    raise exception 'CLAIM_CANCEL_BLOCKED' using detail = array_to_string(v_blockers, ',');
  end if;

  -- Cierre terminal: los triggers existentes congelan el resumen ('cancelado'),
  -- dejan con el cliente lo que nunca salió y cancelan tramos que nunca
  -- llegaron a Andreani; la guarda de logística vuelve a validar el cierre.
  update public.order_claims
  set status = 'cerrado', closed_at = now(), cancelled_at = now(), cancelled_by = p_actor_id,
      cancellation_reason = left(v_reason, 1000), admin_needs_action = false
  where id = v_claim.id
  returning * into v_result;

  -- Aviso al cliente: notificación propia (antes del mensaje, que así no
  -- genera la genérica de "resuelto") + mensaje en el chat del reclamo.
  if v_claim.user_id is not null then
    insert into public.customer_notifications(user_id, type, title, body, action_url, order_id, source_key)
    values (v_claim.user_id, 'claim_resolved', 'Tu reclamo fue cancelado',
      'BEYONIX canceló tu reclamo del pedido #BX-' || (1000 + v_claim.order_id) || '. Motivo: ' || left(v_reason, 300),
      '/cuenta/compras/' || v_claim.order_id || '/ayuda', v_claim.order_id, 'claim-resolved:' || v_claim.id)
    on conflict (source_key) do nothing;
  end if;
  insert into public.order_claim_messages(claim_id, author_user_id, author_role, message)
  values (v_claim.id, p_actor_id, 'admin', 'BEYONIX canceló el reclamo.' || E'\n' || 'Motivo: ' || left(v_reason, 1000));

  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (v_claim.order_id, 'admin', p_actor_id, 'claim_cancelled', v_claim.status, 'cancelado',
    jsonb_build_object('claimId', v_claim.id, 'reason', left(v_reason, 1000), 'previousResolution', v_claim.resolution,
      'cancelledAt', v_result.cancelled_at, 'storedStatus', 'cerrado'));

  return query select v_claim.id, true;
end;
$$;

revoke all on function public.order_claim_cancellation_blockers(bigint) from public, anon, authenticated;
revoke all on function public.cancel_order_claim(bigint, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.order_claim_cancellation_blockers(bigint) to service_role;
grant execute on function public.cancel_order_claim(bigint, uuid, timestamptz, text) to service_role;

notify pgrst, 'reload schema';
