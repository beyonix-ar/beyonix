-- Reconciliación del contrato de envío persistido por los checkouts.
-- Estos campos existían en el SQL histórico, pero no en una migración
-- ejecutable por Supabase CLI.

alter table public.ordenes
  add column if not exists cp_destino text,
  add column if not exists localidad text,
  add column if not exists provincia text,
  add column if not exists shipping_provider text,
  add column if not exists shipping_type text,
  add column if not exists shipping_cost_real numeric(12, 2),
  add column if not exists shipping_cost_charged numeric(12, 2),
  add column if not exists free_shipping_applied boolean not null default false;

comment on column public.ordenes.cp_destino is
  'Código postal de destino validado durante el checkout.';
comment on column public.ordenes.shipping_provider is
  'Proveedor de la cotización de envío validada por el servidor.';
comment on column public.ordenes.shipping_type is
  'Modalidad de entrega de la cotización validada.';
comment on column public.ordenes.shipping_cost_real is
  'Costo real de envío validado por el servidor.';
comment on column public.ordenes.shipping_cost_charged is
  'Costo de envío efectivamente cobrado al cliente.';
comment on column public.ordenes.free_shipping_applied is
  'Indica si el checkout aplicó el beneficio de envío gratis.';

notify pgrst, 'reload schema';
