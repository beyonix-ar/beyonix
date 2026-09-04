-- Rate limiting persistente para "olvidé mi contraseña".
--
-- Necesario porque en producción corren múltiples instancias del servidor:
-- una tabla es la única forma de que el límite sea real entre requests que
-- pueden caer en procesos distintos (mismo patrón ya usado para el rate
-- limit de checkout de Mercado Pago, que cuenta filas de `ordenes` en vez de
-- guardar contadores en memoria).
--
-- Guarda únicamente HASHES (sha256) del identificador normalizado y de la
-- IP -- nunca el email/username/IP en texto plano. No hace falta el valor
-- real para contar intentos, y evita que esta tabla se vuelva un segundo
-- directorio de cuentas o de IPs de clientes.

begin;

create table if not exists public.password_reset_attempts (
  id bigint generated always as identity primary key,
  identifier_hash text not null check (length(identifier_hash) = 64),
  ip_hash text check (ip_hash is null or length(ip_hash) = 64),
  created_at timestamptz not null default now()
);

create index if not exists password_reset_attempts_identifier_idx
  on public.password_reset_attempts (identifier_hash, created_at desc);
create index if not exists password_reset_attempts_ip_idx
  on public.password_reset_attempts (ip_hash, created_at desc)
  where ip_hash is not null;
-- Soporta la purga oportunista de filas viejas que hace el propio endpoint.
create index if not exists password_reset_attempts_created_at_idx
  on public.password_reset_attempts (created_at);

alter table public.password_reset_attempts enable row level security;

-- Ni siquiera lectura para anon/authenticated: esta tabla es puramente
-- interna del rate limiter y sólo la toca el servidor con service_role.
revoke all on public.password_reset_attempts from public, anon, authenticated;
grant select, insert, delete on public.password_reset_attempts to service_role;

comment on table public.password_reset_attempts is
  'Rate limiting de "olvidé mi contraseña": sólo hashes sha256 de identificador/IP, nunca texto plano. Ver lib/auth/password-reset-rate-limit.ts.';

commit;
