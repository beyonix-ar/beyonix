-- Financiación Mercado Pago — paso 2/2 (transacción separada a propósito,
-- ver comentario en 20260827100000): elimina las columnas excluyentes
-- viejas, agrega la persistencia de la modalidad financiera vendida en
-- cada orden, y la configuración global del costo financiero.

alter table public.productos
  drop column if exists cuotas_sin_interes,
  drop column if exists cuotas_maximas,
  drop column if exists promo_original_cuotas_sin_interes,
  drop column if exists promo_original_cuotas_maximas;

-- ─────────────────────────────────────────────────────────────
-- ordenes: snapshot histórico de la modalidad financiera vendida
-- ─────────────────────────────────────────────────────────────

alter table public.ordenes
  add column if not exists installments_count smallint,
  add column if not exists installments_percent numeric(5, 2),
  add column if not exists installments_products_base_amount numeric(12, 2),
  add column if not exists installments_surcharge_amount numeric(12, 2),
  add column if not exists mercadopago_payment_snapshot jsonb;

alter table public.ordenes
  drop constraint if exists ordenes_installments_count_check;

alter table public.ordenes
  add constraint ordenes_installments_count_check
  check (installments_count is null or installments_count in (2, 3, 6));

comment on column public.ordenes.installments_count is
  'Cantidad de cuotas sin interés elegida por el cliente (2/3/6), null si pagó de otra forma. Snapshot: no se recalcula si cambia la configuración global.';
comment on column public.ordenes.installments_percent is
  'Porcentaje financiero EFECTIVO aplicado en el momento de la venta (ya incluye costo base + costo por cuotas + IVA + margen de seguridad).';
comment on column public.ordenes.installments_products_base_amount is
  'Base financiable (productos netos + envío efectivamente cobrado) antes del recargo por financiación.';
comment on column public.ordenes.installments_surcharge_amount is
  'Recargo efectivamente cobrado por la financiación (incluye el redondeo comercial a $100).';
comment on column public.ordenes.mercadopago_payment_snapshot is
  'Snapshot acotado del payment real de Mercado Pago al aprobarse (installments, transaction_amount, fee_details, transaction_details), para poder mostrar a futuro costos/neto reales.';

-- ─────────────────────────────────────────────────────────────
-- site_settings: configuración global del costo financiero (nunca hardcodeado)
-- ─────────────────────────────────────────────────────────────

insert into public.site_settings (key, value, description)
values (
  'installments_financing',
  jsonb_build_object(
    'baseProcessingPercent', 6.42,
    'ivaPercent', 21,
    'surchargePercentByCount', jsonb_build_object('2', 7.79, '3', 10.49, '6', 18.69)
  ),
  'Costos reales de Mercado Pago usados para construir las modalidades de cuotas sin interés (costo base de procesamiento, IVA, y costo adicional por cantidad de cuotas).'
)
on conflict (key) do nothing;
