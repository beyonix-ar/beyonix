-- Cierra un oráculo público de enumeración de emails: get_profile_email_by_username
-- (creada en supabase/sql/012_profile_registration_fields.sql) estaba otorgada
-- a anon/authenticated, así que cualquiera con la anon key pública podía
-- resolver el email real de cualquier username sin autenticarse. Verificado
-- en producción (2026-09-12): POST a rpc/get_profile_email_by_username con
-- sólo la anon key devuelve 200 con el email cuando el username existe.
--
-- La única consumidora legítima (context/auth-context.tsx `login()`) pasa a
-- resolverlo server-side vía /api/auth/login (lib/auth/login.ts, con
-- service_role). lib/auth/forgot-password.ts ya lo llama server-side y sigue
-- funcionando sin cambios: service_role no depende de este grant.
revoke execute on function public.get_profile_email_by_username(text)
  from anon, authenticated;

-- Unicidad real de username (case-insensitive), inexistente hasta ahora a
-- nivel de base de datos: profiles.username sólo tenía chequeos de
-- aplicación (nunca un constraint), así que dos cuentas podían terminar con
-- el mismo username y get_profile_email_by_username()/login por username
-- resolvían arbitrariamente una de las dos (sin ORDER BY, LIMIT 1).
--
-- lower(trim(...)) en vez de lower(...) a secas: coincide exactamente con
-- la normalización que ya hace get_profile_email_by_username()
-- (lower(trim(username_input))) al resolver el login. Con sólo lower(), un
-- valor futuro con espacio colgante ("lucas " vs "lucas") pasaría el UNIQUE
-- (son bytes distintos) pero el login por username jamás lo encontraría
-- (el RPC trimea el input pero comparaba contra la columna sin trim) --
-- username "fantasma", inalcanzable. La condición WHERE excluye NULL y
-- cadenas vacías/sólo-espacios: ninguna de esas dos formas de "sin
-- username" debe competir por unicidad entre sí.
--
-- Verificado en producción antes de esta migración (read-only, sin tocar
-- datos): 0 duplicados exactos, 0 por lower(), 0 por lower(trim()), 0
-- usernames vacíos/en blanco, 0 con espacios colgantes -- el índice es
-- seguro de crear sin backfill previo. Sí existe un registro con username
-- en mayúsculas ("ANTARES"): no colisiona con nada (no hay otro usuario con
-- ese username en ningún casing) y el login ya lo resuelve bien porque el
-- RPC compara con lower() de ambos lados; queda como dato histórico, no
-- bloquea esta migración.
create unique index if not exists profiles_username_lower_unique
  on public.profiles (lower(trim(username)))
  where username is not null and trim(username) <> '';
