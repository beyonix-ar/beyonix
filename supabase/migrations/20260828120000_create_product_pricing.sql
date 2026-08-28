begin;

create table if not exists public.product_pricing (
  product_id bigint primary key references public.productos(id) on delete cascade,
  pricing_mode text not null default 'manual' check (pricing_mode in ('manual', 'target_margin')),
  target_margin_percent numeric(5,2) check (
    target_margin_percent is null
    or (target_margin_percent >= 0 and target_margin_percent < 100)
  ),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.product_pricing enable row level security;

revoke all on table public.product_pricing from public, anon, authenticated;
grant select, insert, update, delete on table public.product_pricing to service_role;

comment on table public.product_pricing is
  'Metodo de fijacion de precio por producto (manual/margen objetivo) y margen objetivo configurado. El precio de venta real sigue viviendo unicamente en productos.precio -- esta tabla es metadata de como se llego a el. Acceso exclusivo server-side. Un producto sin fila aca se interpreta como pricing_mode=manual (compatibilidad con el catalogo existente, sin backfill).';

commit;
