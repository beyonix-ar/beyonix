-- Privacidad de pedidos: el cliente nunca lee filas de ordenes/orden_items
-- directamente.
--
-- Antes: la política ordenes_select_own (y "Users can read own order items")
-- dejaba a cualquier cliente leer, con su sesión y desde el navegador
-- (supabase.from('ordenes').select('*') o Realtime), TODAS las columnas de sus
-- pedidos: tarifa cotizada por Andreani, recargo logístico y su importe,
-- redondeo, beneficio absorbido, estimación de bultos, recotización con
-- bultos reales, facturación Andreani, notas y estados internos, y en
-- orden_items el costo unitario histórico de compra. RLS filtra filas, no
-- columnas: con la fila propia venía todo.
--
-- Ahora: el cliente accede a sus pedidos sólo por endpoints del servidor que
-- arman un DTO con columnas explícitas (/api/orders, /api/orders/[id],
-- comprobantes, reclamos). En la base quedan únicamente dos superficies
-- mínimas para el navegador:
--   * customer_order_signals: aviso Realtime "tu pedido cambió" (id, fecha).
--   * customer_order_payment_progress(): 7 campos de estado de pago para la
--     campana de notificaciones.
-- Admin conserva sus políticas y su acceso completo; no se borra ningún dato.

-- 1. Sin lectura directa de pedidos para clientes ---------------------------------
drop policy if exists ordenes_select_own on public.ordenes;
drop policy if exists "Users can read own order items" on public.orden_items;
drop policy if exists "Customers can read own refund proofs" on public.order_refund_proofs;
-- Sin GRANT de INSERT nunca tuvo efecto; las órdenes se crean server-side.
drop policy if exists ordenes_insert_own on public.ordenes;

-- anon no tiene ninguna política sobre pedidos: tampoco necesita el privilegio.
revoke select on public.ordenes, public.orden_items from anon;
revoke all on public.order_refund_proofs from anon;

-- 2. Aviso Realtime sin datos ------------------------------------------------------
-- Realtime envía la fila completa al suscriptor: por eso el cliente ya no se
-- suscribe a ordenes, sino a esta tabla que sólo dice qué pedido cambió.
create table public.customer_order_signals (
  order_id bigint primary key references public.ordenes(id) on delete cascade,
  user_id uuid not null,
  changed_at timestamptz not null default now()
);
create index customer_order_signals_user_idx on public.customer_order_signals(user_id);
alter table public.customer_order_signals enable row level security;
revoke all on public.customer_order_signals from public, anon, authenticated;
grant select on public.customer_order_signals to authenticated;
grant select, insert, update, delete on public.customer_order_signals to service_role;
create policy customer_order_signals_select_own on public.customer_order_signals
  for select to authenticated using (user_id = auth.uid());
comment on table public.customer_order_signals is
  'Aviso Realtime para el cliente: sólo id del pedido y momento del cambio. Los datos se leen por la API (DTO customer-safe).';

create or replace function public.signal_customer_order_change()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.usuario_id is null then
    delete from public.customer_order_signals where order_id = new.id;
    return new;
  end if;
  insert into public.customer_order_signals (order_id, user_id, changed_at)
  values (new.id, new.usuario_id, now())
  on conflict (order_id) do update
    set user_id = excluded.user_id, changed_at = excluded.changed_at;
  return new;
end $$;
revoke all on function public.signal_customer_order_change() from public, anon, authenticated;

drop trigger if exists signal_customer_order_change on public.ordenes;
create trigger signal_customer_order_change
  after insert or update on public.ordenes
  for each row execute function public.signal_customer_order_change();

insert into public.customer_order_signals (order_id, user_id, changed_at)
select id, usuario_id, coalesce(created_at, now()) from public.ordenes where usuario_id is not null
on conflict (order_id) do nothing;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public'
                       and tablename = 'customer_order_signals') then
    alter publication supabase_realtime add table public.customer_order_signals;
  end if;
end $$;

-- 3. Estado de pago para la campana (DTO mínimo) --------------------------------
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
    and o.id = any(p_order_ids[1:200])
$$;
revoke all on function public.customer_order_payment_progress(bigint[]) from public, anon;
grant execute on function public.customer_order_payment_progress(bigint[]) to authenticated, service_role;

-- 4. Categorías: la escritura era para cualquier usuario autenticado ----------
-- "Admins can insert/update/delete categorias" tenían condición `true`: un
-- cliente logueado podía crear, renombrar o borrar categorías por REST.
drop policy if exists "Admins can insert categorias" on public.categorias;
drop policy if exists "Admins can update categorias" on public.categorias;
drop policy if exists "Admins can delete categorias" on public.categorias;
create policy "Admins can insert categorias" on public.categorias
  for insert to authenticated
  with check (exists (select 1 from public.profiles
                      where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));
create policy "Admins can update categorias" on public.categorias
  for update to authenticated
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')))
  with check (exists (select 1 from public.profiles
                      where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));
create policy "Admins can delete categorias" on public.categorias
  for delete to authenticated
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));
revoke insert, update, delete on public.categorias from anon;

-- 5. Higiene: deshacer auditoría exige super admin; anon no necesita EXECUTE.
revoke execute on function public.undo_audit_log(bigint) from anon;

notify pgrst, 'reload schema';
