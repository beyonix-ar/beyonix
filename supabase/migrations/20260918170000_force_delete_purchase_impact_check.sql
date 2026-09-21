-- Auditoría 3/7 (compras/reposición/costos), Fase 3, punto 2.
--
-- force_delete_purchase_super_admin no advertía si la compra a borrar podía
-- estar formando el costo histórico (promedio ponderado) de ventas
-- posteriores del mismo producto/variante -- el SUPER ADMIN podía borrar "a
-- ciegas" sin saber que iba a mover retroactivamente la rentabilidad ya
-- reportada de esas ventas (ver lib/business/product-costs.ts:
-- getHistoricalUnitCost, que sólo usa costo_unitario_historico congelado
-- cuando existe -- ver 20260918140000_historical_cost_snapshot.sql -- y si
-- no, recalcula dinámicamente incluyendo cualquier compra con fecha
-- anterior o igual a la venta).
--
-- Esta función es de sólo lectura: cuenta ventas (web + externas + Mercado
-- Libre) del mismo producto/variante con fecha >= la fecha de la compra, que
-- son las que pudieron haber usado esta compra en su promedio ponderado. No
-- bloquea nada por sí sola -- la usa app/api/admin/costs (DELETE ?force=true)
-- para devolver una advertencia y exigir una confirmación explícita antes de
-- llamar a force_delete_purchase_super_admin.

begin;

create or replace function public.get_purchase_force_delete_impact(p_purchase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.product_cost_entries%rowtype;
  v_web_count bigint := 0;
  v_external_count bigint := 0;
  v_ml_count bigint := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para consultar el impacto de esta compra.';
  end if;

  select * into v_entry
  from public.product_cost_entries entries
  where entries.id = p_purchase_id;

  if not found or v_entry.product_id is null then
    return jsonb_build_object('affected_sales_count', 0);
  end if;

  select count(*) into v_web_count
  from public.orden_items items
  join public.ordenes orders on orders.id = items.orden_id
  where items.producto_id = v_entry.product_id
    and (
      v_entry.variant_id is null
      or items.variante_id is not distinct from v_entry.variant_id
    )
    and orders.estado <> 'cancelado'
    and coalesce(orders.paid_at, orders.created_at) >= v_entry.purchase_date;

  select count(*) into v_external_count
  from public.external_sales sales
  where sales.product_id = v_entry.product_id
    and (
      v_entry.variant_id is null
      or sales.variant_id is not distinct from v_entry.variant_id
    )
    and sales.sale_date >= v_entry.purchase_date;

  select count(*) into v_ml_count
  from public.mercadolibre_sales sales
  where sales.product_id = v_entry.product_id
    and sales.sale_date >= v_entry.purchase_date;

  return jsonb_build_object(
    'affected_sales_count', v_web_count + v_external_count + v_ml_count,
    'web_count', v_web_count,
    'external_count', v_external_count,
    'mercadolibre_count', v_ml_count
  );
end;
$$;

revoke all on function public.get_purchase_force_delete_impact(uuid)
  from public, anon, authenticated;
grant execute on function public.get_purchase_force_delete_impact(uuid)
  to service_role;

comment on function public.get_purchase_force_delete_impact(uuid) is
  'Sólo lectura: cuenta ventas (web/externas/ML) del mismo producto/variante con fecha >= la fecha de la compra dada, como proxy de cuántas ventas posteriores pudieron usarla en su costo histórico. Usada para advertir antes de force_delete_purchase_super_admin.';

commit;
