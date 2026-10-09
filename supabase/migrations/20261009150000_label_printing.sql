-- Admin → Etiquetas: presets de impresión compartidos, última configuración
-- de cada usuario e historial de tandas. Sólo tablas nuevas; no toca datos.
-- La cola en curso vive en el navegador. Acceso únicamente por las APIs
-- /api/admin/labels/* (service_role, Admin/Super Admin): RLS activo sin
-- políticas para anon/authenticated.

create table if not exists public.label_print_presets (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 60),
  settings jsonb not null check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 8192),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists label_print_presets_name_key
  on public.label_print_presets (lower(btrim(name)));

create table if not exists public.label_print_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 8192),
  updated_at timestamptz not null default now()
);

create table if not exists public.label_print_batches (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  -- [{ productId, variantId, code, copies, labelName }]
  items jsonb not null check (
    jsonb_typeof(items) = 'array'
    and jsonb_array_length(items) between 1 and 300
    and octet_length(items::text) <= 65536
  ),
  label_count integer not null check (label_count between 1 and 500),
  output text not null check (output in ('print', 'pdf', 'zpl')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists label_print_batches_created_at_idx
  on public.label_print_batches (created_at desc);

alter table public.label_print_presets enable row level security;
alter table public.label_print_preferences enable row level security;
alter table public.label_print_batches enable row level security;

revoke all on public.label_print_presets, public.label_print_preferences, public.label_print_batches
  from public, anon, authenticated;
grant select, insert, update, delete
  on public.label_print_presets, public.label_print_preferences, public.label_print_batches
  to service_role;
