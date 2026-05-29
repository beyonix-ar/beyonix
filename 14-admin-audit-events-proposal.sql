-- Propuesta para extender Auditoria con eventos que no nacen de triggers CRUD.
-- Ejemplos: inicio de sesion admin, errores importantes, cambios de permisos
-- ejecutados desde funciones RPC, y eventos de seguridad.

create table if not exists public.admin_events (
  id bigserial primary key,
  event_type text not null,
  severity text not null default 'info',
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  target_user_id uuid references auth.users(id) on delete set null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_events enable row level security;

-- Recomendado: policy de SELECT solo para profiles.rol in ('admin', 'super_admin')
-- e INSERT mediante RPC security definer para evitar escrituras directas desde cliente.
