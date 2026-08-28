-- Recrea temporalmente el helper de solo-lectura de 20260827200000 (ya se
-- había eliminado en 20260827200001) para confirmar el cuerpo real y
-- definitivo de las 3 funciones corregidas, y lo vuelve a eliminar acá
-- mismo. No deja ningún objeto nuevo en el esquema.
create or replace function public.__debug_get_functiondef(p_fn_name text)
returns text
language sql
security definer
set search_path = public
as $$
  select pg_get_functiondef(p_fn_name::regproc);
$$;

revoke all on function public.__debug_get_functiondef(text) from public, anon, authenticated;
grant execute on function public.__debug_get_functiondef(text) to service_role;
