-- Logos de medios de pago administrables (Admin → Financiación → "MEDIOS DE PAGO DISPONIBLES").
--
-- source = 'mercadopago': un registro por payment_method_id de GET /v1/payment_methods
-- (Mercado Pago repite el id con distintos payment_type_id, p. ej. visa crédito y
-- prepaga, por eso los tipos se guardan como arreglo). La sincronización nunca borra
-- filas ni imágenes: si Mercado Pago deja de devolver el id queda 'missing'; si lo
-- informa no activo, 'inactive'. El cliente sólo ve logos con imagen, habilitados y,
-- para Mercado Pago, con provider_status = 'active'.
--
-- source = 'manual': medio externo (p. ej. MODO) que no figura en Mercado Pago. Nace
-- deshabilitado y sólo se muestra si un admin lo habilita explícitamente.
--
-- Lectura y escritura exclusivamente server-side (service_role): sin políticas para
-- anon/authenticated. La tienda recibe sólo los logos visibles por /api/payment-methods.

create table if not exists public.payment_method_logos (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('mercadopago', 'manual')),
  provider_method_id text check (provider_method_id is null or provider_method_id ~ '^[a-z0-9_-]{1,64}$'),
  provider_name text check (provider_name is null or char_length(provider_name) <= 120),
  provider_payment_types text[] not null default '{}',
  provider_status text check (provider_status in ('active', 'inactive', 'missing')),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  image_path text check (image_path is null or image_path ~ '^[0-9a-f-]{36}/[0-9]{10,16}\.(png|svg|webp|jpg)$'),
  enabled boolean not null default false,
  needs_review boolean not null default false,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint payment_method_logos_source_shape check (
    (source = 'mercadopago' and provider_method_id is not null and provider_status is not null)
    or (source = 'manual' and provider_method_id is null and provider_status is null
        and provider_name is null and provider_payment_types = '{}')
  ),
  -- NULL (manual) no colisiona: puede haber varios medios manuales.
  constraint payment_method_logos_provider_unique unique (source, provider_method_id)
);

comment on table public.payment_method_logos is
  'Logos de medios de pago. Mercado Pago: sincronizados con GET /v1/payment_methods (nunca se borran). Manual: medios externos habilitados explícitamente.';

alter table public.payment_method_logos enable row level security;
revoke all on table public.payment_method_logos from anon, authenticated;

-- Bucket propio (no se mezcla con imágenes de productos ni banners). Público para
-- poder mostrar los logos con <img>; sin políticas de escritura: sólo el servidor
-- (service_role) sube, reemplaza o quita archivos. Tipos y tamaño acotados.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-method-logos',
  'payment-method-logos',
  true,
  1048576,
  array['image/png', 'image/svg+xml', 'image/webp', 'image/jpeg']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
