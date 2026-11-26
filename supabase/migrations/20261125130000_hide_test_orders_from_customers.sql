-- Compras de prueba (ordenes.test_order_at) fuera de la experiencia del cliente.
--
-- La clasificación (20261124120000) excluye la compra de las estadísticas y la
-- archiva, pero el cliente la seguía viendo: las rutas de cuenta filtran en la
-- app (lib/orders/order-visibility.ts) y esta migración cubre lo que el
-- navegador lee DIRECTO de la base, bajo RLS:
--   * customer_notifications: el cliente lee sus avisos con su sesión
--     (campana, Realtime). Los avisos de una compra de prueba dejan de ser
--     visibles; las filas se conservan.
--   * reviews: el resumen de valoraciones por producto se lee con la clave
--     pública. Una reseña de una compra de prueba (reviews.order_id es NOT
--     NULL con FK: el vínculo siempre es verificable) deja de contar en
--     listados y promedios públicos; no se borra.
--   * reviews: ninguna reseña nueva (ni re-vinculada) sobre una compra de
--     prueba, aunque se intente por un camino distinto de /api/reviews.
--   * customer_order_signals (aviso Realtime "tu pedido cambió", 20261009130000):
--     la señal de una compra de prueba deja de ser legible (lectura directa y
--     Realtime, que autoriza INSERT/UPDATE con esta misma política SELECT) y el
--     trigger deja de emitir señales nuevas para ella.
--     Realtime NO aplica RLS a los DELETE (realtime.apply_rls): entrega la PK
--     (order_id) a todo suscriptor cuyo filtro la admita (sin filtro, o filtro
--     por order_id). Por eso una señal de prueba nunca se borra: queda sin
--     cliente (user_id null), lo que sólo genera UPDATE, que RLS no entrega a
--     nadie. Esto cubre la clasificación, la eliminación de cuenta y las
--     señales existentes. Al eliminar una cuenta, las señales de pedidos
--     legítimos también se desvinculan: sus DELETE previos exponían order_id.
--   * customer_order_payment_progress(): la RPC de la campana (SECURITY
--     DEFINER, ignora RLS) ya no devuelve estado de pago de compras de prueba.
-- Auditado en producción (solo lectura, 2026-11-25): cada tabla tiene UNA sola
-- política SELECT permisiva (ninguna otra se combina por OR); se reemplaza esa
-- misma, con su mismo nombre, rol y condición, más la exclusión de pruebas.
-- Nada se elimina ni se modifica: pedidos, pagos, facturas, NC, reclamos,
-- mensajes, auditoría, inventario y avisos quedan intactos (Admin, service_role
-- y auditoría los siguen viendo).
--
-- La función auxiliar vive en el schema `private`, que la API (PostgREST /
-- GraphQL) no expone: las políticas la pueden evaluar, pero nadie puede
-- invocarla por /rpc para averiguar qué pedidos son pruebas.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

create or replace function private.is_test_order(p_order_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.ordenes o
    where o.id = p_order_id and o.test_order_at is not null
  );
$$;

revoke all on function private.is_test_order(bigint) from public;
grant execute on function private.is_test_order(bigint) to anon, authenticated, service_role;

comment on function private.is_test_order(bigint) is
  'Compra de prueba clasificada (ordenes.test_order_at). Sólo para políticas RLS de la experiencia del cliente; no expuesta por la API.';

-- Avisos del cliente: los de compras de prueba no se leen (ni por Realtime).
drop policy if exists "Customers can read own notifications" on public.customer_notifications;
create policy "Customers can read own notifications"
  on public.customer_notifications
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and (order_id is null or not private.is_test_order(order_id))
  );

-- Señales Realtime del cliente: sin las de compras de prueba.
drop policy if exists customer_order_signals_select_own on public.customer_order_signals;
create policy customer_order_signals_select_own
  on public.customer_order_signals
  for select
  to authenticated
  using (user_id = auth.uid() and not private.is_test_order(order_id));

-- Las señales sin cliente se conservan para evitar DELETE visibles por Realtime.
alter table public.customer_order_signals alter column user_id drop not null;

-- Una compra de prueba no emite señales nuevas. Si un pedido pierde su
-- comprador (eliminación de cuenta), la señal se desvincula sin DELETE,
-- tanto para compras de prueba como legítimas. Los cambios de compras
-- legítimas con comprador siguen emitiendo INSERT/UPDATE como antes.
create or replace function public.signal_customer_order_change()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.test_order_at is not null then
    update public.customer_order_signals set user_id = null
    where order_id = new.id and user_id is not null;
    return new;
  end if;
  if new.usuario_id is null then
    update public.customer_order_signals set user_id = null
    where order_id = new.id and user_id is not null;
    return new;
  end if;
  insert into public.customer_order_signals (order_id, user_id, changed_at)
  values (new.id, new.usuario_id, now())
  on conflict (order_id) do update
    set user_id = excluded.user_id, changed_at = excluded.changed_at;
  return new;
end $$;
revoke all on function public.signal_customer_order_change() from public, anon, authenticated;

-- Señales ya existentes de compras de prueba: desvinculadas, no borradas.
update public.customer_order_signals s set user_id = null
from public.ordenes o
where o.id = s.order_id and o.test_order_at is not null and s.user_id is not null;

-- RPC de la campana (SECURITY DEFINER: no la cubre RLS). Igual que
-- 20261009130000, más la exclusión de compras de prueba.
create or replace function public.customer_order_payment_progress(p_order_ids bigint[])
returns table(id bigint, payment_method_id text, payment_status text, estado text,
  financial_status text, payment_proof_url text, payment_proof_uploaded_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select o.id, o.payment_method_id::text, o.payment_status::text, o.estado::text,
    o.financial_status::text, o.payment_proof_url::text, o.payment_proof_uploaded_at
  from public.ordenes o
  where auth.uid() is not null
    and o.usuario_id = auth.uid()
    and o.test_order_at is null
    and o.id = any(p_order_ids[1:200])
$$;
revoke all on function public.customer_order_payment_progress(bigint[]) from public, anon;
grant execute on function public.customer_order_payment_progress(bigint[]) to authenticated, service_role;

-- Reseñas públicas: sin las de compras de prueba (listados y promedios).
drop policy if exists "Public can read approved reviews" on public.reviews;
create policy "Public can read approved reviews"
  on public.reviews
  for select
  to public
  using (approved = true and not private.is_test_order(order_id));

-- Reseñas nuevas o re-vinculadas a una compra de prueba: rechazadas en la base.
create or replace function public.block_test_order_reviews()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if private.is_test_order(new.order_id) then
    raise exception 'REVIEW_TEST_ORDER' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.block_test_order_reviews() from public, anon, authenticated;

drop trigger if exists reviews_block_test_orders on public.reviews;
create trigger reviews_block_test_orders
  before insert or update of order_id on public.reviews
  for each row execute function public.block_test_order_reviews();

notify pgrst, 'reload schema';
