import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

// La financiación no es una propiedad del producto (Admin → Financiación):
// PDP, tarjetas y Home sólo comunican el plan que Mercado Pago confirma y que
// el precio financiado de ESE producto alcanza ("Hasta N cuotas sin
// interés"); nunca un "a partir de $X" que el producto no cumple. El monto
// real lo define el total del checkout.

test("PDP, tarjetas y Home usan la regla vigente de Mercado Pago aplicada al precio del producto", () => {
  for (const path of [
    "./product-details-panel.tsx",
    "./shared/shared-product-card.tsx",
    "../hero-section.tsx",
  ]) {
    const source = readSource(path)
    assert.match(source, /getProductInterestFreeMessage\(/, path)
    assert.match(source, /interestFreeOffer/, path)
    assert.doesNotMatch(
      source,
      /getProductInterestFreeOffer|getProductFinancingCandidates|useInterestFreeInstallments|cuotas_(2|3|6)_habilitadas|cuotas_sin_recargo/,
      path,
    )
  }
  // La ficha muestra una sola línea global (sin planes por cuota del producto).
  const box = readSource("./product-purchase-box.tsx")
  assert.match(box, /interestFreeText\?: string \| null/)
  assert.match(box, /data-interest-free-global/)
  assert.doesNotMatch(box, /installmentPlans|financedPrice|Ver opciones de financiación/)
})

test("ningún consumidor de precios financiados hace redondeos o ajustes ±1 propios", () => {
  const consumers = [
    "./product-details-panel.tsx",
    "./product-purchase-box.tsx",
    "./shared/shared-product-card.tsx",
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
  const pricing = readSource("../../lib/pricing/checkout-pricing.ts")

  // Una única implementación del ajuste (lib/pricing/checkout-pricing.ts),
  // compartida por servidor y cliente.
  assert.match(pricing, /roundUpCheckoutTotalForInstallments\(\{/)
  // Divisor = cuotas de BEYONIX dentro del TIER (las que se pueden elegir).
  assert.match(pricing, /offeredCounts: INSTALLMENT_COUNTS\.filter\(\(count\) => count <= tier\)/)
  assert.match(pricing, /roundingAdjustment: rounded\.roundingAdjustment/)
  for (const source of [route, checkout]) {
    assert.match(source, /calculateMercadoPagoCheckoutPricing\(\{/)
    assert.doesNotMatch(source, /roundUpCheckoutTotalForInstallments\(/)
  }

  // Server: el total persistido, lo cobrado y lo enviado a MP salen del ajuste.
  assert.match(route, /total: quote\.total,/)
  assert.match(route, /externalAmountDue: quote\.externalAmountDue,/)
  assert.match(route, /external_amount_due: quote\.externalAmountDue,/)
  assert.match(pricing, /installmentsRoundingAdjustment: quote\.roundingAdjustment/)
  assert.match(route, /unit_price:\s*externalAmountDue/)
  // El envío persistido nunca se recalcula con el ajuste ni con fee de MP.
  assert.doesNotMatch(route, /shipping_cost_charged[^\n]*(roundingAdjustment|quote\.)/)

  // Cliente: el total mostrado es el mismo externalAmountDue ajustado.
  assert.match(checkout, /mercadoPagoQuote\?\.externalAmountDue \?\? customerCreditApplication\.externalAmountDue/)

  // Saldo a favor: el aplicado (y persistido) es el ajustado al múltiplo de cuotas.
  assert.match(route, /creditBalanceUsed: quote\.customerCreditApplied,/)
  assert.match(route, /amount: quote\.customerCreditApplied,/)
  assert.match(route, /credit_balance_used: quote\.customerCreditApplied,/)
  assert.match(checkout, /mercadoPagoQuote\?\.customerCreditApplied \?\? customerCreditApplication\.appliedAmount/)
})

test("CFTEA: el precio financiado informado es el MISMO total final ajustado que se cobra", () => {
  const checkout = readSource("../../app/checkout/page.tsx")
  const pricing = readSource("../../lib/pricing/checkout-pricing.ts")

  // Cada plan usa el total final ajustado (antes de saldo) contra el contado.
  assert.match(pricing, /const legalAmount = getInstallmentAmount\(financed\.total, count\)/)
  assert.match(pricing, /calculateCftea\(cashTotal, legalAmount, count\)/)
  // Cada opción de cuotas muestra el total final ajustado (el mismo que se
  // cobra) y el CFTEA sale de los planes canónicos, nunca recalculado en la UI.
  assert.match(checkout, /formatPrice\(financedPreviewQuote\.externalAmountDue\)/)
  assert.match(checkout, /formatCfteaPercent\(plan\.cfteaPercent\)/)
  assert.doesNotMatch(checkout, /calculateCftea\(/)
  // Nunca el financiado crudo (sin ajuste de redondeo) en el disclosure legal.
  assert.doesNotMatch(checkout, /formatPrice\(cartFinancedTotal/)
  assert.doesNotMatch(checkout, /formatPrice\(mercadoPagoPricing\.financedTotal/)
  assert.doesNotMatch(pricing, /getInstallmentAmount\(financedTotal/)
})
