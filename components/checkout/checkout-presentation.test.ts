import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  calculateMercadoPagoCheckoutPricing,
  getMercadoPagoSummaryBreakdown,
  type CheckoutPricingLine,
  type CheckoutPricingSettings,
} from "../../lib/pricing/checkout-pricing.ts"
import { getCartFinancedTotal, getMaxEligibleInstallmentCount } from "../../lib/pricing/financed-pricing.ts"
import {
  calculateTransferCheckoutPricing,
  getTransferSummaryBreakdown,
} from "../../lib/payments/transfer-checkout.ts"

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

const checkout = readSource("../../app/checkout/page.tsx")
const css = readSource("../../app/globals.css")

const SETTINGS: CheckoutPricingSettings = {
  installmentsFinancing: {
    baseProcessingPercent: 6.42,
    ivaPercent: 21,
    surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
  },
  transferDiscountPercent: 10,
  nationalTaxesIncidencePercent: 21,
}

const ALL_INSTALLMENTS = { cuotas_2_habilitadas: true, cuotas_3_habilitadas: true, cuotas_6_habilitadas: true }

function line(productId: number, unitPrice: number, quantity = 1): CheckoutPricingLine {
  return { productId, variantId: null, conditionedStockId: null, quantity, unitPrice, installments: ALL_INSTALLMENTS }
}

function cents(value: number) {
  return Math.round(value * 100)
}

function assertAddsUp(summary: { productsSubtotal: number; storeBenefitDiscount: number; shipping: number; total: number }) {
  assert.equal(
    cents(summary.productsSubtotal) - cents(summary.storeBenefitDiscount) + cents(summary.shipping),
    cents(summary.total),
    `Productos ${summary.productsSubtotal} - beneficio ${summary.storeBenefitDiscount} + envío ${summary.shipping} != total ${summary.total}`,
  )
}

// ─────────────────────────────────────────────────────────────
// Jerarquía visual de "Método de pago"
// ─────────────────────────────────────────────────────────────

