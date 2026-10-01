import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  buildMercadoPagoPricingSnapshot,
  calculateMercadoPagoCheckoutPricing,
  getMercadoPagoModeQuote,
  getMercadoPagoPreferencePaymentMethods,
  type CheckoutPricingLine,
  type CheckoutPricingSettings,
} from "../../lib/pricing/checkout-pricing.ts"
import {
  getCheckoutInstallmentsOptionCopy,
  type InterestFreeLookup,
} from "../../lib/pricing/financed-pricing.ts"

// Checkout Pro deja elegir la cantidad de cuotas dentro de Mercado Pago, así
// que BEYONIX muestra UNA opción "Mercado Pago · Cuotas sin interés" con las
// cuotas confirmadas y el precio financiado del tier (la más alta confirmada).

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

const checkout = readSource("../../app/checkout/page.tsx")

const SETTINGS: CheckoutPricingSettings = {
  installmentsFinancing: {
    baseProcessingPercent: 3.46,
    ivaPercent: 21,
    surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
  },
  transferDiscountPercent: 10,
  nationalTaxesIncidencePercent: 21,
}

const LINES: CheckoutPricingLine[] = [
  {
    productId: 1,
    variantId: 1,
    conditionedStockId: null,
    quantity: 1,
    unitPrice: 80_000,
  },
]

function pricingWith(lookup: InterestFreeLookup) {
  return calculateMercadoPagoCheckoutPricing({
    lines: LINES,
    shippingCharged: 0,
    storeBenefitPercent: null,
    requestedCustomerCredit: 0,
    settings: SETTINGS,
    interestFreeLookup: lookup,
  })
}

function paymentList() {
  const start = checkout.indexOf('<fieldset className="grid gap-2.5" data-payment-options>')
  assert.ok(start > 0)
  return checkout.slice(start, checkout.indexOf("</fieldset>", start))
}

