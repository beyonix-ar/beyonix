import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  calculateCftea,
  getCartFinancedTotal,
  getFinancedPrice,
  getInstallmentPlans,
  getProductFinancedPrice,
  hasInstallmentsWithoutSurcharge,
  INSTALLMENTS_COPY,
} from "./financed-pricing.ts"
import {
  buildCheckoutEconomicState,
  buildMercadoPagoPricingSnapshot,
  calculateMercadoPagoCheckoutPricing,
  getCheckoutSummaryLineAmounts,
  getMercadoPagoOrderInstallmentsFields,
  getMercadoPagoSummaryBreakdown,
  stableStringify,
  type CheckoutPricingLine,
  type MercadoPagoCheckoutMode,
} from "./checkout-pricing.ts"
import {
  calculateTargetMarginPrice,
  simulateProductProfitability,
} from "./product-pricing.ts"
import { createCheckoutEconomicFingerprint } from "../mercadopago/checkout-attempt.ts"
import type { InstallmentCount, InstallmentsFinancingConfig } from "../products/installments.ts"

type InstallmentCountList = InstallmentCount[]

// "Mismo precio en contado y cuotas" (productos.cuotas_sin_recargo): toggle
// por producto, default OFF. OFF = fórmula con recargo sin cambios; ON =
// financiado igual al contado, server-side, heredado por las variantes.

const REAL_CONFIG: InstallmentsFinancingConfig = {
  baseProcessingPercent: 6.42,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}
const SETTINGS = {
  installmentsFinancing: REAL_CONFIG,
  transferDiscountPercent: 10,
  nationalTaxesIncidencePercent: 21,
}
const ALL = { cuotas_2_habilitadas: true, cuotas_3_habilitadas: true, cuotas_6_habilitadas: true }
const ALL_WITHOUT_SURCHARGE = { ...ALL, cuotas_sin_recargo: true }
const cents = (value: number) => Math.round(value * 100)
const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n")

function line(
  productId: number,
  unitPrice: number,
  installments: CheckoutPricingLine["installments"],
  { quantity = 1, variantId = null }: { quantity?: number; variantId?: number | null } = {},
): CheckoutPricingLine {
  return { productId, variantId, conditionedStockId: null, quantity, unitPrice, installments }
}

function price(lines: CheckoutPricingLine[], { credit = 0, shipping = 7_500 } = {}) {
  return calculateMercadoPagoCheckoutPricing({
    lines,
    shippingCharged: shipping,
    storeBenefitPercent: null,
    requestedCustomerCredit: credit,
    settings: SETTINGS,
  })
}

function fingerprint(lines: CheckoutPricingLine[], mode: MercadoPagoCheckoutMode) {
  const pricing = price(lines)
  return createCheckoutEconomicFingerprint(
    buildCheckoutEconomicState({
      lines,
      shipping: { provider: "andreani", type: "domicilio", sucursalId: null, costReal: 7_500, costCharged: 7_500, freeShippingApplied: false },
      storeBenefit: null,
      requestedCustomerCredit: 0,
      mode,
      pricing,
      settings: SETTINGS,
    }),
  )
}

test("toggle OFF (default): mismo financiado con recargo que antes", () => {
  for (const product of [ALL, { ...ALL, cuotas_sin_recargo: false }, { ...ALL, cuotas_sin_recargo: null }]) {
    assert.equal(hasInstallmentsWithoutSurcharge(product), false)
    assert.equal(getProductFinancedPrice(product, 100_000, REAL_CONFIG), getFinancedPrice(100_000, 6, REAL_CONFIG))
    assert.equal(INSTALLMENTS_COPY, "cuotas sin interés")
  }
  assert.ok(getProductFinancedPrice(ALL, 100_000, REAL_CONFIG)! > 100_000)
})

