-- Resolución visible del reclamo + notificación específica de cierre.
--
-- Hasta ahora el cierre dejaba "BEYONIX finalizó el reclamo." y el trigger de
-- mensajes lo notificaba como una respuesta más ("BEYONIX respondió tu
-- reclamo"): el cliente no sabía cómo se resolvió su problema.
--
-- Fuente de verdad (no se inventa otra):
--   * order_claims.status / resolution / rejection_reason / admin_response;
--   * montos: order_credit_notes autorizadas y liquidadas del reclamo
--     (las mismas que exigen mark_credit_note_issued y mark_refund_done).
--
-- Al pasar a un estado terminal se congela order_claims.resolution_summary
-- (jsonb con sólo información destinada al cliente). Lo usan el mensaje
-- automático de cierre, la notificación de campana, Mis compras, el panel
-- admin y el historial. Reclamos históricos: resolution_summary queda NULL
-- (sin backfill) y la interfaz muestra "Reclamo finalizado".
--
-- Política de notificaciones:
--   * mensaje de BEYONIX fuera del cierre -> "BEYONIX respondió tu reclamo"
--     (consolidada por pedido, sin cambios);
--   * mensaje insertado en la MISMA transacción que cierra/rechaza el
--     reclamo -> una única "Tu reclamo fue resuelto" (source_key
--     claim-resolved:<id>), nunca además la de "respondió".

begin;

alter table public.order_claims
  add column if not exists resolution_summary jsonb;

comment on column public.order_claims.resolution_summary is
  'Resolución comunicable al cliente, congelada al cerrar/rechazar (kind, label, detail, amount, notice). NULL en reclamos abiertos e históricos.';

-- $ 27.900 / $ 27.900,50 (formato es-AR sin depender del locale del servidor).
create or replace function public.format_claim_resolution_amount(p_amount numeric)
returns text
language sql
immutable
set search_path to 'pg_catalog', 'public'
as $$
  select '$' || regexp_replace(
    translate(to_char(round(p_amount, 2), 'FM999,999,999,990.00'), ',.', '.,'),
    ',00$', ''
  )
$$;

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

-- Congela el resumen en el mismo UPDATE que cierra o rechaza, sea cual sea la
-- ruta (mutate_admin_order_claim, approve_order_claim_cancellation,
-- close_mercadopago_order_refund_claim).
create or replace function public.freeze_order_claim_resolution_summary()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
begin
  if new.status in ('cerrado', 'rechazado') and old.status is distinct from new.status then
    new.resolution_summary := public.build_order_claim_resolution_summary(new);
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_order_claim_resolution_summary_trigger on public.order_claims;
create trigger freeze_order_claim_resolution_summary_trigger
before update of status on public.order_claims
for each row execute function public.freeze_order_claim_resolution_summary();

-- Mensaje automático de cierre de un reclamo formal.
create or replace function public.order_claim_resolution_message(p_summary jsonb)
returns text
language sql
immutable
set search_path to 'pg_catalog', 'public'
as $$
  select case
    when p_summary is null or nullif(p_summary->>'label', '') is null then 'BEYONIX finalizó el reclamo.'
    else 'BEYONIX resolvió el reclamo.' || E'\n' || 'Resolución: ' || (p_summary->>'label') || '.'
      || coalesce(E'\n' || nullif(p_summary->>'detail', ''), '')
  end
$$;

revoke all on function public.format_claim_resolution_amount(numeric) from public, anon, authenticated;
revoke all on function public.build_order_claim_resolution_summary(public.order_claims) from public, anon, authenticated;
revoke all on function public.freeze_order_claim_resolution_summary() from public, anon, authenticated;
revoke all on function public.order_claim_resolution_message(jsonb) from public, anon, authenticated;

-- Igual a 20260924150000 salvo el mensaje de cierre de reclamos formales:
-- un único mensaje con la resolución (más el texto del admin si lo escribió).
create or replace function public.mutate_admin_order_claim(p_claim_id bigint,p_actor_id uuid,p_expected_updated_at timestamptz,p_patch jsonb)
returns public.order_claims language plpgsql security definer set search_path=public as $$
declare
  v_claim public.order_claims%rowtype;
  v_order public.ordenes%rowtype;
  v_role text;
  v_status text;
  v_resolution text;
  v_action text:=coalesce(p_patch->>'action','update');
  v_message text:=btrim(coalesce(p_patch->>'admin_response',''));
  v_before text;
  v_items jsonb;
  v_item jsonb;
  v_allowed text[];
  v_closed public.order_claims%rowtype;
  v_close_message text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CLAIM_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id=p_actor_id;
  if coalesce(v_role,'') not in ('operador','admin','super_admin') then raise exception 'CLAIM_FORBIDDEN'; end if;
  select * into v_order from public.ordenes where id=(select order_id from public.order_claims where id=p_claim_id) for update;
  select * into v_claim from public.order_claims where id=p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if p_expected_updated_at is null or v_claim.updated_at<>p_expected_updated_at then raise exception 'CLAIM_CONFLICT'; end if;
  if v_claim.status in ('cerrado','rechazado') then raise exception 'CLAIM_TERMINAL'; end if;
  if length(v_message)>2000 then raise exception 'CLAIM_INVALID'; end if;
  v_before:=v_claim.status;
  v_status:=coalesce(p_patch->>'status',v_claim.status);
  v_resolution:=coalesce(p_patch->>'resolution',v_claim.resolution);
  if exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and status in ('processing','authorized')) and
    (v_resolution is distinct from v_claim.resolution or v_status='rechazado') then raise exception 'CLAIM_RESOLUTION_LOCKED'; end if;
  if v_status='cerrado' and exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and
    (status='processing' or status='authorized' and settlement_status is distinct from 'completado')) then raise exception 'CLAIM_CREDIT_PENDING'; end if;
  -- Las consultas y cancelaciones conservan su circuito propio.
  if v_claim.failure_type='consulta_pedido' and
    (v_action<>'update' or v_status not in ('recibido','en_revision','falta_informacion','cerrado','rechazado') or coalesce(v_resolution,'otro') not in ('otro','rechazado')) then raise exception 'CLAIM_INVALID'; end if;
  if v_claim.failure_type='cancelar_compra' and v_action='update' and
    (v_status is distinct from v_claim.status and v_status not in ('en_revision','falta_informacion') or v_resolution is distinct from v_claim.resolution) then raise exception 'CLAIM_CANCELLATION_ACTION'; end if;
  if v_action='affected_items' then
    if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
    if coalesce(v_claim.failure_type,'') in ('consulta_pedido','cancelar_compra') then raise exception 'CLAIM_INVALID'; end if;
    v_items:=p_patch->'items';
    if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items)=0 or (select count(distinct x->>'order_item_id') from jsonb_array_elements(v_items) x)<>jsonb_array_length(v_items) then raise exception 'CLAIM_INVALID_ITEMS'; end if;
    perform id from public.orden_items where orden_id=v_order.id order by id for update;
    if exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and status in ('processing','authorized')) then raise exception 'CLAIM_ITEMS_LOCKED'; end if;
    for v_item in select * from jsonb_array_elements(v_items) loop
      if not exists(select 1 from public.orden_items where id=(v_item->>'order_item_id')::bigint and orden_id=v_order.id and (v_item->>'quantity')::integer between 1 and cantidad) then raise exception 'CLAIM_INVALID_ITEMS'; end if;
    end loop;
    if exists(select 1 from public.orden_items i where i.orden_id=v_order.id and i.return_inventory_processed_at is not null and
      (select x->>'quantity' from jsonb_array_elements(v_claim.affected_items) x where (x->>'order_item_id')::bigint=i.id) is distinct from
      (select x->>'quantity' from jsonb_array_elements(v_items) x where (x->>'order_item_id')::bigint=i.id)) then raise exception 'CLAIM_ITEMS_LOCKED'; end if;
    update public.order_claims set affected_items=v_items,affected_items_updated_at=now(),affected_items_updated_by=p_actor_id where id=v_claim.id;
  else
    if v_action='approve_cancellation' then
      if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
      perform public.approve_order_claim_cancellation(v_claim.id,p_actor_id,v_role,v_message);
      v_status:='cerrado'; v_resolution:='otro'; v_message:='';
    elsif v_action='reject_cancellation' then
      if v_claim.failure_type is distinct from 'cancelar_compra' or length(v_message)<5 then raise exception 'CLAIM_INVALID'; end if;
      v_status:='rechazado'; v_resolution:='rechazado';
    elsif v_action='mark_credit_note_issued' then
      if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
      if coalesce(v_claim.resolution,'') not in ('cupon_descuento','saldo_a_favor') or not exists(
        select 1 from public.order_credit_notes n join public.customer_credit_movements m on m.order_id=n.order_id and m.claim_id=n.claim_id
        where n.claim_id=v_claim.id and n.status='authorized' and n.destination='customer_balance' and n.cae is not null and n.settlement_status='completado' and m.source_type='credit_note' and m.movement_type='credit'
      ) or exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and (status='processing' or status='authorized' and settlement_status is distinct from 'completado')) then raise exception 'CLAIM_CREDIT_PENDING'; end if;
      v_status:='cerrado'; v_resolution:=v_claim.resolution;
      v_message:='La nota de crédito fue autorizada y el saldo ya está acreditado en tu cuenta.';
    elsif v_action='mark_refund_done' then
      if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
      if coalesce(v_claim.resolution,'') not in ('reintegro_total','reintegro_parcial') or v_order.financial_status is distinct from 'refunded' or not exists(
        select 1 from public.order_credit_notes n join public.order_refund_proofs f on f.order_id=n.order_id and f.id::text=n.settlement_reference where n.claim_id=v_claim.id and n.status='authorized' and n.destination='external_refund' and n.settlement_status='completado' and n.cae is not null
      ) or exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and (status='processing' or status='authorized' and settlement_status is distinct from 'completado')) then raise exception 'CLAIM_REFUND_PENDING'; end if;
      v_status:='cerrado'; v_resolution:=v_claim.resolution;
      v_message:='El reintegro fue registrado. Podés consultar el comprobante desde el detalle de tu compra.';
    elsif v_action<>'update' then raise exception 'CLAIM_INVALID';
    end if;
    v_allowed:=case v_claim.status
      when 'recibido' then array['en_revision','falta_informacion','aprobado','reintegro_pendiente','rechazado','cerrado']
      when 'en_revision' then array['falta_informacion','aprobado','reintegro_pendiente','rechazado','cerrado']
      when 'falta_informacion' then array['en_revision','aprobado','reintegro_pendiente','rechazado','cerrado']
      when 'aprobado' then array['cambio_pendiente','cupon_pendiente','rechazado','cerrado']
      else array['cerrado','rechazado'] end;
    if v_status<>v_claim.status and not v_status=any(v_allowed) then raise exception 'CLAIM_TRANSITION'; end if;
    if v_role='operador' and (p_patch ? 'credit_note_amount' or ((v_resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento','cambio_producto','envio_unidad_faltante') or v_claim.resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento','cambio_producto','envio_unidad_faltante')) and (v_status<>v_claim.status or v_resolution is distinct from v_claim.resolution))) then raise exception 'CLAIM_FORBIDDEN'; end if;
    -- El cierre genérico y la confirmación de entrega comparten esta RPC.
    -- También protege un PATCH que intenta cambiar la resolución al cerrar.
    if v_status='cerrado' and (v_resolution='cambio_producto' or v_claim.resolution='cambio_producto') then
      if not exists (
        select 1
        from public.order_replacements r
        join public.orden_items i on i.id=r.original_order_item_id and i.orden_id=v_claim.order_id
        where r.original_order_id=v_claim.order_id and r.quantity>0
          and exists (
            select 1 from jsonb_array_elements(v_claim.affected_items) item
            where item->>'order_item_id'=i.id::text and (item->>'quantity')::numeric>0
          )
          and (
            r.claim_id=v_claim.id
            or (r.claim_id is null and not exists (
              -- Sólo el único reclamo formal puede usar registros históricos.
              select 1 from public.order_claims other_claim
              where other_claim.order_id=v_claim.order_id and other_claim.id<>v_claim.id
                and coalesce(other_claim.failure_type,'') not in ('consulta_pedido','cancelar_compra')
            ))
          )
      ) then raise exception 'CLAIM_REPLACEMENT_REQUIRED'; end if;
    end if;
    if v_claim.resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento') and v_resolution is distinct from v_claim.resolution and v_claim.status not in ('recibido','en_revision','falta_informacion') and
      not (v_status='rechazado' and not exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and status in ('processing','authorized'))) then raise exception 'CLAIM_RESOLUTION_LOCKED'; end if;
    if v_status='cerrado' and v_resolution in ('reintegro_total','reintegro_parcial','saldo_a_favor','cupon_descuento') and v_action not in ('mark_refund_done','mark_credit_note_issued') then raise exception 'CLAIM_ECONOMIC_CLOSE'; end if;
    if v_status in ('aprobado','reintegro_pendiente','cambio_pendiente','cupon_pendiente','cerrado') and (v_resolution is null or v_resolution='rechazado') then raise exception 'CLAIM_INVALID'; end if;
    if v_status='cambio_pendiente' and v_resolution not in ('cambio_producto','envio_unidad_faltante','otro') then raise exception 'CLAIM_INVALID'; end if;
    if v_status='reintegro_pendiente' and v_resolution not in ('reintegro_total','reintegro_parcial') then raise exception 'CLAIM_INVALID'; end if;
    if v_status='cupon_pendiente' and v_resolution not in ('cupon_descuento','saldo_a_favor') then raise exception 'CLAIM_INVALID'; end if;
    if v_resolution='rechazado' and v_status<>'rechazado' then raise exception 'CLAIM_INVALID'; end if;
    if v_status='rechazado' and (v_resolution<>'rechazado' or length(coalesce(nullif(p_patch->>'rejection_reason',''),v_message))<5) then raise exception 'CLAIM_INVALID'; end if;
    if p_patch ? 'credit_note_amount' then
      if v_role='operador' then raise exception 'CLAIM_FORBIDDEN'; end if;
      if v_action<>'update' or v_status<>'aprobado' or v_resolution is distinct from 'cupon_descuento' or exists(select 1 from public.order_credit_notes where claim_id=v_claim.id and status in ('processing','authorized')) then raise exception 'CLAIM_INVALID_AMOUNT'; end if;
      if p_patch->>'credit_note_amount' is null or (p_patch->>'credit_note_amount')::numeric<=0 or (p_patch->>'credit_note_amount')::numeric > v_order.total-coalesce((select sum(total_amount) from public.order_credit_notes where order_id=v_order.id and status in ('processing','authorized')),0) then raise exception 'CLAIM_INVALID_AMOUNT'; end if;
      update public.ordenes set credit_note_required=true,credit_note_amount=(p_patch->>'credit_note_amount')::numeric where id=v_order.id;
    end if;
    if v_action<>'approve_cancellation' then
      update public.order_claims set status=v_status,resolution=v_resolution,
        admin_response=case when p_patch ? 'admin_response' or v_action in ('mark_refund_done','mark_credit_note_issued') then nullif(v_message,'') else admin_response end,
        rejection_reason=case when v_status='rechazado' then coalesce(nullif(p_patch->>'rejection_reason',''),v_message) else rejection_reason end,
        closed_at=case when v_status in ('cerrado','rechazado') then now() else null end,
        refund_completed_at=case when v_action='mark_refund_done' then now() else refund_completed_at end,
        refund_completed_by=case when v_action='mark_refund_done' then p_actor_id else refund_completed_by end,
        first_reviewed_at=case when v_claim.status='recibido' and v_status='en_revision' then now() else first_reviewed_at end,
        first_reviewed_by=case when v_claim.status='recibido' and v_status='en_revision' then p_actor_id else first_reviewed_by end,
        admin_needs_action=case when v_status in ('cerrado','rechazado') or v_status='aprobado' and v_status<>v_claim.status or v_claim.status='recibido' and v_status='en_revision' then false else admin_needs_action end
      where id=v_claim.id
      returning * into v_closed;
      if v_status in ('cerrado','rechazado') and coalesce(v_claim.failure_type,'') not in ('consulta_pedido','cancelar_compra') then
        -- Un solo mensaje de cierre con la resolución congelada. El texto
        -- libre del admin se agrega si lo escribió y no repite el motivo.
        v_close_message:=public.order_claim_resolution_message(v_closed.resolution_summary);
        if v_action='update' and p_patch ? 'admin_response' and length(v_message)>0
          and v_message is distinct from coalesce(v_closed.rejection_reason,'') then
          v_close_message:=v_close_message||E'\n\n'||v_message;
        end if;
        insert into public.order_claim_messages(claim_id,author_user_id,author_role,message) values(v_claim.id,p_actor_id,v_role,v_close_message);
      elsif length(v_message)>0 and (coalesce((p_patch->>'append_message')::boolean,false) or v_message is distinct from v_claim.admin_response) then
        insert into public.order_claim_messages(claim_id,author_user_id,author_role,message) values(v_claim.id,p_actor_id,v_role,v_message);
      elsif v_status in ('cerrado','rechazado') then
        insert into public.order_claim_messages(claim_id,author_user_id,author_role,message) values(v_claim.id,p_actor_id,v_role,case when v_status='cerrado' then 'BEYONIX finalizó el reclamo.' else 'BEYONIX rechazó el reclamo: '||coalesce(p_patch->>'rejection_reason',v_message) end);
      end if;
    end if;
  end if;
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
  values(v_order.id,'admin',p_actor_id,'claim_'||v_action,v_before,v_status,jsonb_build_object('claimId',v_claim.id,'previousResolution',v_claim.resolution,'newResolution',v_resolution,'previousItems',case when v_action='affected_items' then v_claim.affected_items end,'affectedItems',v_items,
    'resolutionLabel',case when v_status in ('cerrado','rechazado') then (select resolution_summary->>'label' from public.order_claims where id=v_claim.id) end));
  select * into v_claim from public.order_claims where id=v_claim.id;
  return v_claim;
