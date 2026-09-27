-- Fase 5 (ajuste): distinguir reservas de OTRA cuenta en el mensaje del
-- catálogo/carrito ("Otro cliente tiene reservadas...").
--
-- active_stock_reservation_totals (20260926130000) sólo devolvía cantidades,
-- así que la UI no podía saber si una reserva era ajena: el mismo usuario
-- puede tener otra pestaña/dispositivo con su propio checkout (otra sesión).
-- stock_reservations ya guarda user_id; con eso la base puede afirmar con
-- certeza que una reserva es de otra cuenta sin exponer ninguna identidad:
--
--   foreign_reserved_quantity = reservado por filas con user_id NO nulo y
--   distinto del usuario autenticado que consulta.
--
-- Sin sesión iniciada (anon) o para reservas de invitados (user_id nulo) no
-- hay certeza y vale 0: la UI usa entonces el texto neutro. Sigue siendo un
-- agregado (sin sesiones, usuarios, pedidos ni vencimientos) y no cambia el
-- cálculo de stock ni ninguna reserva.
--
-- El tipo de retorno cambia (columna nueva), por eso se reemplaza con drop +
-- create dentro de la misma transacción; permisos idénticos a 20260926130000.

begin;

drop function if exists public.active_stock_reservation_totals(bigint[], text);

create function public.active_stock_reservation_totals(
  p_product_ids bigint[],
  p_exclude_session_id text default null
)
returns table (
  product_id bigint,
  variant_id bigint,
  conditioned_stock_id uuid,
  reserved_quantity integer,
  foreign_reserved_quantity integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_viewer uuid := auth.uid();
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
         sum(reservations.quantity)::integer,
         coalesce(sum(reservations.quantity) filter (
           where v_viewer is not null
             and reservations.user_id is not null
             and reservations.user_id <> v_viewer
         ), 0)::integer
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
  'Fase 5: cantidades reservadas ACTIVAS (expires_at > now()) agregadas por producto/variante/stock condicionado, y cuánto de eso es con certeza de OTRA cuenta (usuario autenticado distinto del que consulta). Sólo agregados: no expone sesiones, usuarios ni pedidos. Lectura para UI; la autoridad sigue siendo reserve_cart_stock/available_stock_for_session.';

revoke all on function public.active_stock_reservation_totals(bigint[], text) from public;
grant execute on function public.active_stock_reservation_totals(bigint[], text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
