-- Rate limiting persistente para "reenviar correo de confirmación".
--
-- Mismo patrón ya usado por "olvidé mi contraseña"
-- (password_reset_attempts / lib/auth/password-reset-rate-limit.ts): una
-- tabla es la única forma de que el límite sea real entre requests que
-- pueden caer en instancias de servidor distintas. El cooldown visible de
-- 30s en el frontend es sólo UX -- sin esta tabla, cualquiera podría llamar
-- al endpoint directamente y bombardear el envío de emails de confirmación.
--
-- Guarda únicamente HASHES (sha256) del email normalizado y de la IP --
-- nunca en texto plano.

begin;

create table if not exists public.email_confirmation_resend_attempts (
  id bigint generated always as identity primary key,
  identifier_hash text not null check (length(identifier_hash) = 64),
  ip_hash text check (ip_hash is null or length(ip_hash) = 64),
  created_at timestamptz not null default now()
);

create index if not exists email_confirmation_resend_attempts_identifier_idx
  on public.email_confirmation_resend_attempts (identifier_hash, created_at desc);
create index if not exists email_confirmation_resend_attempts_ip_idx
  on public.email_confirmation_resend_attempts (ip_hash, created_at desc)
  where ip_hash is not null;
-- Soporta la purga oportunista de filas viejas que hace el propio endpoint.
create index if not exists email_confirmation_resend_attempts_created_at_idx
  on public.email_confirmation_resend_attempts (created_at);

alter table public.email_confirmation_resend_attempts enable row level security;

-- Ni siquiera lectura para anon/authenticated: esta tabla es puramente
-- interna del rate limiter y sólo la toca el servidor con service_role.
revoke all on public.email_confirmation_resend_attempts from public, anon, authenticated;
grant select, insert, delete on public.email_confirmation_resend_attempts to service_role;

comment on table public.email_confirmation_resend_attempts is
  'Rate limiting de "reenviar correo de confirmación": sólo hashes sha256 de email/IP, nunca texto plano. Ver lib/auth/resend-confirmation.ts.';

commit;
