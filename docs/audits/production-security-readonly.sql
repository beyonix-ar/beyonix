-- Auditoría de metadatos del proyecto Supabase remoto.
-- Ejecutar con una conexión de sólo lectura al proyecto PROD.
-- No lee filas de clientes, pedidos ni secretos. No modifica el esquema.
begin transaction read only;

-- Versiones aplicadas para comparar con supabase/migrations/.
select version, name
from supabase_migrations.schema_migrations
order by version;

-- RLS y privilegios efectivos de todas las tablas públicas.
select n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       has_table_privilege('anon', c.oid, 'INSERT') as anon_insert,
       has_table_privilege('anon', c.oid, 'UPDATE') as anon_update,
       has_table_privilege('anon', c.oid, 'DELETE') as anon_delete,
       has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
       has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_insert,
       has_table_privilege('authenticated', c.oid, 'UPDATE') as authenticated_update,
       has_table_privilege('authenticated', c.oid, 'DELETE') as authenticated_delete
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'storage') and c.relkind in ('r', 'p')
order by n.nspname, c.relname;

-- Políticas tal como están instaladas, no como figuran en archivos locales.
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname in ('public', 'storage')
order by schemaname, tablename, policyname;

-- SECURITY DEFINER, search_path y EXECUTE de RPC públicas.
select p.oid::regprocedure::text as function_signature,
       p.prosecdef as security_definer, p.proconfig as function_config,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
order by p.oid::regprocedure::text;

-- Buckets reales y restricciones de Storage.
select id, public, file_size_limit, allowed_mime_types
from storage.buckets
order by id;

commit;
