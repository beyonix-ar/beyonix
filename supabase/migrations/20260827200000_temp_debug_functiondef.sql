-- Ayuda de diagnóstico TEMPORAL (read-only): permite leer pg_get_functiondef
-- de una función existente vía RPC para confirmar el cuerpo SQL realmente
-- vigente en producción. Se elimina en la migración inmediatamente
-- siguiente una vez usada -- no queda como parte permanente del esquema.
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
