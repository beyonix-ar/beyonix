import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  calculateMercadoPagoCheckoutPricing,
  buildMercadoPagoPricingSnapshot,
  getMercadoPagoFinancingCandidates,
  getMercadoPagoModeQuote,
  getMercadoPagoPreferencePaymentMethods,
  MERCADOPAGO_CASH_EXCLUDED_PAYMENT_TYPES,
  type CheckoutPricingLine,
  type CheckoutPricingSettings,
} from "./checkout-pricing.ts"
import { getFinancedPrice, type InterestFreeLookup } from "./financed-pricing.ts"
import { deriveMercadoPagoObservedCosts, resolveInstallmentsFinancing } from "../mercadopago/observed-costs.ts"
import { getMercadoPagoPaymentMedium } from "../mercadopago/payment-medium.ts"
import type { InstallmentCount } from "../products/installments.ts"

// Regla de negocio: 1 pago = CONTADO; cuotas = financiado con el costo del
// TIER (la cuota sin interés más alta que Mercado Pago confirma para ESE
// monto). La configuración del producto sólo limita qué cuotas admite.

const CONFIG = { baseProcessingPercent: 3.46, ivaPercent: 21, surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 } }
const SETTINGS: CheckoutPricingSettings = { installmentsFinancing: CONFIG, transferDiscountPercent: 10, nationalTaxesIncidencePercent: 21 }

/**
 * Mercado Pago SIMULADO (sólo en el test): confirma 2/3 desde `twoThree` y
 * 2/3/6 desde `six`. En producción estos montos los informa Mercado Pago.
 */
function fakeMercadoPago(twoThree: number, six: number): InterestFreeLookup {
  return (amount) => (amount >= six ? [2, 3, 6] : amount >= twoThree ? [2, 3] : [])
}
const MP = fakeMercadoPago(33_000, 60_000)

function line(productId: number, unitPrice: number, quantity = 1): CheckoutPricingLine {
  return { productId, variantId: productId, conditionedStockId: null, quantity, unitPrice }
}

function pricing(lines: CheckoutPricingLine[], interestFreeLookup: InterestFreeLookup | null, credit = 0) {
  return calculateMercadoPagoCheckoutPricing({
    lines,
    shippingCharged: 0,
    storeBenefitPercent: null,
    requestedCustomerCredit: credit,
    settings: SETTINGS,
    interestFreeLookup,
  })
}

test("CASO A: Mercado Pago no habilita cuotas sin interés -> sólo 1 pago a precio contado", () => {
  const result = pricing([line(1, 20_000)], MP)
  assert.equal(result.financed, null)
  assert.equal(result.financedTotal, null)
  assert.equal(result.offeredInstallmentCount, null)
  assert.deepEqual(result.installmentPlans, [])
  assert.equal(result.cash.total, 20_000)
  assert.equal(result.cash.preferenceMaxInstallments, 1)
})

test("CASO B: MP habilita 2 y 3 -> el financiado usa el costo de 3 (nunca el de 6)", () => {
  const result = pricing([line(1, 30_000)], MP)
  assert.equal(result.offeredInstallmentCount, 3, "tier = 3")
  assert.equal(result.financed?.total, getFinancedPrice(30_000, 3, CONFIG))
  assert.notEqual(result.financed?.total, getFinancedPrice(30_000, 6, CONFIG))
  assert.deepEqual(result.installmentPlans.map((plan) => plan.count), [2, 3], "no se ofrece 6")
  assert.equal(result.financed?.preferenceMaxInstallments, 3)
})

test("CASO C: MP habilita 2, 3 y 6 -> el financiado usa el costo de 6", () => {
  const result = pricing([line(1, 50_000)], MP)
  assert.equal(result.offeredInstallmentCount, 6)
  assert.equal(result.financed?.total, getFinancedPrice(50_000, 6, CONFIG))
  assert.deepEqual(result.installmentPlans.map((plan) => plan.count), [2, 3, 6])
})

test("CASO D: cliente elige 2 con tier 3 -> mismo total calculado con el costo de 3; la preferencia preselecciona 2", () => {
  const result = pricing([line(1, 30_000)], MP)
  const total = result.financed!.externalAmountDue
  const two = result.installmentPlans.find((plan) => plan.count === 2)!
  const three = result.installmentPlans.find((plan) => plan.count === 3)!
  assert.equal(Math.round(two.amount * 2 * 100), Math.round(total * 100))
  assert.equal(Math.round(three.amount * 3 * 100), Math.round(total * 100), "2 o 3: el total no cambia")
  const snapshot = buildMercadoPagoPricingSnapshot({ pricing: result, mode: "financed", settings: SETTINGS, economicFingerprint: "fp", selectedInstallmentCount: 2 })
  assert.equal(snapshot.financingTier, 3)
  assert.equal(snapshot.selectedInstallmentCount, 2)
  assert.equal(snapshot.finalTotal, result.financed!.total)
  const paymentMethods = getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: snapshot })
  assert.equal(paymentMethods.installments, 3)
  assert.equal(paymentMethods.default_installments, 2)
})