test("toggle ON: financiado = contado, cuotas = contado / N, sin CFTEA", () => {
  assert.equal(hasInstallmentsWithoutSurcharge(ALL_WITHOUT_SURCHARGE), true)
  assert.equal(getProductFinancedPrice(ALL_WITHOUT_SURCHARGE, 100_000, REAL_CONFIG), 100_000)
  // Sin redondeo al múltiplo de cuotas: ni un centavo por encima del contado.
  assert.equal(getProductFinancedPrice(ALL_WITHOUT_SURCHARGE, 99_999, REAL_CONFIG), 99_999)
  const plans = getInstallmentPlans(ALL_WITHOUT_SURCHARGE, 90_000, REAL_CONFIG)
  assert.deepEqual(plans, [{ count: 2, amount: 45_000 }, { count: 3, amount: 30_000 }, { count: 6, amount: 15_000 }])
  for (const plan of plans) assert.equal(calculateCftea(90_000, plan.amount, plan.count), null)
  // El copy de cara al cliente es el mismo con la regla activa: "sin interés".
})

test("toggle ON sin cuotas habilitadas: no habilita cuotas por sí solo", () => {
  const onlyFlag = { cuotas_sin_recargo: true }
  assert.equal(hasInstallmentsWithoutSurcharge(onlyFlag), false)
  assert.equal(getProductFinancedPrice(onlyFlag, 100_000, REAL_CONFIG), null)
  assert.deepEqual(getInstallmentPlans(onlyFlag, 100_000, REAL_CONFIG), [])
 assert.equal(price([line(1, 50_000, onlyFlag)]).financed, null)
})

test("checkout todo sin recargo: en cuotas se cobra EXACTAMENTE el contado (sin redondeo) y MP ofrece hasta la cuota máxima", () => {
  const pricing = price([line(1, 33_333, ALL_WITHOUT_SURCHARGE, { quantity: 2 }), line(2, 10_001, ALL_WITHOUT_SURCHARGE)])
  assert.equal(pricing.installmentsPricingRule, "without_surcharge")
  assert.deepEqual(pricing.installmentsWithoutSurchargeProductIds, [1, 2])
  assert.equal(pricing.cashTotal, 33_333 * 2 + 10_001 + 7_500)
  assert.equal(pricing.financedTotal, pricing.cashTotal)
  assert.equal(pricing.financed?.total, pricing.cashTotal)
  assert.equal(pricing.financed?.externalAmountDue, pricing.cashTotal)
  assert.equal(pricing.financed?.roundingAdjustment, 0)
  assert.equal(pricing.financed?.preferenceMaxInstallments, 6)
  assert.equal(pricing.cash.preferenceMaxInstallments, 1)
  assert.equal(pricing.installmentPlans.length, 3)
  for (const plan of pricing.installmentPlans) assert.equal(plan.cfteaPercent, null)

  const summary = getMercadoPagoSummaryBreakdown(pricing, "financed")
  assert.deepEqual(summary, getMercadoPagoSummaryBreakdown(pricing, "cash"))
  const financedLines = getCheckoutSummaryLineAmounts({
    lines: [line(1, 33_333, ALL_WITHOUT_SURCHARGE, { quantity: 2 }), line(2, 10_001, ALL_WITHOUT_SURCHARGE)],
    mode: "financed",
    installmentsFinancing: REAL_CONFIG,
    productsSubtotal: summary.productsSubtotal,
  })
  assert.deepEqual(financedLines, [66_666, 10_001])
})

test("MP en 1 pago (contado) no cambia con el toggle", () => {
  const off = price([line(1, 80_000, ALL)])
  const on = price([line(1, 80_000, ALL_WITHOUT_SURCHARGE)])
  assert.deepEqual(on.cash, off.cash)
  assert.equal(on.cashTotal, off.cashTotal)
  assert.ok(off.financed!.total > on.financed!.total)
  assert.equal(on.financed!.total, on.cashTotal)
})