test("1-2. lista simple en orden: Transferencia, Mercado Pago al contado, Mercado Pago en cuotas; sin paneles anidados", () => {
  const listStart = checkout.indexOf("<fieldset className=\"grid gap-3\" data-payment-options>")
  const listEnd = checkout.indexOf("</fieldset>", listStart)
  assert.ok(listStart > 0 && listEnd > listStart)
  const list = checkout.slice(listStart, listEnd)
  const order = ["transferencia", "mercadopago_cash", "mercadopago_financed"].map((option) =>
    list.indexOf(`option="${option}"`),
  )
  assert.ok(order.every((index) => index > 0))
  assert.ok(order[0] < order[1] && order[1] < order[2])
  // Cada opción es una única tarjeta: no hay grupos anidados ni radiogroups internos.
  assert.doesNotMatch(list, /role="radiogroup"|data-mercadopago-modes|data-mercadopago-mode=/)
  // "En cuotas" sólo aparece si el carrito admite financiación.
  assert.match(list, /\{isMercadoPagoFinancingAvailable &&/)
})

test("3-4. el cliente sólo elige una de tres opciones; 2/3/6 cuotas siguen sin ser controles", () => {
  const cardStart = checkout.indexOf("function CheckoutPaymentOptionCard(")
  const card = checkout.slice(cardStart, checkout.indexOf("\n}\n", cardStart))
  assert.match(card, /type="radio"/)
  assert.match(card, /name="checkout-payment-option"/)
  assert.match(card, /onChange=\{\(\) => onSelect\(option\)\}/)
  const rowsStart = checkout.indexOf("{plans.map((plan) => (")
  assert.ok(rowsStart > 0)
  const rows = checkout.slice(rowsStart, checkout.indexOf("</ul>", rowsStart))
  assert.doesNotMatch(rows, /onClick|role="radio"|<button|<input|aria-checked/)
})

function hexLuminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test("5-6. en light la opción elegida es sobria: fondo blanco/gris muy claro, borde BEYONIX y texto oscuro", () => {
  const lightTokens = css.match(
    /html\[data-account-theme="light"\]\[data-account-scope\] \{\n(?:  \/\*[\s\S]*?\*\/\n)?  --checkout-choice-selected-bg: (#[0-9a-f]{6});/,
  )
  assert.ok(lightTokens, "token light de fondo seleccionado")
  assert.ok(hexLuminance(lightTokens[1]) > 0.95, `${lightTokens[1]} debe ser blanco o gris muy claro`)
  // Dark conserva el navy de siempre.
  assert.match(css, /:root \{\n  --checkout-choice-selected-bg: #112a43;/)
  assert.match(css, /box-shadow: 0 0 0 1px var\(--checkout-choice-selected-border\) !important;/)
  assert.match(
    css,
    /\.checkout-choice\.checkout-option-selected \[class~="text-white"\],[\s\S]{0,200}color: var\(--account-text-primary\) !important;/,
  )
  assert.match(
    css,
    /\.checkout-choice\.checkout-option-selected \[class~="text-white\/45"\],[\s\S]{0,300}color: var\(--beyonix-light-text-secondary\) !important;/,
  )
  const cardStart = checkout.indexOf("function CheckoutPaymentOptionCard(")
  const card = checkout.slice(cardStart, checkout.indexOf("\n}\n", cardStart))
  assert.match(card, /"checkout-choice items-start/)
  assert.match(card, /checked && checkoutOptionSelectedClassName/)
  // Badges chicos con tokens por tema (success/info/neutral).
  for (const variant of ["success", "info", "neutral"]) {
    assert.match(css, new RegExp(`\\.checkout-badge-${variant} \\{\\n  color: var\\(--checkout-badge-${variant}-fg\\);`))
  }
})

test("7-8. transferencia: '¡Mejor precio!' y 'Incluye N% de descuento' dinámico y destacado", () => {
  const listStart = checkout.indexOf("<fieldset className=\"grid gap-3\" data-payment-options>")
  const list = checkout.slice(listStart, checkout.indexOf("</fieldset>", listStart))
  assert.match(list, /title="Depósito \/ Transferencia"/)
  assert.match(list, /description="En cuenta bancaria o virtual"/)
  assert.match(list, /checkout-badge-success">¡Mejor precio!</)
  assert.match(
    list,
    /className="font-semibold text-\[var\(--checkout-offer-text\)\]"\s*>\s*\{siteSettings\.pricing\.transferDiscountPercent\}% de descuento/,
  )
  assert.doesNotMatch(list, /10%/)
  // Verde claro y vivo en light (no el verde oscuro de estados).
  assert.match(css, /--checkout-offer-text: #16a34a;/)
})

// ─────────────────────────────────────────────────────────────
// Matemática visible del resumen
// ─────────────────────────────────────────────────────────────

test("9. al contado: productos contado + envío = total contado", () => {
  const pricing = calculateMercadoPagoCheckoutPricing({
    lines: [line(1, 1_000)],
    shippingCharged: 6_900,
    storeBenefitPercent: null,
    requestedCustomerCredit: 0,
    settings: SETTINGS,
  })
  const summary = getMercadoPagoSummaryBreakdown(pricing, "cash")
  assert.deepEqual(summary, { productsSubtotal: 1_000, storeBenefitDiscount: 0, shipping: 6_900, total: 7_900 })
  assert.equal(summary.total, pricing.cash.externalAmountDue)
})

test("10/12/14. en cuotas: productos FINANCIADOS canónicos + envío real = total financiado", () => {
  for (const lines of [[line(1, 1_000)], [line(1, 46_000)], [line(1, 12_345, 2), line(2, 999)]]) {
    const pricing = calculateMercadoPagoCheckoutPricing({
      lines,
      shippingCharged: 6_900,
      storeBenefitPercent: null,
      requestedCustomerCredit: 0,
      settings: SETTINGS,
    })
    const summary = getMercadoPagoSummaryBreakdown(pricing, "financed")
    assertAddsUp(summary)
    assert.equal(summary.total, pricing.financed?.total)
    // El envío se muestra y se cobra a costo real: nunca se financia.
    assert.equal(summary.shipping, 6_900)
    // "Productos" = suma de financiados canónicos por línea + ajuste de redondeo de cuotas.
    const canonicalFinancedProducts = getCartFinancedTotal(
      lines.map((item) => ({
        cashPrice: item.unitPrice,
        maxEligibleCount: getMaxEligibleInstallmentCount(item.installments),
        quantity: item.quantity,
      })),
      SETTINGS.installmentsFinancing,
    )
    assert.equal(
      cents(summary.productsSubtotal),
      cents(canonicalFinancedProducts) + cents(pricing.financed?.roundingAdjustment ?? 0),
    )
  }
})

test("con beneficio de tienda y saldo el resumen sigue cerrando en las tres modalidades", () => {
  const pricing = calculateMercadoPagoCheckoutPricing({
    lines: [line(1, 30_000)],
    shippingCharged: 5_000,
    storeBenefitPercent: 10,
    requestedCustomerCredit: 2_000,
    settings: SETTINGS,
  })
  for (const mode of ["cash", "financed"] as const) {
    const summary = getMercadoPagoSummaryBreakdown(pricing, mode)
    assertAddsUp(summary)
    const quote = mode === "cash" ? pricing.cash : pricing.financed!
    assert.equal(cents(summary.total) - cents(quote.customerCreditApplied), cents(quote.externalAmountDue))
  }
})

test("11. transferencia: productos con descuento + envío = total transferencia (mismo cálculo canónico)", () => {
  for (const [productsTotal, shipping, benefitPercent] of [
    [1_000, 6_900, null],
    [46_000, 8_000, null],
    [30_000, 5_000, 10],
  ] as const) {
    const canonical = calculateTransferCheckoutPricing({
      productsTotal,
      shippingCharged: shipping,
      storeBenefitPercent: benefitPercent,
      requestedCustomerCredit: 0,
      transferDiscountPercent: 10,
      nationalTaxesIncidencePercent: 21,
    })
    const summary = getTransferSummaryBreakdown({
      productsTotal,
      storeBenefitDiscountAmount: canonical.storeBenefitDiscountAmount,
      shipping,
      transferDiscountAmount: canonical.transferDiscountAmount,
    })
    assertAddsUp(summary)
    assert.equal(summary.total, canonical.transferTotal)
    assert.equal(summary.shipping, shipping, "el envío nunca se descuenta")
  }
  const example = getTransferSummaryBreakdown({
    productsTotal: 1_000,
    storeBenefitDiscountAmount: 0,
    shipping: 6_900,
    transferDiscountAmount: 100,
  })
  assert.deepEqual(example, { productsSubtotal: 900, storeBenefitDiscount: 0, shipping: 6_900, total: 7_800 })
})

test("el resumen muestra Productos (no Subtotal) y ya no agrega filas de recargo, redondeo ni descuento de transferencia", () => {
  assert.match(checkout, /<span className="text-muted-foreground">Productos<\/span>/)
  assert.match(checkout, /formatPrice\(checkoutSummary\.productsSubtotal\)/)
  assert.doesNotMatch(checkout, />Subtotal</)
  assert.doesNotMatch(checkout, /Redondeo de cuotas/)
  assert.doesNotMatch(checkout, /Financiación Mercado Pago/)
  assert.doesNotMatch(checkout, /-\{formatPrice\(transferDiscountAmount\)\}/)
})

test("13. el precio del producto (DB/carrito) nunca se modifica para cerrar el resumen", () => {
  const lines = [line(1, 1_000)]
  const snapshot = JSON.stringify(lines)
  const pricing = calculateMercadoPagoCheckoutPricing({
    lines,
    shippingCharged: 6_900,
    storeBenefitPercent: null,
    requestedCustomerCredit: 0,
    settings: SETTINGS,
  })
  getMercadoPagoSummaryBreakdown(pricing, "financed")
  assert.equal(JSON.stringify(lines), snapshot)
  assert.doesNotMatch(checkout, /\.precio\s*=[^=]/)
  assert.doesNotMatch(checkout, /unitPrice\s*=[^=]/)
})

test("15-17. CFTEA y fórmulas financieras intactas (valores de referencia)", () => {
  const pricing = calculateMercadoPagoCheckoutPricing({
    lines: [line(1, 46_000)],
    shippingCharged: 8_000,
    storeBenefitPercent: null,
    requestedCustomerCredit: 0,
    settings: SETTINGS,
  })
  assert.equal(pricing.cash.externalAmountDue, 54_000)
  assert.equal(pricing.financed?.externalAmountDue, 74_672.04)
  assert.deepEqual(
    pricing.installmentPlans.map((plan) => [plan.count, plan.amount, plan.cfteaPercent?.toFixed(1)]),
    [
      [2, 37_336.02, "1303.2"],
      [3, 24_890.68, "639.0"],
      [6, 12_445.34, "218.3"],
    ],
  )
  // CFTEA sólo en el detalle de "Mercado Pago en cuotas".
  assert.match(checkout, /\{paymentInfoModal === "installments" && financedPreviewQuote && \(/)
  assert.match(checkout, /\{cfteaSummary && \(\s*<p\s+data-cftea-disclosure/)
})
