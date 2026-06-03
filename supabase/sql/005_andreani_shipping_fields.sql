alter table public.ordenes
  add column if not exists envio_proveedor text,
  add column if not exists andreani_estado text,
  add column if not exists andreani_tracking text,
  add column if not exists andreani_envio_id text,
  add column if not exists andreani_etiqueta_url text,
  add column if not exists andreani_costo numeric(12, 2),
  add column if not exists andreani_error text;