test("carrito mixto: la línea sin recargo aporta su contado y la otra su financiado; se conserva el redondeo de cuotas", () => {
  const lines = [line(1, 100_000, ALL_WITHOUT_SURCHARGE), line(2, 50_000, ALL)]
  const pricing = price(lines, { shipping: 0 })
  assert.equal(pricing.installmentsPricingRule, "mixed")
  assert.deepEqual(pricing.installmentsWithoutSurchargeProductIds, [1])
  assert.equal(pricing.financedTotal, 100_000 + getFinancedPrice(50_000, 6, REAL_CONFIG)!)
  assert.equal(
    getCartFinancedTotal(
      [
        { cashPrice: 100_000, maxEligibleCount: 6, quantity: 1, withoutSurcharge: true },
        { cashPrice: 50_000, maxEligibleCount: 6, quantity: 1 },
      ],
      REAL_CONFIG,
    ),
    pricing.financedTotal,
  )
  for (const plan of pricing.installmentPlans) {
    assert.equal(cents(plan.amount) * plan.count, cents(pricing.financed!.externalAmountDue))
  }
  const productsSubtotal = getMercadoPagoSummaryBreakdown(pricing, "financed").productsSubtotal
  const amounts = getCheckoutSummaryLineAmounts({ lines, mode: "financed", installmentsFinancing: REAL_CONFIG, productsSubtotal })
  // El ajuste de redondeo de cuotas va a la línea CON recargo; la otra muestra su contado exacto.
  assert.equal(amounts[0], 100_000)
  assert.equal(cents(amounts[0]) + cents(amounts[1]), cents(productsSubtotal))
  assert.ok(amounts[1] >= getFinancedPrice(50_000, 6, REAL_CONFIG)!)
  // La intersección de cuotas sigue mandando: si el otro producto admite hasta 3, se ofrece hasta 3.
  const capped = price([line(1, 100_000, ALL_WITHOUT_SURCHARGE), line(2, 50_000, { cuotas_3_habilitadas: true })])
  assert.equal(capped.maxInstallmentCount, 3)
})

test("variantes heredan la regla del producto, cada una con su propio precio", () => {
  const lines = [
    line(7, 120_000, ALL_WITHOUT_SURCHARGE, { variantId: 1 }),
    line(7, 125_500, ALL_WITHOUT_SURCHARGE, { variantId: 2 }),
  ]
  const pricing = price(lines, { shipping: 0 })
  assert.equal(pricing.installmentsPricingRule, "without_surcharge")
  assert.deepEqual(pricing.installmentsWithoutSurchargeProductIds, [7])
  assert.equal(pricing.financedTotal, 245_500)
  assert.equal(getInstallmentPlans(ALL_WITHOUT_SURCHARGE, 125_500, REAL_CONFIG)[2].amount, 125_500 / 6)
})

test("saldo a favor sin recargo: external = total - saldo exacto (sin llevar el saldo al múltiplo de cuotas)", () => {
  const pricing = price([line(1, 100_001, ALL_WITHOUT_SURCHARGE)], { credit: 1_234.56, shipping: 0 })
  assert.equal(pricing.financed?.total, 100_001)
  assert.equal(pricing.financed?.customerCreditApplied, 1_234.56)
  assert.equal(pricing.financed?.externalAmountDue, 98_766.44)
  assert.equal(pricing.financed?.externalAmountDue, pricing.cash.externalAmountDue)
})

test("snapshot de la orden: guarda la regla usada, sin recargo y el total persistido = contado", () => {
  const onPricing = price([line(1, 60_000, ALL_WITHOUT_SURCHARGE)])
  const snapshot = buildMercadoPagoPricingSnapshot({ pricing: onPricing, mode: "financed", settings: SETTINGS, economicFingerprint: "fp" })
  assert.equal(snapshot.installmentsPricingRule, "without_surcharge")
  assert.deepEqual(snapshot.installmentsWithoutSurchargeProductIds, [1])
  assert.equal(snapshot.finalTotal, snapshot.cashPriceTotal)
  assert.equal(snapshot.installmentsRoundingAdjustment, 0)
  assert.equal(snapshot.cftea, null)
  assert.deepEqual(snapshot.cfteaByCount, {})
  assert.equal(snapshot.mercadoPagoModality, "mercadopago_financed")
  assert.equal(snapshot.preferenceMaxInstallments, 6)
  assert.equal(getMercadoPagoOrderInstallmentsFields(onPricing, "financed", REAL_CONFIG)?.surchargeAmount, 0)

  const offPricing = price([line(1, 60_000, ALL)])
  const offSnapshot = buildMercadoPagoPricingSnapshot({ pricing: offPricing, mode: "financed", settings: SETTINGS, economicFingerprint: "fp" })
  assert.equal(offSnapshot.installmentsPricingRule, "surcharge")
  assert.deepEqual(offSnapshot.installmentsWithoutSurchargeProductIds, [])
  assert.ok(getMercadoPagoOrderInstallmentsFields(offPricing, "financed", REAL_CONFIG)!.surchargeAmount > 0)
})

