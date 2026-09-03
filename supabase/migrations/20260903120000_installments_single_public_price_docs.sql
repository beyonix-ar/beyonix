-- Corrección de modelo: precio público único. Elegir cuotas en Checkout ya
-- NO recalcula el total (el gross-up vivía en
-- lib/products/installments.ts:calculateInstallmentPlan, eliminado, y en su
-- uso en app/checkout/page.tsx y app/api/mercadopago/create-preference).
-- No hay cambio de esquema: sólo se documentan de nuevo estas columnas para
-- que su semántica quede clara en órdenes NUEVAS. Las órdenes históricas
-- creadas bajo el modelo viejo (con installments_surcharge_amount > 0)
-- conservan su valor tal cual -- este comentario no reescribe datos.

comment on column public.ordenes.installments_count is
  'Cantidad de cuotas elegida por el cliente (2/3/6), null si pagó de otra forma. Snapshot histórico: no se recalcula si cambia la configuración global. Desde la corrección de precio público único, elegir cuotas nunca cambia el total del pedido.';
comment on column public.ordenes.installments_percent is
  'Costo interno EFECTIVO de Mercado Pago (comisión + IVA) para esa modalidad al momento de la venta -- puramente informativo/auditoría, NUNCA se usa para aumentar el total cobrado al cliente.';
comment on column public.ordenes.installments_products_base_amount is
  'Base de productos netos + envío efectivamente cobrado. Desde la corrección de precio público único, coincide con el total del pedido (antes del descuento de transferencia, que no aplica a Mercado Pago).';
comment on column public.ordenes.installments_surcharge_amount is
  'Recargo cobrado al cliente por elegir cuotas. Desde la corrección de precio público único, siempre 0 en órdenes nuevas -- el precio público no cambia según la cantidad de cuotas. Órdenes históricas anteriores a esta corrección pueden tener un valor > 0 (modelo viejo, no se reescribe retroactivamente).';
