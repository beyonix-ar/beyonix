alter table public.productos
  add column if not exists promo_event_id uuid null,
  add column if not exists promo_original_precio numeric null,
  add column if not exists promo_original_precio_anterior numeric null,
  add column if not exists promo_original_descuento integer null,
  add column if not exists promo_original_cuotas_sin_interes boolean null,
  add column if not exists promo_original_cuotas_maximas integer null;

create index if not exists productos_promo_event_id_idx
  on public.productos(promo_event_id);
