-- Policies necesarias para que el frontend escriba presencia/carrito
-- y el panel admin pueda leer esos datos.

drop policy if exists "client_presence_select_own_or_admin" on public.client_presence;
drop policy if exists "client_presence_insert_own" on public.client_presence;
drop policy if exists "client_presence_update_own" on public.client_presence;
drop policy if exists "client_carts_select_own_or_admin" on public.client_carts;
drop policy if exists "client_carts_insert_own" on public.client_carts;
drop policy if exists "client_carts_update_own" on public.client_carts;

create policy "client_presence_select_own_or_admin"
on public.client_presence
for select
to authenticated
using (
  auth.uid() = user_id
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('admin', 'super_admin')
  )
);

create policy "client_presence_insert_own"
on public.client_presence
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "client_presence_update_own"
on public.client_presence
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "client_carts_select_own_or_admin"
on public.client_carts
for select
to authenticated
using (
  auth.uid() = user_id
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('admin', 'super_admin')
  )
);

create policy "client_carts_insert_own"
on public.client_carts
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "client_carts_update_own"
on public.client_carts
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
