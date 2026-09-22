-- Rediseño de precios/cuotas/financiación: agrega el snapshot histórico
-- necesario para reconstruir contado/transferencia/financiado, CFTEA y
-- precio sin impuestos nacionales de un pedido sin depender de la
-- configuración vigente al momento de leerlo (ver lib/pricing/financed-pricing.ts).
--
-- No se toca ninguna migración ya aplicada ni se reescriben datos
-- existentes -- sólo columnas nuevas, nullable, sin default que afecte
-- filas históricas.

alter table public.ordenes
  add column if not exists pricing_snapshot jsonb,
  add column if not exists installments_max_eligible_count smallint;

alter table public.ordenes
  drop constraint if exists ordenes_installments_max_eligible_count_check;

alter table public.ordenes
  add constraint ordenes_installments_max_eligible_count_check
  check (installments_max_eligible_count is null or installments_max_eligible_count in (2, 3, 6));

comment on column public.ordenes.pricing_snapshot is
  'Snapshot histórico completo de precios al momento de la venta: cashPriceTotal, transferPriceTotal, financedPriceTotal, maxInstallmentCount, feeConfig (installmentsFinancing vigente), transferDiscountPercent, nationalTaxesIncidencePercent, cftea ({monthlyRate, annualPercent} o null en pago único), priceWithoutNationalTaxes ({cash, financed}). Nunca se recalcula retroactivamente si cambia la configuración -- ver lib/pricing/financed-pricing.ts.';

comment on column public.ordenes.installments_max_eligible_count is
  'Máxima cuota (2/3/6) habilitada en el carrito al momento de la venta -- puede diferir de installments_count (la cuota que el cliente efectivamente eligió). null si no había ninguna cuota habilitada o el pago no fue con Mercado Pago.';
