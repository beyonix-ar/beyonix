alter table public.ordenes
  add column if not exists cp_destino text,
  add column if not exists localidad text,
  add column if not exists provincia text,
  add column if not exists shipping_provider text,
  add column if not exists shipping_type text,
  add column if not exists shipping_cost_real numeric(12, 2),
  add column if not exists shipping_cost_charged numeric(12, 2),
  add column if not exists free_shipping_applied boolean not null default false;