end $$;
revoke all on function public.mutate_admin_order_claim(bigint,uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.mutate_admin_order_claim(bigint,uuid,timestamptz,jsonb) to service_role;

-- Igual a 20260924140000 + el cierre: un mensaje insertado en la misma
-- transacción que cerró/rechazó el reclamo (closed_at = now()) genera la
-- notificación de resolución y NO la genérica de respuesta.
create or replace function public.notify_customer_claim_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_title text := 'BEYONIX respondió tu reclamo';
  v_body text;
  v_order_code text;
  v_notice text;
  -- Mismo tipo que customer_notifications.id (uuid en producción).
  v_existing public.customer_notifications.id%type;
begin
  if new.author_role = 'cliente' then return new; end if;
  select * into v_claim from public.order_claims where id = new.claim_id;
  if v_claim.user_id is null then return new; end if;

  v_order_code := '#BX-' || (1000 + v_claim.order_id);

  if v_claim.status in ('cerrado', 'rechazado') and v_claim.closed_at = now() then
    v_notice := nullif(v_claim.resolution_summary->>'notice', '');
    if v_claim.failure_type = 'consulta_pedido' then
      v_title := 'Tu consulta fue resuelta';
      v_body := 'BEYONIX finalizó tu consulta sobre el pedido ' || v_order_code || '.';
    elsif v_claim.failure_type = 'cancelar_compra' then
      v_title := 'Tu solicitud de cancelación fue resuelta';
      v_body := 'BEYONIX resolvió la cancelación del pedido ' || v_order_code || '.' || coalesce(' ' || v_notice, '');
    else
      v_title := 'Tu reclamo fue resuelto';
      v_body := 'BEYONIX resolvió tu reclamo del pedido ' || v_order_code || '.' || coalesce(' ' || v_notice, '');
    end if;
    insert into public.customer_notifications(user_id, type, title, body, action_url, order_id, source_key)
    values (
      v_claim.user_id, 'claim_resolved', v_title, v_body,
      '/cuenta/compras/' || v_claim.order_id || '/ayuda',
      v_claim.order_id, 'claim-resolved:' || v_claim.id
    )
    on conflict (source_key) do nothing;
    return new;
  end if;

  v_body := 'Tenés un nuevo mensaje sobre el pedido ' || v_order_code || '.';

  select id into v_existing
  from public.customer_notifications
  where user_id = v_claim.user_id
    and type = 'claim_response'
    and order_id = v_claim.order_id
    and is_read = false
    and dismissed_at is null
  order by created_at desc
  limit 1;

  if v_existing is not null then
    update public.customer_notifications
    set title = v_title, body = v_body, created_at = now()
    where id = v_existing;
  else
    insert into public.customer_notifications(user_id, type, title, body, action_url, order_id, source_key)
    values (
      v_claim.user_id, 'claim_response', v_title, v_body,
      '/cuenta/compras/' || v_claim.order_id || '/ayuda',
      v_claim.order_id, 'claim-message:' || new.id
    )
    on conflict (source_key) do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.notify_customer_claim_message() from public, anon, authenticated;

-- Igual a 20260924140000: abrir el reclamo marca leídas también las
-- notificaciones de resolución disponibles en ese momento.
create or replace function public.mark_order_claim_customer_read(
  p_claim_id bigint,
  p_user_id uuid,
  p_read_at timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_claim public.order_claims%rowtype;
  v_last_read timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para esta operación.';
  end if;

  select * into v_claim from public.order_claims where id = p_claim_id;
  if not found or v_claim.user_id is distinct from p_user_id or p_read_at is null then
    raise exception 'CLAIM_FORBIDDEN';
  end if;

  insert into public.order_claim_customer_reads as r (claim_id, user_id, last_read_at)
  values (p_claim_id, p_user_id, p_read_at)
  on conflict (claim_id) do update
    set last_read_at = greatest(r.last_read_at, excluded.last_read_at),
        updated_at = now()
  returning r.last_read_at into v_last_read;

  update public.customer_notifications
  set is_read = true
  where user_id = p_user_id
    and type in ('claim_response', 'claim_resolved')
    and order_id = v_claim.order_id
    and is_read = false
    and created_at <= v_last_read;

  return v_last_read;
end;
$$;

revoke all on function public.mark_order_claim_customer_read(bigint, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.mark_order_claim_customer_read(bigint, uuid, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
commit;
