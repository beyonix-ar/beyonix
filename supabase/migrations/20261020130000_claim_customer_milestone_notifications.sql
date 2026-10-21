-- Hitos del reclamo para el cliente: una notificación real en la campana por
-- cada hito importante, generada en UN solo lugar.
--
-- Causa del problema (reemplazo forzado a ENTREGADO sin aviso en la campana):
--   * las transiciones de logística sólo dejaban un mensaje automático en el
--     chat; la campana se enteraba por notify_customer_claim_message como una
--     respuesta genérica ("BEYONIX respondió tu reclamo", tipo claim_response),
--     o actualizaba una respuesta no leída ya existente sin sumar otra;
--   * mark_order_claim_customer_read marca leídas las claim_response y
--     claim_resolved al ver el reclamo: con la pantalla del reclamo abierta
--     (polling), el aviso nacía y se marcaba leído en el mismo instante, y el
--     cierre posterior también, así que la campana no mostraba nada nuevo.
--
-- Ahora:
--   * order_claim_customer_milestone traduce cada system_key a un hito del
--     cliente (espejo de lib/orders/customer-claim-experience.ts);
--   * notify_order_claim_customer_milestone es el ÚNICO lugar que arma y
--     guarda la notificación de un hito (tipo claim_update, CTA al reclamo),
--     idempotente por claim + hito (+ tramo cuando corresponde): el mismo hito
--     informado por Andreani, por una acción de Admin o por un estado forzado
--     genera como máximo UNA notificación, sin decir quién lo registró;
--   * los mensajes automáticos ya no generan "BEYONIX respondió tu reclamo";
--   * el cierre no repite un resultado ya avisado (reemplazo entregado,
--     reintegro o saldo acreditado);
--   * ver el reclamo sólo marca leídas las respuestas escritas (claim_response):
--     los hitos y el cierre quedan sin leer hasta que el cliente abre la campana.
-- No toca ninguna función de logística ni financiera: sólo los disparadores de
-- notificación.

begin;

create or replace function public.order_claim_customer_milestone(p_system_key text)
returns text
language sql
immutable
set search_path to 'pg_catalog', 'public'
as $$
  select case split_part(coalesce(p_system_key, ''), ':', 1)
    when 'change_accepted' then 'approved'
    when 'mixed_resolution_approved' then 'approved'
    when 'return_generated' then 'return_ready'
    when 'return_delivered' then 'product_received'
    when 'original_received' then 'product_received'
    when 'resend_without_return' then 'preparing_replacement'
    when 'exchange_generated' then 'replacement_sent'
    when 'replacement_dispatched' then 'replacement_sent'
    when 'exchange_at_branch' then 'replacement_at_branch'
    when 'exchange_completed' then 'replacement_delivered'
    when 'replacement_delivered' then 'replacement_delivered'
  end
$$;

