# Auditoría de costos de Mercado Pago — 10/10/2026

## Circuito comprobado

`GET /v1/payment_methods/installments` (Visa y Mastercard, monto consultado) →
`lib/mercadopago/interest-free-installments.ts` interpreta `payer_costs` →
`lib/mercadopago/interest-free-reference.ts` estima umbrales →
`site_settings.mercadopago_interest_free_reference` → Admin y comunicación de cuotas → checkout vuelve a consultar disponibilidad.

Esto sincroniza la disponibilidad y el costo **del comprador**. No sincroniza la comisión del comercio.
La acción separada «Actualizar desde Mercado Pago» de Medios de pago consulta
`GET /v1/payment_methods` para disponibilidad, identidad y logos; guarda su
estado en `payment_method_logos` y `site_settings.payment_methods_sync`.
Tampoco trae tarifas.
El cron `sync-mercadopago-installments` está programado cada ~15 minutos en systemd.
El último éxito persistido fue `2026-10-10T14:54:01.125Z`; no se verificó el estado del servicio systemd desde este equipo.

Después de un pago, el webhook consulta `GET /v1/payments/{id}` y guarda
`fee_details`, `charges_details`, importe y modalidad en
`ordenes.mercadopago_payment_snapshot`. Admin deriva observaciones por modalidad
de esos snapshots. En la base consultada hay **0 órdenes** con medio Mercado Pago y
0 snapshots. Por ello no hay costo observado ni historial.

`site_settings.installments_financing` tiene modo automático y ceros persistidos
para base, 2/3/6 e IVA. `financed_price_policy` es `cover_costs`. Sin observaciones,
el resolvedor toma los valores manuales, incluidos esos ceros. No se encontró
confirmación de que representen tarifas reales. Los ceros heredados se muestran
ahora en Admin como «Sin configurar» hasta que el administrador los confirme.
El cálculo vigente de checkout sigue usando los números persistidos; no se cambió.

## Respuesta real sanitizada

Consulta de solo lectura a `GET /v1/payment_methods/installments?amount=60000&payment_method_id=visa`
el `2026-10-10T15:05:49Z`: HTTP 200, 68 emisores. Mastercard: HTTP 200, 65 emisores.
Una entrada de Visa, sin identificadores de emisor/cuenta, tokens ni datos personales:

```json
{
  "payment_method_id": "visa",
  "payment_type_id": "credit_card",
  "payer_costs": [
    { "installments": 1, "installment_rate": 0, "labels": ["CFT_0,00%|TEA_0,00%"] },
    { "installments": 2, "installment_rate": 0, "labels": ["interest_deduction_by_collector", "CFT_0,00%|TEA_0,00%"] },
    { "installments": 3, "installment_rate": 0, "labels": ["interest_deduction_by_collector", "CFT_0,00%|TEA_0,00%"] },
    { "installments": 6, "installment_rate": 0, "labels": ["recommended_installment", "interest_deduction_by_collector", "CFT_0,00%|TEA_0,00%"] }
  ],
  "other_payer_cost_fields": ["discount_rate", "reimbursement_rate", "installment_rate_collector", "min_allowed_amount", "max_allowed_amount", "recommended_message", "installment_amount", "total_amount", "payment_method_option_id"]
}
```

La respuesta no tiene `seller_cost`, `merchant_cost`, `processing_fee`,
comisión del comercio ni IVA discriminado. La tasa 0 corresponde al comprador.

Una búsqueda de solo lectura `GET /v1/payments/search` devolvió HTTP 200 y 60
pagos en la cuenta consultada: 52 aprobados en dinero en cuenta, 2 en crédito a
1 pago, 1 en crédito a 4 cuotas, 1 en débito y 2 en transferencia; otros 2
estaban reembolsados. Algunos tenían `fee_details`, `charges_details` y
`net_received_amount`. Hay referencias externas compatibles con BEYONIX, pero
ninguno está asociado a una orden en la base consultada. No se usaron para
inferir tasas ni se divulgan importes, IDs o datos personales.

Una lectura adicional `GET /v1/payments/{id}` de un pago aprobado con dinero
en cuenta devolvió HTTP 200 el `2026-10-10T15:19:36Z` y confirmó
`fee_details[{type: "mercadopago_fee", amount}]`,
`charges_details[{name: "mercadopago_fee", rate, amounts}]` y
`transaction_details.{net_received_amount,total_paid_amount}`. Se omiten
valores y el identificador porque no corresponden a una orden demostrada de
esta base.

Dos pagos aprobados ajenos a la base, uno de crédito a 1 pago y otro de débito,
respondieron HTTP 200 al consultar `/v1/payments/{id}`. El de crédito tenía
`charges_details.name="processing_fee"` sin `rate`; el de débito tenía nombres
`shp_cross_docking`, `meli_percentage_fee` y `flat_fee`, también sin `rate`.
`fee_details` estaba vacío en ambos. El parser actual de BEYONIX sólo reconoce
`mercadopago_fee` para 1 pago; por tanto no debe suponerse que esos pagos
permiten aprender la comisión de BEYONIX ni ampliar el parser a otros cargos
sin asociar primero la transacción a una orden propia y validar su significado.

## Límites y riesgos

- `fee_details` y `charges_details` pueden informar cargos posteriores al pago.
  El neto recibido por sí solo no permite atribuir comisiones: puede incluir
  descuentos, impuestos, retenciones, promociones y devoluciones.
- El IVA no se discrimina en la respuesta de cuotas. El código actual asume
  que el cargo observado incluye IVA y lo divide por `(1 + IVA configurado)`;
  esa hipótesis requiere contraste con factura/reporte de Mercado Pago. Con
  IVA sin confirmar no hay tasa neta verificable.
- El algoritmo actual adopta el último pago válido por modalidad, incluso uno
  solo. Antes de automatizar costos comerciales se necesita evidencia de
  consistencia y tratamiento de valores atípicos.
- El checkout con `cover_costs` y costos persistidos en cero puede subestimar
  costos. Se dejó intacto por alcance expreso de esta fase.
- La versión declarada del SDK es `mercadopago ^2.12.0` (instalada: `2.13.0`); el flujo de
  preferencias de Checkout Pro sigue soportado, pero Mercado Pago documenta
  Orders API como camino recomendado para nuevas integraciones. No se migró.

## Documentación oficial

- [Medios de pago](https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-api-payments/payment-methods/get)
- [Argentina: endpoint de cuotas, TEA y CFT del comprador](https://www.mercadopago.com.ar/developers/es/docs/resources/localization/considerations-argentina)
- [Opciones de cuotas y etiquetas del comprador](https://www.mercadopago.com.ar/developers/es/docs/checkout-api-orders/resources/migrate-payments-to-orders)
- [Referencia de Checkout Pro y pagos](https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-pro-preferences/overview)
- [Campos del reporte de dinero disponible](https://www.mercadopago.com.ar/developers/es/docs/links-and-debts/additional-content/reports/account-money/report-fields)
