-- Corrección auditada de "No corresponde": reabrir la revisión de un reclamo
-- rechazado por error, SÓLO si el rechazo no tuvo efectos reales.
--
-- 'rechazado' sigue siendo terminal para mutate_admin_order_claim; esta es la
-- única puerta de salida, explícita, con motivo y auditoría:
--   * sólo Admin (no operador), con service_role y CAS por updated_at;
--   * nunca consultas ni cancelaciones (tienen su propio circuito);
--   * nunca si hubo NC, reemplazo, saldo, operación Andreani real, unidades
--     movidas / incidencias o recepción de inventario del reclamo;
--   * el reclamo vuelve a 'en_revision' sin resolución (el Admin decide de
--     nuevo con el flujo normal), el cliente recibe un aviso y queda el
--     evento 'claim_review_reopened' con el motivo y el rechazo anterior.

create or replace function public.reopen_rejected_order_claim(
  p_claim_id bigint,
  p_actor_id uuid,
  p_expected_updated_at timestamptz,
  p_reason text
)
returns public.order_claims
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_result public.order_claims%rowtype;
  v_role text;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CLAIM_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id = p_actor_id;
  if coalesce(v_role, '') not in ('admin', 'super_admin') then raise exception 'CLAIM_FORBIDDEN'; end if;
  if length(v_reason) < 10 or length(v_reason) > 1000 then raise exception 'CLAIM_REOPEN_REASON_REQUIRED'; end if;

  -- Mismo orden de locks que mutate_admin_order_claim: pedido -> reclamo.
  perform 1 from public.ordenes where id = (select order_id from public.order_claims where id = p_claim_id) for update;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if p_expected_updated_at is null or v_claim.updated_at <> p_expected_updated_at then raise exception 'CLAIM_CONFLICT'; end if;
  if v_claim.status <> 'rechazado' or coalesce(v_claim.failure_type, '') in ('consulta_pedido', 'cancelar_compra') then
    raise exception 'CLAIM_REOPEN_NOT_ALLOWED';
  end if;

  if exists (select 1 from public.order_credit_notes where claim_id = v_claim.id and status in ('processing', 'authorized'))
     or exists (select 1 from public.order_replacements where claim_id = v_claim.id)
     or exists (select 1 from public.customer_credit_movements where claim_id = v_claim.id)
     or exists (select 1 from public.order_claim_shipments
                where claim_id = v_claim.id and creation_status in ('processing', 'created', 'manual_review'))
     or exists (select 1 from public.order_claim_units
                where claim_id = v_claim.id
                  and (role = 'reemplazo' or incident_open or location not in ('con_cliente', 'conservada_cliente')))
     or exists (
       select 1 from public.inventory_return_movements m
       where m.order_id = v_claim.order_id and m.created_at >= v_claim.created_at
         and m.order_item_id in (select (x->>'order_item_id')::bigint from jsonb_array_elements(v_claim.affected_items) x)
     ) then
    raise exception 'CLAIM_REOPEN_HAS_EFFECTS';
  end if;

  -- Primero las unidades: el rechazo las dejó "con el cliente" definitivamente;
  -- vuelven a estar pendientes de la nueva decisión.
  update public.order_claim_units set location = 'con_cliente', updated_at = clock_timestamp()
  where claim_id = v_claim.id and role = 'original' and location = 'conservada_cliente';

  update public.order_claims
  set status = 'en_revision', resolution = null, rejection_reason = null, closed_at = null, resolution_summary = null
  where id = v_claim.id
  returning * into v_result;

  perform public.post_order_claim_system_message(v_claim.id,
    'review_reopened_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text,
    'Estamos revisando nuevamente tu reclamo. Te avisamos por acá cuando tengamos una respuesta.', true);
  perform public.log_order_claim_logistics(v_claim.id, p_actor_id, 'claim_review_reopened',
    jsonb_build_object('reason', v_reason, 'previousStatus', v_claim.status,
      'previousRejectionReason', v_claim.rejection_reason, 'previousClosedAt', v_claim.closed_at));

  select * into v_result from public.order_claims where id = v_claim.id;
  return v_result;
end;
$$;

revoke all on function public.reopen_rejected_order_claim(bigint, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.reopen_rejected_order_claim(bigint, uuid, timestamptz, text) to service_role;

notify pgrst, 'reload schema';
