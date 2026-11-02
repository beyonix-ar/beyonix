-- Rate limit ATÓMICO de "olvidé mi contraseña".
--
-- Antes el servidor contaba intentos (4 SELECT count) y después insertaba el
-- intento en otra request a PostgREST: N solicitudes paralelas del mismo
-- identificador leían el mismo conteo bajo el límite y TODAS quedaban
-- admitidas. Esta función decide y registra en una sola transacción, bajo
-- advisory locks transaccionales granulares:
--
--   1. lock por identificador (siempre);
--   2. lock por IP (sólo si hay IP confiable).
--
-- Orden fijo identificador -> IP en todas las llamadas: nadie toma un lock de
-- identificador teniendo uno de IP, así que no hay ciclos (sin deadlocks).
-- Cada clave tiene su propio lock: identificadores/IPs distintos avanzan en
-- paralelo; no hay lock global. Una colisión de hashtext() sólo serializa
-- dos claves distintas, nunca relaja el límite.
--
-- Política sin cambios (lib/auth/password-reset-rate-limit.ts):
-- identificador 3/hora y 6/día; IP 8/hora y 20/día. El intento se registra
-- SIEMPRE, también cuando queda limitado (misma semántica que antes).
--
-- Devuelve sólo `allowed boolean`: ni conteos, ni hashes, ni timestamps.
-- Ejecutable únicamente por service_role (el endpoint del servidor).

begin;

create or replace function public.admit_password_reset_attempt(
  p_identifier_hash text,
  p_ip_hash text default null
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  -- Espacio de nombres propio para no compartir advisory locks con otros flujos.
  c_lock_identifier constant integer := 731001;
  c_lock_ip constant integer := 731002;
  v_identifier_hour integer;
  v_identifier_day integer;
  v_ip_hour integer := 0;
  v_ip_day integer := 0;
  v_allowed boolean;
begin
  if p_identifier_hash is null or p_identifier_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid identifier hash' using errcode = '22023';
  end if;
  if p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid ip hash' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(c_lock_identifier, hashtext(p_identifier_hash));
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(c_lock_ip, hashtext(p_ip_hash));
  end if;

  -- Bajo READ COMMITTED cada sentencia toma un snapshot nuevo: ya con los
  -- locks tomados, estos conteos ven todo lo que confirmó el holder anterior.
  select
    count(*) filter (where created_at >= now() - interval '1 hour'),
    count(*)
  into v_identifier_hour, v_identifier_day
  from public.password_reset_attempts
  where identifier_hash = p_identifier_hash
    and created_at >= now() - interval '24 hours';

  if p_ip_hash is not null then
    select
      count(*) filter (where created_at >= now() - interval '1 hour'),
      count(*)
    into v_ip_hour, v_ip_day
    from public.password_reset_attempts
    where ip_hash = p_ip_hash
      and created_at >= now() - interval '24 hours';
  end if;

  v_allowed :=
    v_identifier_hour < 3
    and v_identifier_day < 6
    and v_ip_hour < 8
    and v_ip_day < 20;

  insert into public.password_reset_attempts (identifier_hash, ip_hash)
  values (p_identifier_hash, p_ip_hash);

  return v_allowed;
end;
$$;

revoke all on function public.admit_password_reset_attempt(text, text) from public, anon, authenticated;
grant execute on function public.admit_password_reset_attempt(text, text) to service_role;

comment on function public.admit_password_reset_attempt(text, text) is
  'Rate limit atómico de recuperación de contraseña (decide + registra bajo advisory locks por identificador/IP). Sólo service_role. Ver lib/auth/forgot-password.ts.';

commit;