test("CASO E: cliente elige 2 o 3 con tier 6 -> el total sigue calculado con el costo de 6", () => {
  const result = pricing([line(1, 50_000)], MP)
  for (const count of [2, 3, 6] as InstallmentCount[]) {
    const plan = result.installmentPlans.find((item) => item.count === count)!
    assert.equal(Math.round(plan.amount * count * 100), Math.round(result.financed!.externalAmountDue * 100), String(count))
  }
  for (const selected of [2, 3] as InstallmentCount[]) {
    const snapshot = buildMercadoPagoPricingSnapshot({ pricing: result, mode: "financed", settings: SETTINGS, economicFingerprint: "fp", selectedInstallmentCount: selected })
    assert.equal(snapshot.finalTotal, getFinancedPrice(50_000, 6, CONFIG))
    assert.deepEqual(getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: snapshot }).installments, 6)
  }
})

test("CASO F: 1 pago -> precio contado SIEMPRE (también con crédito), nunca financiado", () => {
  for (const cash of [20_000, 30_000, 50_000]) {
    const result = pricing([line(1, cash)], MP)
    const quote = getMercadoPagoModeQuote(result, "cash")!
    assert.equal(quote.total, cash)
    assert.equal(quote.preferenceMaxInstallments, 1)
    const snapshot = buildMercadoPagoPricingSnapshot({ pricing: result, mode: "cash", settings: SETTINGS, economicFingerprint: "fp" })
    assert.equal(snapshot.finalTotal, cash)
    assert.equal(snapshot.financingTier, null)
    const paymentMethods = getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: snapshot })
    assert.deepEqual(paymentMethods, { installments: 1, default_installments: 1, excluded_payment_types: [{ id: "ticket" }, { id: "atm" }] })
  }
  assert.ok(!MERCADOPAGO_CASH_EXCLUDED_PAYMENT_TYPES.some((type) => type.id === "credit_card"), "crédito en 1 pago permitido")
  // Crédito en 1 pago con la modalidad 1 pago: coincide (no va a revisión).
  assert.equal(getMercadoPagoPaymentMedium({ payment_type_id: "credit_card", installments: 1 }, "mercadopago_cash").matches_checkout_modality, true)
  // Con modalidad cuotas, pagar 1 pago en Mercado Pago queda marcado para revisión.
  assert.equal(getMercadoPagoPaymentMedium({ payment_type_id: "credit_card", installments: 1 }, "mercadopago_financed").matches_checkout_modality, false)
})