test("fingerprint: OFF idéntico al de antes (sin clave nueva); cambiar el toggle invalida el intento de MP", () => {
  const offLines = [line(1, 60_000, ALL)]
  const offState = buildCheckoutEconomicState({
    lines: offLines,
    shipping: { provider: "andreani", type: "domicilio", sucursalId: null, costReal: 7_500, costCharged: 7_500, freeShippingApplied: false },
    storeBenefit: null,
    requestedCustomerCredit: 0,
    mode: "financed",
    pricing: price(offLines),
    settings: SETTINGS,
  })
  assert.doesNotMatch(stableStringify(offState), /withoutSurcharge/)
  assert.equal(fingerprint([line(1, 60_000, { ...ALL, cuotas_sin_recargo: false })], "financed"), fingerprint(offLines, "financed"))

  const onLines = [line(1, 60_000, ALL_WITHOUT_SURCHARGE)]
  assert.notEqual(fingerprint(onLines, "financed"), fingerprint(offLines, "financed"))
  // También al contado (mismos totales): la regla es parte de las condiciones de la línea.
  assert.notEqual(fingerprint(onLines, "cash"), fingerprint(offLines, "cash"))
})

test("server-side: create-preference toma la regla de la BASE (no del navegador) y Admin la guarda validada", () => {
  // El producto se relee con el flag en cada checkout; las líneas usan esa fila.
  assert.match(read("lib/orders/checkout-order-creation.ts"), /cuotas_6_habilitadas, cuotas_sin_recargo"/)
  assert.match(read("app/api/mercadopago/create-preference/route.ts"), /installments: row\.product,/)
  // Admin: toggle, payload y validación del tipo antes de la RPC.
  const form = read("app/admin/sections/productos/producto-form.tsx")
  assert.match(form, /Mismo precio en contado y cuotas/)
  assert.match(form, /onClick=\{\(\) => setField\("cuotasSinRecargo", !form\.cuotasSinRecargo\)\}/)
  const hook = read("app/admin/sections/productos/use-producto-form.tsx")
  assert.match(hook, /cuotasSinRecargo: producto\?\.cuotas_sin_recargo \?\? false/)
  assert.match(hook, /cuotas_sin_recargo:\s*form\.cuotasSinRecargo/)
  const route = read("app/api/admin/products/[id]/catalog/route.ts")
  assert.match(route, /typeof catalogInput\.cuotas_sin_recargo !== "boolean"/)
  assert.match(route, /installmentsWithoutSurcharge: catalogInput\.cuotas_sin_recargo === true/)
  assert.match(read("app/api/admin/products/[id]/pricing/route.ts"), /installmentsWithoutSurcharge: product\.cuotas_sin_recargo === true/)
})

test("rentabilidad en Admin: sin recargo las cuotas se cobran al contado y cuentan para el peor caso y el margen objetivo", () => {
  const input = { price: 100_000, cost: 60_000, eligibleInstallmentCounts: [2, 3, 6] as InstallmentCountList, config: REAL_CONFIG, transferDiscountPercent: 10 }
  const off = simulateProductProfitability(input)!
  const on = simulateProductProfitability({ ...input, installmentsWithoutSurcharge: true })!
  const off6 = off.scenarios.find((scenario) => scenario.id === "mp_6")!
  const on6 = on.scenarios.find((scenario) => scenario.id === "mp_6")!
  assert.ok(off6.price > 100_000)
  assert.equal(on6.price, 100_000)
  assert.equal(on6.priceBasis, "cash")
  assert.ok(on6.profitAmount < off6.profitAmount)
  assert.equal(on.worstCase.id, "mp_6")
  assert.notEqual(off.worstCase.id, "mp_6")

  const target = { cost: 60_000, targetMarginPercent: 20, eligibleInstallmentCounts: [2, 3, 6] as InstallmentCountList, config: REAL_CONFIG, transferDiscountPercent: 10 }
  const targetOff = calculateTargetMarginPrice(target)!
  const targetOn = calculateTargetMarginPrice({ ...target, installmentsWithoutSurcharge: true })!
  assert.ok(targetOn.commercialPrice > targetOff.commercialPrice)
  assert.equal(targetOn.worstCaseScenario.id, "mp_6")
  assert.ok(targetOn.resultingMarginPercent >= 20)
})
