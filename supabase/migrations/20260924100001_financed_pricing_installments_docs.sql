-- Reversión deliberada del modelo de "precio público único" documentado en
-- 20260903120000_installments_single_public_price_docs.sql: BEYONIX vuelve
-- a un precio FINANCIADO mayor al contado (gross-up), calculado siempre con
-- la comisión de la cuota MÁXIMA habilitada por publicación, con las
-- disclosures legales correspondientes (CFTEA, precio sin impuestos
-- nacionales -- ver pricing_snapshot en 20260924100000).
--
-- No se edita la migración anterior ni se reescriben datos: sólo se
-- documentan de nuevo estas columnas para que su semántica quede clara en
-- órdenes NUEVAS a partir de esta corrección. Las órdenes creadas bajo el
-- modelo de precio único (entre 20260903120000 y esta migración) conservan
-- legítimamente installments_surcharge_amount = 0 -- eso no es un error, es
-- el comportamiento correcto de ese período; no se reescribe.

comment on column public.ordenes.installments_count is
  'Cantidad de cuotas EFECTIVAMENTE elegida por el cliente (2/3/6), null si pagó de otra forma. Snapshot histórico: no se recalcula si cambia la configuración global. Puede ser menor que installments_max_eligible_count -- el total financiado se calcula igual con la cuota máxima, elegir menos cuotas sólo cambia cuánto vale cada una.';
comment on column public.ordenes.installments_percent is
  'Costo interno EFECTIVO de Mercado Pago (comisión + IVA) para la cuota MÁXIMA habilitada al momento de la venta -- es la tasa usada para calcular installments_surcharge_amount (el gross-up real). El fee REAL que Mercado Pago cobró por la cuota que el cliente efectivamente eligió vive en mercadopago_payment_snapshot, nunca en esta columna -- la diferencia entre ambos es el margen adicional intencional cuando el cliente elige menos cuotas que el máximo.';
comment on column public.ordenes.installments_products_base_amount is
  'Base de productos netos + envío a precio de CONTADO (antes del gross-up financiado). installments_surcharge_amount = total del pedido - esta base.';
comment on column public.ordenes.installments_surcharge_amount is
  'Recargo real cobrado al cliente por elegir financiar en cuotas (precio financiado - precio de contado), calculado con la cuota máxima habilitada. > 0 en toda orden nueva con installments_count no nulo. Las órdenes creadas bajo el modelo de precio único (installments_single_public_price_docs, ya superado) tienen legítimamente 0 -- no se reescriben retroactivamente.';
