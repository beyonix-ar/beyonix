-- Propuesta segura para activar "usuarios activos" y "carrito actual" en /admin.
-- No es necesaria para que el panel funcione hoy: la UI queda preparada y muestra
-- estado no disponible hasta que la app escriba estas tablas desde el cliente.

create table if not exists public.client_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  current_path text,
  user_agent text,
  updated_at timestamptz not null default now()
);

create table if not exists public.client_carts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);

alter table public.client_presence enable row level security;
alter table public.client_carts enable row level security;

-- Recomendado: exponer lectura solo a admins mediante policies basadas en profiles.rol
-- y permitir upsert solo al usuario dueño de cada presencia/carrito.
