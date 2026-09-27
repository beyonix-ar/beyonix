-- Fase 5: stock vendible visible en toda la web.
--
-- stock disponible = stock físico derivado - reservas activas
--
-- La reserva activa es la fila de stock_reservations con expires_at > now():
-- exactamente el mismo predicado que ya usan available_stock_for_session
-- (reserva/commit/confirmación) y get_product_inventory_distribution (Admin).
-- Incluye la reserva de 20 minutos del Paso 3, la ya comprometida a un pedido
-- pendiente y la retenida por un pago de Mercado Pago en proceso
-- (expires_at = 'infinity'). Una reserva vencida deja de contar sin tocar el
-- stock físico; una orden pagada/cancelada borra sus filas
-- (release_order_stock_reservation), así que nunca se descuenta dos veces.
--
-- POR QUÉ HACE FALTA
-- stock_reservations no es legible por anon/authenticated (RLS + revoke), y
-- está bien que siga así: tiene session_id, user_id y order_id. El catálogo
-- necesita únicamente CUÁNTO está reservado por producto/variante/stock
-- condicionado para mostrar y limitar el disponible. Esta función devuelve
-- sólo ese agregado (sin sesiones, usuarios, pedidos ni vencimientos), para
-- muchos productos en una sola consulta (sin N+1), usando el índice
-- stock_reservations_active_target_idx.
--
-- p_exclude_session_id permite que el carrito/checkout de una sesión no se
-- descuente su propia reserva (mismo criterio que available_stock_for_session).
-- No es una credencial: sólo excluye filas de ese identificador del conteo.
--
-- No reemplaza ninguna validación: reserve_cart_stock y los commits siguen
-- siendo la autoridad bajo advisory locks. Esto es lectura para la UI.

begin;

create or replace function public.active_stock_reservation_totals(
  p_product_ids bigint[],
  p_exclude_session_id text default null
)
returns table (
  product_id bigint,
  variant_id bigint,
  conditioned_stock_id uuid,
  reserved_quantity integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_product_ids is null or cardinality(p_product_ids) = 0 then
    return;
  end if;
  if cardinality(p_product_ids) > 1000 then
    raise exception 'TOO_MANY_PRODUCTS';
  end if;

  return query
  select reservations.product_id,
         reservations.variant_id,
         reservations.conditioned_stock_id,
         sum(reservations.quantity)::integer
  from public.stock_reservations reservations
  where reservations.product_id = any(p_product_ids)
    and reservations.expires_at > now()
    and (p_exclude_session_id is null
         or reservations.session_id is distinct from p_exclude_session_id)
  group by reservations.product_id,
           reservations.variant_id,
           reservations.conditioned_stock_id;
end;
$$;

comment on function public.active_stock_reservation_totals(bigint[], text) is
  'Fase 5: cantidades reservadas ACTIVAS (expires_at > now()) agregadas por producto/variante/stock condicionado. Sólo agregados: no expone sesiones, usuarios ni pedidos. Lectura para UI; la autoridad sigue siendo reserve_cart_stock/available_stock_for_session.';

revoke all on function public.active_stock_reservation_totals(bigint[], text) from public;
grant execute on function public.active_stock_reservation_totals(bigint[], text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