test("el checkout muestra UNA sola opción de cuotas (no una tarjeta por 2, 3 y 6), estable aunque el total no alcance", () => {
  const list = paymentList()
  // Transferencia, 1 pago y cuotas; la de cuotas es UNA sola (activa o con el texto global).
  assert.equal((list.match(/<CheckoutPaymentOptionCard/g) ?? []).length, 4)
  assert.equal((list.match(/option="mercadopago_installments"/g) ?? []).length, 2)
  assert.match(list, /\{installmentsOptionCopy && financedPreviewQuote \? \([\s\S]*\) : globalInterestFreeMessage \? \([\s\S]*\) : null\}/)
  assert.match(list, /description=\{globalInterestFreeMessage\.text\}/)
  assert.match(list, /\n\s+disabled\n/)
  assert.match(list, /title="Mercado Pago · 1 pago"/)
  assert.match(list, /title="Mercado Pago · Cuotas sin interés"/)
  assert.doesNotMatch(list, /\.map\(\(plan\) =>/)
  assert.doesNotMatch(checkout, /mercadopago_installments_(2|3|6|\$\{)/)
})

test("MP confirma 2 y 3 -> 'Hasta 3 cuotas sin interés', 'Disponibles: 2 y 3 cuotas' y precio con el costo de 3", () => {
  const pricing = pricingWith(() => [2, 3])
  const copy = getCheckoutInstallmentsOptionCopy(pricing.installmentPlans.map((plan) => plan.count))
  assert.deepEqual(copy, {
    maxCount: 3,
    headline: "Hasta 3 cuotas sin interés",
    available: "Disponibles: 2 y 3 cuotas",
  })
  assert.equal(pricing.offeredInstallmentCount, 3)
  assert.equal(pricing.financed?.preferenceMaxInstallments, 3)
})

test("MP confirma 2, 3 y 6 -> 'Hasta 6 cuotas sin interés', 'Disponibles: 2, 3 y 6 cuotas' y precio con el costo de 6", () => {
  const twoThree = pricingWith(() => [2, 3])
  const pricing = pricingWith(() => [2, 3, 6])
  const copy = getCheckoutInstallmentsOptionCopy(pricing.installmentPlans.map((plan) => plan.count))
  assert.deepEqual(copy, {
    maxCount: 6,
    headline: "Hasta 6 cuotas sin interés",
    available: "Disponibles: 2, 3 y 6 cuotas",
  })
  assert.equal(pricing.offeredInstallmentCount, 6)
  assert.equal(pricing.financed?.preferenceMaxInstallments, 6)
  // El tier 6 cuesta más que el 3: el financiado sigue la cuota más alta confirmada.
  assert.ok(pricing.financed!.externalAmountDue > twoThree.financed!.externalAmountDue)
})

test("sin cuotas confirmadas no hay opción de cuotas (sólo 1 pago)", () => {
  assert.equal(getCheckoutInstallmentsOptionCopy([]), null)
  assert.equal(pricingWith(() => []).financed, null)
  assert.match(paymentList(), /\{installmentsOptionCopy && financedPreviewQuote \? \(/)
})

test("1 pago sigue usando el precio contado; cuotas el financiado del tier, sin mezclar precios", () => {
  const pricing = pricingWith(() => [2, 3, 6])
  const cash = getMercadoPagoModeQuote(pricing, "cash")!
  const financed = getMercadoPagoModeQuote(pricing, "financed")!
  assert.equal(cash.externalAmountDue, pricing.cashTotal)
  assert.equal(cash.preferenceMaxInstallments, 1)
  assert.ok(financed.externalAmountDue > cash.externalAmountDue)

  const cashSnapshot = buildMercadoPagoPricingSnapshot({ pricing, mode: "cash", settings: SETTINGS, economicFingerprint: "fp" })
  assert.equal(getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: cashSnapshot }).installments, 1)

  // Cuotas: hasta el tier y sin preseleccionar cantidad (se elige en Mercado Pago).
  const financedSnapshot = buildMercadoPagoPricingSnapshot({ pricing, mode: "financed", settings: SETTINGS, economicFingerprint: "fp" })
  const methods = getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: financedSnapshot })
  assert.equal(methods.installments, 6)
  assert.equal(methods.default_installments, undefined)
  assert.equal(financedSnapshot.externalAmountDue, financed.externalAmountDue)

  // El total que muestra la opción de cuotas es el mismo que se manda a cobrar.
  assert.match(paymentList(), /\{formatPrice\(financedPreviewQuote\.externalAmountDue\)\}/)
  assert.match(checkout, /mercadoPagoMode: effectiveMercadoPagoMode,/)
})

test("cambiar entre 1 pago y cuotas sólo cambia la modalidad: no reserva, no libera ni vence la reserva", () => {
  const start = checkout.indexOf("const selectPaymentOption = (option: CheckoutPaymentOption) => {")
  assert.ok(start > 0)
  const select = checkout.slice(start, checkout.indexOf("\n  }\n", start))
  assert.match(select, /setMercadoPagoMode\(option === "mercadopago_installments" \? "financed" : "cash"\)/)
  assert.doesNotMatch(select, /reserve|Reservation|startNewCheckoutSession|getCartStockReservation/)
})

test("consultar cuotas a Mercado Pago (o invalidarlas tras un 409) no toca la reserva", () => {
  const hook = readSource("../../hooks/use-interest-free-installments.ts")
  const route = readSource("../../app/api/mercadopago/installments/route.ts")
  for (const source of [hook, route]) {
    assert.doesNotMatch(source, /reserv|cartSessionId|checkout_reservation_sessions|stock_reservations/i)
  }
  // El 409 de recálculo refresca precios/cuotas y avisa; nunca vence la reserva ni navega.
  const start = checkout.indexOf('if (response.status === 409 && data?.code === "PRICING_CHANGED")')
  const block = checkout.slice(start, checkout.indexOf("return\n      }", start))
  assert.match(block, /invalidateInterestFreeInstallments\(\)/)
  assert.doesNotMatch(block, /expireStockReservation|releaseLockedCheckoutSession|router\.|window\.location/)
  // Sólo el código RESERVATION_EXPIRED del servidor (reserva propia vencida) muestra el aviso.
  assert.match(checkout, /if \(!response\.ok && data\?\.code === "RESERVATION_EXPIRED"\) \{\s*expireStockReservation\(\)/)
})
