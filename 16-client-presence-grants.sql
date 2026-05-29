-- Permisos explícitos para que las policies del SQL 15 puedan operar
-- con usuarios autenticados y para que el service role mantenga control total.

grant usage on schema public to authenticated;

grant select, insert, update on public.client_presence to authenticated;
grant select, insert, update on public.client_carts to authenticated;

grant all on public.client_presence to service_role;
grant all on public.client_carts to service_role;

-- Verificación rápida:
-- 1) Iniciar sesión con un cliente real.
-- 2) Navegar la tienda y agregar algo al carrito.
-- 3) Ejecutar:
-- select * from public.client_presence order by updated_at desc;
-- select user_id, jsonb_array_length(payload) as items, updated_at from public.client_carts;
