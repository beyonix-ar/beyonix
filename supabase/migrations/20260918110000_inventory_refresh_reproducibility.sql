-- FASE 1 (hardening P0/P1 de inventario), punto 5: reproducibilidad del
-- esquema. Auditoría confirmó por lectura directa de producción
-- (pg_get_functiondef/pg_get_triggerdef/has_function_privilege, 2026-09-18)
-- que estas funciones y triggers EXISTEN y están ENABLED en producción, pero
-- nunca se declararon en supabase/migrations/ -- sólo viven en el histórico
-- manual supabase/sql/ (093_unified_inventory_source.sql y posteriores). Si
-- hoy se reconstruyera el esquema desde cero sólo con migrations/, ninguna
-- cancelación/venta/devolución recalcularía stock jamás.
--
-- Esta migración es una reproducción BYTE A BYTE (normalizando sólo
-- CRLF -> LF) de lo que ya corre en producción -- CERO cambio de
-- comportamiento. El único cambio de comportamiento real de esta fase vive
-- en 20260918110000_refresh_inventory_stock_fail_closed.sql, separado a
-- propósito para no mezclar "reproducir lo existente" con "cambiar una
-- regla".
--
-- No se tocan permisos: las 5 funciones de abajo ya tenían EXECUTE para
-- PUBLIC en producción (comportamiento por defecto de Postgres al crear una
-- función sin REVOKE explícito -- confirmado con has_function_privilege
-- contra public/anon/authenticated/service_role, las 4 dieron true). No se
-- agrega ningún grant/revoke acá para no alterar ese estado confirmado.

begin;

create or replace function public.inventory_order_consumes_stock(p_status text, p_payment_status text)
returns boolean
language sql
immutable parallel safe
as $function$
  select
    coalesce(p_status, '') in (
      'pagado',
      'preparado',
      'enviado',
      'en_camino',
      'visita_fallida',
      'en_sucursal',
      'retiro_pendiente',
      'retiro_vencido',
      'en_devolucion',
      'devuelto_beyonix',
      'entregado',
      'approved'
    )
    or (
      coalesce(p_status, '') <> 'cancelado'
      and coalesce(p_payment_status, '') in (
        'confirmado',
        'confirmed',
        'approved'
      )
    );
$function$;

create or replace function public.refresh_inventory_from_order()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_product_id bigint;
begin
  if public.inventory_order_consumes_stock(old.estado, old.payment_status)
     is not distinct from
     public.inventory_order_consumes_stock(new.estado, new.payment_status) then
    return new;
  end if;

  for v_product_id in
    select distinct items.producto_id
    from public.orden_items items
    where items.orden_id = new.id
  loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;

  return new;
end;
$function$;

create or replace function public.refresh_inventory_from_order_item()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old_product_id bigint;
  v_new_product_id bigint;
begin
  v_old_product_id := case when tg_op <> 'INSERT' then old.producto_id else null end;
  v_new_product_id := case when tg_op <> 'DELETE' then new.producto_id else null end;

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

create or replace function public.refresh_inventory_from_variant()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old_product_id bigint;
  v_new_product_id bigint;
begin
  v_old_product_id := case when tg_op <> 'INSERT' then old.producto_id else null end;
  v_new_product_id := case when tg_op <> 'DELETE' then new.producto_id else null end;

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

create or replace function public.guard_derived_inventory_stock()
returns trigger
set search_path to 'public'
language plpgsql
as $function$
begin
  if tg_op = 'INSERT' then
    new.stock := 0;
    return new;
  end if;

  if new.stock is distinct from old.stock
     and coalesce(
       current_setting('beyonix.inventory_refresh', true),
       ''
     ) <> 'on' then
    raise exception
      'INVENTORY_STOCK_IS_DERIVED: registrá una compra, venta, devolución o salida.';
  end if;

  return new;
end;
$function$;

create or replace trigger refresh_inventory_after_order
  after update of estado, payment_status on public.ordenes
  for each row execute function public.refresh_inventory_from_order();

create or replace trigger refresh_inventory_after_order_item
  after insert or delete or update on public.orden_items
  for each row execute function public.refresh_inventory_from_order_item();

create or replace trigger refresh_inventory_after_variant
  after insert or delete or update of producto_id on public.producto_variantes
  for each row execute function public.refresh_inventory_from_variant();

create or replace trigger guard_derived_product_stock
  before insert or update of stock on public.productos
  for each row execute function public.guard_derived_inventory_stock();

create or replace trigger guard_derived_variant_stock
  before insert or update of stock on public.producto_variantes
  for each row execute function public.guard_derived_inventory_stock();

notify pgrst, 'reload schema';

commit;