test("CASO G: MP cambia la disponibilidad entre la pantalla y el servidor -> otro total; el servidor responde 409", () => {
  const shown = pricing([line(1, 50_000)], MP)
  const atServer = pricing([line(1, 50_000)], fakeMercadoPago(33_000, 90_000))
  assert.equal(shown.offeredInstallmentCount, 6)
  assert.equal(atServer.offeredInstallmentCount, 3)
  assert.notEqual(shown.financed!.externalAmountDue, atServer.financed!.externalAmountDue, "no se cobra con otro total")

  const route = readFileSync(new URL("../../app/api/mercadopago/create-preference/route.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  // Cuota elegida que ya no está confirmada: 409 antes de cualquier efecto.
  assert.match(route, /!pricing\.interestFreeInstallmentCounts\.includes\(selectedInstallmentCount\)/)
  assert.match(route, /code: "PRICING_CHANGED",\s*error: INSTALLMENTS_CHANGED_MESSAGE/)
  // Total o tier distinto al mostrado: 409.
  assert.match(route, /Math\.abs\(expectedTotal - quote\.externalAmountDue\) > 0\.009/)
  assert.match(route, /expectedMaxInstallments !== quote\.preferenceMaxInstallments/)
  assert.ok(route.indexOf("INSTALLMENTS_CHANGED_MESSAGE,") < route.indexOf(".insert(orderPayload"))
})

test("CASO H: MP falla -> sin cuotas, 1 pago a precio contado y sin 'sin interés'", () => {
  for (const failing of [null, () => null] as Array<InterestFreeLookup | null>) {
    const result = pricing([line(1, 50_000)], failing)
    assert.equal(result.financed, null)
    assert.deepEqual(result.installmentPlans, [])
    assert.equal(result.cash.total, 50_000)
  }
  // Consultando el tier más alto: no baja a uno menor (no muestra un precio que después cambia).
  assert.equal(pricing([line(1, 50_000)], (amount) => (amount > 60_000 ? undefined : [2, 3])).financed, null)
})

test("CASO I: no mezcla medios -- dinero en cuenta, débito, crédito 1/3/6 tienen observaciones propias", () => {
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T12:00:00.000Z`
  const row = (id: number, day: number, type: string, installments: number, fees: Array<{ type: string; amount: number }>) => ({
    id, paid_at: at(day),
    mercadopago_payment_snapshot: { installments, transaction_amount: 100_000, fee_details: fees, payment_type_id: type },
  })
  const observed = deriveMercadoPagoObservedCosts(
    [
      row(1, 29, "account_money", 1, [{ type: "mercadopago_fee", amount: 3_000 }]),
      row(2, 28, "debit_card", 1, [{ type: "mercadopago_fee", amount: 2_000 }]),
      row(3, 27, "credit_card", 1, [{ type: "mercadopago_fee", amount: 4_235 }]),
      row(4, 26, "credit_card", 3, [{ type: "mercadopago_fee", amount: 4_235 }, { type: "financing_fee", amount: 12_100 }]),
      row(5, 25, "credit_card", 6, [{ type: "mercadopago_fee", amount: 4_235 }, { type: "financing_fee", amount: 24_200 }]),
    ],
    new Date("2026-09-30T00:00:00.000Z"),
  )
  assert.equal(observed.base?.orderId, 3, "base = crédito 1 pago, nunca dinero en cuenta ni débito")
  assert.equal(observed.surchargeByCount[3]?.orderId, 4)
  assert.equal(observed.surchargeByCount[6]?.orderId, 5, "3 cuotas no toca 6")
  assert.equal(observed.surchargeByCount[2], null)
  const { effective } = resolveInstallmentsFinancing(CONFIG, "automatic", observed)
  assert.equal(effective.baseProcessingPercent, 3.5)
  assert.equal(effective.surchargePercentByCount[3], 10)
  assert.equal(effective.surchargePercentByCount[6], 20)
  assert.equal(effective.surchargePercentByCount[2], CONFIG.surchargePercentByCount[2], "sin observación: respaldo")
})

test("CASO J: precio mostrado = precio enviado -- mismo cálculo, mismos montos consultados, mismo total en la preferencia", () => {
  const input = { lines: [line(1, 30_000, 2)], shippingCharged: 5_000, storeBenefitPercent: null, requestedCustomerCredit: 0, settings: SETTINGS }
  // El cliente y el servidor consultan exactamente los mismos montos.
  const candidates = getMercadoPagoFinancingCandidates(input)
  const shown = calculateMercadoPagoCheckoutPricing({ ...input, interestFreeLookup: MP })
  const sent = calculateMercadoPagoCheckoutPricing({ ...input, interestFreeLookup: MP })
  assert.deepEqual(sent, shown)
  // El monto del tier elegido ES el monto consultado a Mercado Pago (total real del carrito, con envío).
  assert.equal(candidates.find((candidate) => candidate.count === shown.offeredInstallmentCount)?.amount, shown.financed?.externalAmountDue)
  const snapshot = buildMercadoPagoPricingSnapshot({ pricing: sent, mode: "financed", settings: SETTINGS, economicFingerprint: "fp", selectedInstallmentCount: 3 })
  assert.equal(snapshot.externalAmountDue, shown.financed?.externalAmountDue)

  // La preferencia cobra exactamente externalAmountDue de la orden.
  const route = readFileSync(new URL("../../app/api/mercadopago/create-preference/route.ts", import.meta.url), "utf8")
  assert.match(route, /unit_price: externalAmountDue,/)
})

test("carrito: usa el TOTAL real (2 x $20.000 califica aunque 1 unidad no); todas las líneas con el mismo tier", () => {
  assert.equal(pricing([line(1, 20_000)], MP).financed, null, "1 unidad: no califica")
  const two = pricing([line(1, 20_000, 2)], MP)
  assert.equal(two.offeredInstallmentCount, 3, "2 unidades: califica para 2/3")
  // Varios productos: ninguno tiene topes propios, el tier sale del total.
  const mixed = pricing([line(1, 40_000), line(2, 30_000)], MP)
  assert.equal(mixed.offeredInstallmentCount, 6)
  assert.equal(mixed.financedTotal, getFinancedPrice(40_000, 6, CONFIG)! + getFinancedPrice(30_000, 6, CONFIG)!)
})
