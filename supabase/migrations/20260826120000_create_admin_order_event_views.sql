begin;

create table if not exists public.admin_order_event_views (
  admin_id uuid not null references auth.users(id) on delete cascade,
  order_id bigint not null references public.ordenes(id) on delete cascade,
  event_type text not null check (event_type in ('payment_proof', 'order_summary')),
  event_at timestamptz not null,
  seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (admin_id, order_id, event_type)
);

create index if not exists admin_order_event_views_order_id_idx
  on public.admin_order_event_views (order_id);

alter table public.admin_order_event_views enable row level security;

revoke all on table public.admin_order_event_views from public, anon, authenticated;
grant select, insert, update, delete on table public.admin_order_event_views to service_role;

comment on table public.admin_order_event_views is
  'Estado de lectura de eventos de pedidos por administrador; acceso exclusivo server-side.';

commit;
