import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  getFinancedPrice,
  getInstallmentPlans,
  getMaxEligibleInstallmentCount,
} from "../../lib/pricing/financed-pricing.ts"
import type { InstallmentsFinancingConfig } from "../../lib/products/installments.ts"

const REAL_CONFIG: InstallmentsFinancingConfig = {
  baseProcessingPercent: 6.42,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const PRODUCTS_BY_MAX = {
  2: { cuotas_2_habilitadas: true, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false },
  3: { cuotas_2_habilitadas: true, cuotas_3_habilitadas: true, cuotas_6_habilitadas: false },
  6: { cuotas_2_habilitadas: true, cuotas_3_habilitadas: true, cuotas_6_habilitadas: true },
} as const

test("PDP: el precio financiado mostrado es el canónico para máximo 2, 3 y 6 -- cada cuota cierra exacto", () => {
  for (const maxCount of [2, 3, 6] as const) {
    const product = PRODUCTS_BY_MAX[maxCount]
    for (const cashPrice of [999, 45_677, 63_014, 100_000]) {
      // Mismo cálculo que product-details-panel.tsx (verificado abajo por contrato).
      const canonical = getFinancedPrice(cashPrice, maxCount, REAL_CONFIG)!
      const displayedFinancedPrice = getFinancedPrice(
        cashPrice,
        getMaxEligibleInstallmentCount(product),
        REAL_CONFIG,
      )
      const plans = getInstallmentPlans(product, cashPrice, REAL_CONFIG)

      assert.equal(displayedFinancedPrice, canonical)
      assert.equal(plans[plans.length - 1].count, maxCount)
      for (const plan of plans) {
        assert.equal(plan.amount * plan.count, canonical)
      }
    }
  }
})

test("PDP: el panel pasa el financiado y los planes canónicos sin ningún ajuste local", () => {
  const panel = readSource("./product-details-panel.tsx")
  const purchaseBox = readSource("./product-purchase-box.tsx")

  assert.match(panel, /const financedPrice = getFinancedPrice\(/)
  assert.match(panel, /const installmentPlans = getInstallmentPlans\(product, cashPrice, installmentsFinancing\)/)
  assert.match(panel, /financedPrice=\{financedPrice\}/)
  assert.match(panel, /installmentPlans=\{installmentPlans\}/)
  // La ficha muestra el monto de cada plan tal cual, sin recalcular.
  assert.match(purchaseBox, /formatPrice\(maxInstallmentPlan\.amount\)/)
  assert.match(purchaseBox, /formatPrice\(plan\.amount\)/)
  // CFTEA sigue oculto en la ficha hasta la definición legal.
  assert.match(purchaseBox, /const SHOW_CFTEA_ON_PRODUCT = false/)
})

test("ningún consumidor de precios financiados hace redondeos o ajustes ±1 propios", () => {
  const consumers = [
    "./product-details-panel.tsx",
    "./product-purchase-box.tsx",
    "./shared/shared-product-card.tsx",
    "../category/category-product-card.tsx",
    "../../app/checkout/page.tsx",
    "../../app/api/mercadopago/create-preference/route.ts",
  ]

  for (const path of consumers) {
    const source = readSource(path)
    assert.doesNotMatch(
      source,
      /(financed|Financed|installment|Installment)\w*\s*[-+]\s*1\b/,
      `${path} ajusta un importe financiado con ±1`,
    )
    assert.doesNotMatch(
      source,
      /Math\.(ceil|round|floor)\([^)]*(financed|Financed|installment|Installment|finalTotal|externalAmountDue)/,
      `${path} redondea localmente un importe financiado`,
    )
  }
})

test("checkout y create-preference aplican el MISMO ajuste final de redondeo de cuotas, sobre las cuotas ofrecidas", () => {
  const route = readSource("../../app/api/mercadopago/create-preference/route.ts")
  const checkout = readSource("../../app/checkout/page.tsx")

  for (const source of [route, checkout]) {
    assert.match(source, /roundUpCheckoutTotalForInstallments\(\{/)
    assert.match(source, /offeredCounts: cartInstallmentEligibility/)
  }

  // Server: el total persistido, lo cobrado y lo enviado a MP salen del ajuste.
  assert.match(route, /total: checkoutTotals\.total,/)
  assert.match(route, /externalAmountDue: checkoutTotals\.externalAmountDue,/)
  assert.match(route, /external_amount_due: checkoutTotals\.externalAmountDue,/)
  assert.match(route, /installmentsRoundingAdjustment: checkoutTotals\.roundingAdjustment/)
  assert.match(route, /unit_price:\s*externalAmountDue/)
  // El envío persistido nunca se recalcula con el ajuste ni con fee de MP.
  assert.doesNotMatch(route, /shipping_cost_charged[^\n]*(roundingAdjustment|checkoutTotals)/)

  // Cliente: el total mostrado es el mismo externalAmountDue ajustado.
  assert.match(checkout, /installmentsCheckoutTotals\?\.externalAmountDue \?\? customerCreditApplication\.externalAmountDue/)

  // Saldo a favor: el aplicado (y persistido) es el ajustado al múltiplo de cuotas.
  assert.match(route, /creditBalanceUsed: checkoutTotals\.customerCreditApplied,/)
  assert.match(route, /amount: checkoutTotals\.customerCreditApplied,/)
  assert.match(route, /credit_balance_used: checkoutTotals\.customerCreditApplied,/)
  assert.match(checkout, /installmentsCheckoutTotals\?\.customerCreditApplied \?\? customerCreditApplication\.appliedAmount/)
})

test("CFTEA: el precio financiado informado es el MISMO total final ajustado que se cobra", () => {
  const route = readSource("../../app/api/mercadopago/create-preference/route.ts")
  const checkout = readSource("../../app/checkout/page.tsx")

  assert.match(route, /getInstallmentAmount\(checkoutTotals\.total, requestedInstallmentsModality\)/)
  assert.match(checkout, /const legalFinancedTotal = installmentsCheckoutTotals\?\.total \?\? null/)
  assert.match(checkout, /getInstallmentAmount\(legalFinancedTotal, effectiveInstallmentsModality\)/)
  assert.match(checkout, /cuotas \{formatPrice\(legalFinancedTotal \?\? 0\)\}/)
  // Nunca el financiado crudo (sin ajuste de redondeo) en el disclosure legal.
  assert.doesNotMatch(checkout, /getInstallmentAmount\(cartFinancedTotal/)
  assert.doesNotMatch(checkout, /formatPrice\(cartFinancedTotal/)
  assert.doesNotMatch(route, /getInstallmentAmount\(financedTotal/)
})
