-- Auditoría 3/7 (compras/reposición/costos), Fase 2, punto 2: reproducibilidad
-- del esquema para el lado de COMPRAS/GASTOS/DEVOLUCIONES/VENTAS del refresco
-- de inventario derivado.
--
-- Mismo hallazgo que 20260918110000_inventory_refresh_reproducibility.sql
-- (que reprodujo el lado de órdenes/variantes) pero para las piezas que ese
-- archivo dejó afuera: la función public.refresh_inventory_from_row() y los
-- 5 triggers que la usan -- confirmados ausentes de supabase/migrations/ por
-- grep exhaustivo (sólo aparecen en `alter table ... disable/enable trigger`
-- desde 20260817120000 en adelante, nunca en un `create trigger`). Si hoy se
-- reconstruyera el esquema sólo desde migrations/, una compra, un gasto, una
-- devolución física o una venta externa/de Mercado Libre nunca recalcularía
-- stock.
--
-- A diferencia de 20260918110000 (verificada byte a byte contra producción
-- con pg_get_functiondef/pg_get_triggerdef el 2026-09-18), esta migración se
-- reconstruye a partir del histórico manual supabase/sql/093_unified_
-- inventory_source.sql y supabase/sql/094_external_sales_inventory.sql (única
-- fuente disponible en esta sesión, sin acceso a psql/CLI/MCP contra
-- producción) -- normalizando sólo CRLF -> LF. Es la mejor reconstrucción
-- disponible, pero a diferencia de la migración hermana NO fue verificada
-- byte a byte en vivo; queda pendiente confirmarla contra el esquema real
-- antes de asumir que es idéntica (ver reporte de Auditoría 3/7, sección
-- "Riesgos / pendientes"). Cero cambio de comportamiento intentado: la única
-- meta es que el esquema sea reconstruible desde migrations/.
--
-- No se tocan permisos: refresh_inventory_from_row() no tenía REVOKE/GRANT
-- explícito en el histórico (EXECUTE por defecto a PUBLIC), igual que las
-- funciones ya reproducidas en 20260918110000 -- no se agrega ningún
-- grant/revoke acá para no alterar ese estado.

begin;

create or replace function public.refresh_inventory_from_row()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old_product_id bigint;
  v_new_product_id bigint;
begin
  v_old_product_id := case when tg_op <> 'INSERT' then old.product_id else null end;
  v_new_product_id := case when tg_op <> 'DELETE' then new.product_id else null end;

  if v_old_product_id is not null then
    perform public.refresh_inventory_stock(v_old_product_id);
  end if;
  if v_new_product_id is not null
     and v_new_product_id is distinct from v_old_product_id then
    perform public.refresh_inventory_stock(v_new_product_id);
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

create or replace trigger refresh_inventory_after_purchase
  after insert or update or delete on public.product_cost_entries
  for each row execute function public.refresh_inventory_from_row();

create or replace trigger refresh_inventory_after_return_movement
  after insert or update or delete on public.inventory_return_movements
  for each row execute function public.refresh_inventory_from_row();

create or replace trigger refresh_inventory_after_expense
  after insert or update or delete on public.business_expenses
  for each row execute function public.refresh_inventory_from_row();

create or replace trigger refresh_inventory_after_external_sale
  after insert or update or delete on public.external_sales
  for each row execute function public.refresh_inventory_from_row();

create or replace trigger refresh_inventory_after_mercadolibre_sale
  after insert or update or delete on public.mercadolibre_sales
  for each row execute function public.refresh_inventory_from_row();

notify pgrst, 'reload schema';

commit;