create or replace function public.notify_order_claim_customer_milestone(
  p_claim public.order_claims,
  p_milestone text,
  p_leg_scope text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := 'BX-' || (1000 + p_claim.order_id);
  v_title text;
  v_body text;
  v_scope text;
  v_id public.customer_notifications.id%type;
begin
  if p_claim.id is null or p_claim.user_id is null or p_milestone is null then return false; end if;

  case p_milestone
    when 'approved' then
      v_title := 'Aprobamos tu reclamo';
      v_body := 'Ya sabemos cómo vamos a resolver tu reclamo del pedido ' || v_code || '.';
    when 'return_ready' then
      v_title := 'Llevá el producto a Andreani';
      v_body := 'Ya podés llevar el producto del pedido ' || v_code || ' a una sucursal Andreani.';
    when 'product_received' then
      v_title := 'Recibimos tu producto';
      v_body := 'Ya tenemos el producto del pedido ' || v_code || '. Lo vamos a revisar.';
    when 'preparing_replacement' then
      v_title := 'Estamos preparando tu reemplazo';
      v_body := 'No hace falta que devuelvas el producto del pedido ' || v_code || '. Te avisamos cuando lo enviemos.';
    when 'replacement_sent' then
      v_title := 'Tu reemplazo está en camino';
      v_body := 'Enviamos el reemplazo de tu pedido ' || v_code || ' a una sucursal Andreani.';
    when 'replacement_at_branch' then
      v_title := 'Tu reemplazo te espera en Andreani';
      v_body := 'El producto nuevo de tu pedido ' || v_code || ' ya está en la sucursal.';
    when 'replacement_delivered' then
      v_title := 'Tu reemplazo fue entregado';
      v_body := 'El reemplazo de tu pedido ' || v_code || ' figura como entregado.';
    else
      return false;
  end case;

  -- Hitos que pasan una sola vez por reclamo; los de envío, una vez por tramo.
  v_scope := case when p_milestone in ('approved', 'product_received', 'preparing_replacement') then null
    else nullif(btrim(coalesce(p_leg_scope, '')), '') end;

  insert into public.customer_notifications(user_id, type, title, body, action_url, order_id, source_key)
  values (
    p_claim.user_id, 'claim_update', v_title, v_body,
    '/cuenta/compras/' || p_claim.order_id || '/ayuda', p_claim.order_id,
    'claim-milestone:' || p_claim.id || ':' || p_milestone || coalesce(':' || v_scope, '')
  )
  on conflict (source_key) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

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
  v_kind text;
  -- Mismo tipo que customer_notifications.id (uuid en producción).
  v_existing public.customer_notifications.id%type;
begin
  if new.author_role = 'cliente' then return new; end if;
  select * into v_claim from public.order_claims where id = new.claim_id;
  if v_claim.user_id is null then return new; end if;

  -- Mensaje automático: es un hito (o nada), nunca una "respuesta".
  if new.system_key is not null then
    perform public.notify_order_claim_customer_milestone(
      v_claim, public.order_claim_customer_milestone(new.system_key),
      nullif(split_part(new.system_key, ':', 2), ''));
    return new;
  end if;

  v_order_code := 'BX-' || (1000 + v_claim.order_id);

  if v_claim.status in ('cerrado', 'rechazado') and v_claim.closed_at = now() then
    v_notice := nullif(v_claim.resolution_summary->>'notice', '');
    v_kind := coalesce(v_claim.resolution_summary->>'kind', v_claim.resolution);
    if v_claim.failure_type = 'consulta_pedido' then
      v_title := 'Tu consulta fue resuelta';
      v_body := 'BEYONIX finalizó tu consulta sobre el pedido ' || v_order_code || '.';
    elsif v_claim.failure_type = 'cancelar_compra' then
      v_title := 'Tu solicitud de cancelación fue resuelta';
      v_body := 'BEYONIX resolvió la cancelación del pedido ' || v_order_code || '.' || coalesce(' ' || v_notice, '');
    elsif v_claim.status = 'rechazado' then
      v_title := 'Respondimos tu reclamo';
      v_body := 'Entrá para ver la respuesta sobre tu pedido ' || v_order_code || '.';
    else
      -- El resultado ya avisado (reemplazo entregado, reintegro, saldo) no se
      -- repite con un segundo aviso de cierre.
      if exists (
        select 1 from public.customer_notifications n
        where n.user_id = v_claim.user_id
          and n.order_id = v_claim.order_id
          and n.created_at >= v_claim.created_at
          and (n.source_key like 'claim-milestone:' || v_claim.id || ':replacement_delivered%'
               or n.type in ('order_refunded', 'customer_credit'))
      ) then
        return new;
      end if;
      v_title := case
        when v_kind in ('reintegro_total', 'reintegro_parcial') then 'Tu reintegro fue realizado'
        when v_kind in ('saldo_a_favor', 'cupon_descuento') then 'Tu saldo a favor ya está disponible'
        else 'Tu reclamo está resuelto' end;
      v_body := 'Resolvimos tu reclamo del pedido ' || v_order_code || '.' || coalesce(' ' || v_notice, '');
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

  -- Respuesta escrita por BEYONIX: una sola notificación sin leer por pedido
  -- (el conteo real lo da el badge de "Ver reclamo").
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

-- Reemplazo directo disponible en la sucursal: Andreani (o un estado forzado)
-- lo informa sin mensaje automático propio.
create or replace function public.notify_order_claim_replacement_at_branch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
begin
  if new.direction <> 'reemplazo' or new.status <> 'en_sucursal' or old.status is not distinct from new.status then
    return new;
  end if;
  select * into v_claim from public.order_claims where id = new.claim_id;
  perform public.notify_order_claim_customer_milestone(v_claim, 'replacement_at_branch', new.id::text);
  return new;
end;
$$;

drop trigger if exists notify_order_claim_replacement_at_branch on public.order_claim_shipments;
create trigger notify_order_claim_replacement_at_branch
after update of status on public.order_claim_shipments
for each row execute function public.notify_order_claim_replacement_at_branch();

-- Entrega del reemplazo confirmada fuera de Andreani
-- (confirm_order_claim_replacement_delivered_manually): sin tramo ni mensaje.
create or replace function public.notify_order_claim_replacement_delivered_manually()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
begin
  if new.role <> 'reemplazo' or new.location <> 'entregada_cliente' or new.shipment_id is not null
     or old.location is not distinct from new.location then
    return new;
  end if;
  select * into v_claim from public.order_claims where id = new.claim_id;
  perform public.notify_order_claim_customer_milestone(v_claim, 'replacement_delivered', 'manual');
  return new;
end;
$$;

drop trigger if exists notify_order_claim_replacement_delivered_manually on public.order_claim_units;
create trigger notify_order_claim_replacement_delivered_manually
after update of location on public.order_claim_units
for each row execute function public.notify_order_claim_replacement_delivered_manually();

-- Igual a 20260924160000, salvo que ver el reclamo sólo marca leídas las
-- respuestas escritas: los hitos y el cierre se leen desde la campana.
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
    and type = 'claim_response'
    and order_id = v_claim.order_id
    and is_read = false
    and created_at <= v_last_read;

  return v_last_read;
end;
$$;

revoke all on function public.order_claim_customer_milestone(text) from public, anon, authenticated;
revoke all on function public.notify_order_claim_customer_milestone(public.order_claims, text, text) from public, anon, authenticated;
revoke all on function public.notify_customer_claim_message() from public, anon, authenticated;
revoke all on function public.notify_order_claim_replacement_at_branch() from public, anon, authenticated;
revoke all on function public.notify_order_claim_replacement_delivered_manually() from public, anon, authenticated;
revoke all on function public.mark_order_claim_customer_read(bigint, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.mark_order_claim_customer_read(bigint, uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';
commit;
