-- Devolución por reclamo: el cliente NO tiene que llevar el paquete a una
-- sucursal fija (ni a la de BEYONIX). Entrega el paquete con la etiqueta en
-- una sucursal Andreani habilitada; al escanearla, Andreani identifica el
-- envío y su destino. Sólo cambia el texto del mensaje de devolución; el
-- resto de la función queda idéntico a 20261001100000_claim_logistics_hardening.
-- CREATE OR REPLACE conserva los permisos (revocados para todos los roles).
-- Los mensajes ya publicados en reclamos existentes no se modifican.

create or replace function public.order_claim_shipment_created_effects(p_shipment public.order_claim_shipments)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tracking text := coalesce(p_shipment.andreani_tracking, p_shipment.andreani_envio_id);
  v_key text := ':' || p_shipment.id;
  v_branch text := coalesce(nullif(concat_ws(' · ', p_shipment.branch_name, p_shipment.branch_address), ''), 'la sucursal Andreani indicada');
begin
  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (p_shipment.order_id, 'system', 'claim_shipment_created', 'pendiente', 'generada',
    jsonb_build_object('claimId', p_shipment.claim_id, 'shipmentId', p_shipment.id, 'direction', p_shipment.direction,
      'attempt', p_shipment.attempt, 'envioId', p_shipment.andreani_envio_id, 'tracking', p_shipment.andreani_tracking,
      'modality', p_shipment.modality, 'environment', p_shipment.environment, 'costAmount', p_shipment.cost_amount));

  if p_shipment.direction = 'devolucion' then
    perform public.post_order_claim_system_message(p_shipment.claim_id, 'return_generated' || v_key,
      concat_ws(E'\n',
        'Generamos la devolución con Andreani. Descargá la etiqueta de devolución desde este reclamo y pegala en el paquete cerrado.',
        'Cuando tengas el paquete listo, acercalo a una sucursal Andreani habilitada con la etiqueta de devolución. Al escanearla, Andreani identificará automáticamente los datos del envío y su destino.',
        'Seguimiento Andreani: ' || v_tracking));
    return;
  end if;

  if p_shipment.direction = 'cambio' then
    perform public.post_order_claim_system_message(p_shipment.claim_id, 'exchange_generated' || v_key,
      concat_ws(E'\n',
        'Generamos el cambio con Andreani. Seguimiento Andreani: ' || v_tracking,
        'Cuando Andreani te avise que el producto nuevo está en ' || v_branch || ', acercate con el producto original completo y embalado y tu DNI: Andreani te entrega el nuevo al recibir el original.',
        'Si no se entrega el producto original, Andreani no entrega el nuevo: queda en la sucursal por un tiempo limitado y después vuelve a BEYONIX.'));
  else
    perform public.post_order_claim_system_message(p_shipment.claim_id, 'replacement_dispatched' || v_key,
      'Revisamos tu producto y te enviamos el reemplazo.');
    perform public.post_order_claim_system_message(p_shipment.claim_id, 'replacement_dispatch_details' || v_key,
      concat_ws(E'\n',
        'Seguimiento Andreani: ' || v_tracking,
        'Retiralo en ' || v_branch || ' cuando Andreani te avise que está disponible; llevá tu DNI.'));
  end if;

  -- Mismos datos que antes se cargaban a mano en el reclamo.
  update public.order_claims
  set replacement_shipping_company = coalesce(replacement_shipping_company, 'Andreani'),
      replacement_tracking = coalesce(replacement_tracking, v_tracking),
      replacement_sent_at = coalesce(replacement_sent_at, now())
  where id = p_shipment.claim_id;
end;
$$;
