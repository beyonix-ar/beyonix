-- Despachos: la etiqueta Andreani se confirma leyendo su seguimiento, no al imprimirla.
--
-- Antes, pedir el PDF de la etiqueta (confirm_order_andreani_label(bigint, uuid))
-- dejaba el pedido "Listo para Bulto" sin que nadie verificara qué etiqueta
-- quedó pegada en el paquete. Ahora:
--   pickeo completo -> envío Andreani -> etiqueta impresa -> seguimiento
--   escaneado/tipeado y validado -> Listo para Bulto -> Bulto general -> entrega.
--
-- El código leído se compara contra el envío persistido del pedido:
-- andreani_tracking o cualquier número de bulto de andreani_bulto_numbers
-- (cada bulto tiene su propia etiqueta). El ID de la API (andreani_envio_id,
-- p. ej. API000…) no se imprime como seguimiento y no se acepta.
--
-- No es un estado Andreani: sólo registra que el operador verificó la etiqueta
-- correcta. Reutiliza order_packages.identification_* (método 'andreani',
-- fecha y operador; rearmar la anula vía sync_package_identification). El
-- seguimiento leído queda en order_audit_events.

begin;

drop function if exists public.confirm_order_andreani_label(bigint, uuid);

create or replace function public.confirm_order_andreani_label(p_order_id bigint, p_code text, p_actor_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order public.ordenes%rowtype;
  v_package public.order_packages%rowtype;
  -- Lector, pegado o tipeo: sin espacios ni caracteres de control, en mayúsculas.
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[[:space:][:cntrl:]]+', '', 'g'));
  v_expected text[];
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if v_code = '' or length(v_code) > 64 then raise exception 'DISPATCH_LABEL_CODE_INVALID'; end if;
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_PREPARATION_NOT_STARTED'; end if;
  if v_package.status <> 'prepared' then raise exception 'DISPATCH_PACKAGE_NOT_PREPARED'; end if;
  if nullif(btrim(coalesce(v_order.andreani_envio_id, '')), '') is null
     or v_order.andreani_creation_status is distinct from 'created' then
    raise exception 'DISPATCH_SHIPMENT_PENDING' using detail = p_order_id::text; end if;

  select coalesce(array_agg(distinct code), '{}') into v_expected from (
    select upper(regexp_replace(value, '[[:space:][:cntrl:]]+', '', 'g')) code
    from unnest(array_append(coalesce(v_order.andreani_bulto_numbers, '{}'), v_order.andreani_tracking)) value
  ) codes where code <> '';
  if cardinality(v_expected) = 0 then
    raise exception 'DISPATCH_LABEL_TRACKING_MISSING' using detail = p_order_id::text; end if;
  -- Otra etiqueta nunca se asocia: ni la primera vez ni sobre una ya confirmada.
  if not (v_code = any(v_expected)) then
    raise exception 'DISPATCH_LABEL_MISMATCH' using detail = p_order_id::text; end if;

  -- Releer la misma etiqueta no crea registros nuevos.
  if v_package.identification_method is not null then
    return jsonb_build_object('orderId', p_order_id, 'code', v_code, 'duplicate', true,
      'confirmedAt', v_package.identified_at);
  end if;
  if v_order.estado = 'cancelado' or v_order.cancelled_at is not null
     or public.order_has_active_stock_hold(p_order_id) then
    raise exception 'DISPATCH_ORDER_BLOCKED' using detail = p_order_id::text; end if;

  update public.order_packages set identification_method = 'andreani', identified_at = now(),
      identified_by = p_actor_id, identification_request_key = gen_random_uuid()
    where id = v_package.id returning * into v_package;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
    values (p_order_id, 'admin', p_actor_id, 'order_andreani_label_confirmed',
      jsonb_build_object('packageId', v_package.id, 'attempt', v_package.attempt_number,
        'code', v_code, 'tracking', v_order.andreani_tracking, 'envioId', v_order.andreani_envio_id));
  return jsonb_build_object('orderId', p_order_id, 'code', v_code, 'duplicate', false,
    'confirmedAt', v_package.identified_at);
end $$;

comment on function public.confirm_order_andreani_label(bigint, text, uuid) is
  'Confirma la etiqueta Andreani colocada en el pedido: el seguimiento leído debe coincidir con andreani_tracking o un número de bulto. Idempotente.';

-- Pedidos con la etiqueta sólo impresa (identificados al pedir el PDF) que
-- todavía no entraron a un Bulto general: vuelven a "Falta confirmar
-- etiqueta". El registro anterior queda en la auditoría. Los que ya están en
-- un Bulto general o entregados no cambian: ahí ya se verificaron con la etiqueta.
create temporary table dispatch_label_reset on commit drop as
  select p.id, p.order_id, p.attempt_number, p.identified_at, p.identified_by
  from public.order_packages p
  join public.ordenes o on o.id = p.order_id
  where p.identification_method = 'andreani' and p.status = 'prepared'
    and o.andreani_handed_over_at is null
    and not exists (select 1 from public.dispatch_batch_items m where m.order_id = p.order_id and m.removed_at is null);

insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
  select order_id, 'system', null, 'order_andreani_label_confirmation_required',
    jsonb_build_object('packageId', id, 'attempt', attempt_number,
      'previousIdentifiedAt', identified_at, 'previousIdentifiedBy', identified_by,
      'reason', 'label_printed_not_scanned')
  from dispatch_label_reset;

-- sync_package_identification impide reescribir una identificación: se
-- suspende sólo para esta corrección puntual dentro de la transacción.
alter table public.order_packages disable trigger sync_package_identification;
update public.order_packages p
  set identification_method = null, identified_at = null, identified_by = null, identification_request_key = null
  from dispatch_label_reset r where p.id = r.id;
alter table public.order_packages enable trigger sync_package_identification;

revoke all on function public.confirm_order_andreani_label(bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.confirm_order_andreani_label(bigint, text, uuid) to service_role;

notify pgrst, 'reload schema';

commit;
