import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  calculateCustomerCreditApplication,
  getMaxApplicableCustomerCredit,
} from "../../lib/customer-credit.ts"
import {
  allocateAmountAcrossLines,
  calculateMercadoPagoCheckoutPricing,
  getCheckoutSummaryLineAmounts,
  getMercadoPagoSummaryBreakdown,
  type CheckoutPricingLine,
  type CheckoutPricingSettings,
} from "../../lib/pricing/checkout-pricing.ts"
import {
  calculateTransferCheckoutPricing,
  getTransferSummaryBreakdown,
} from "../../lib/payments/transfer-checkout.ts"
import {
  CHECKOUT_TERMS_NOT_ACCEPTED_MESSAGE,
  hasAcceptedCheckoutTerms,
} from "../../lib/orders/checkout-order-creation.ts"

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

const checkout = readSource("../../app/checkout/page.tsx")
const routes = {
  mercadopago: readSource("../../app/api/mercadopago/create-preference/route.ts"),
  transferencia: readSource("../../app/api/transferencia/create-order/route.ts"),
  saldo: readSource("../../app/api/customer-credit/create-order/route.ts"),
}

const SETTINGS: CheckoutPricingSettings = {
  installmentsFinancing: {
    baseProcessingPercent: 6.42,
    ivaPercent: 21,
    surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
  },
  transferDiscountPercent: 10,
  nationalTaxesIncidencePercent: 21,
}

function line(
  productId: number,
  unitPrice: number,
  quantity = 1,
  installments = { cuotas_2_habilitadas: true, cuotas_3_habilitadas: true, cuotas_6_habilitadas: true },
): CheckoutPricingLine {
  return { productId, variantId: null, conditionedStockId: null, quantity, unitPrice, installments }
}

function cents(value: number) {
  return Math.round(value * 100)
}

function sumCents(values: number[]) {
  return values.reduce((total, value) => total + cents(value), 0)
}

function block(source: string, startMarker: string) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `no se encontró ${startMarker}`)
  return source.slice(start, source.indexOf("\n  }\n", start))
}

const CARTS: CheckoutPricingLine[][] = [
  [line(1, 1_000)],
  [line(1, 46_000), line(2, 12_345, 2)],
  // Un producto admite sólo hasta 3 cuotas: su financiado usa SU máximo.
  [line(1, 9_999, 3), line(2, 4_500, 1, { cuotas_2_habilitadas: true, cuotas_3_habilitadas: true, cuotas_6_habilitadas: false })],
]

// ─────────────────────────────────────────────────────────────
// PRESENTACIÓN (complementa checkout-presentation y el contrato de UI)
// ─────────────────────────────────────────────────────────────

test("4-5. MP contado lleva badge '1 pago'; MP cuotas muestra el máximo elegible dinámico", () => {
  const listStart = checkout.indexOf('<fieldset className="grid gap-3" data-payment-options>')
  const list = checkout.slice(listStart, checkout.indexOf("</fieldset>", listStart))
  const cash = list.slice(list.indexOf('option="mercadopago_cash"'), list.indexOf('option="mercadopago_financed"'))
  const financed = list.slice(list.indexOf('option="mercadopago_financed"'))
  assert.match(cash, /checkout-badge-neutral">1 pago</)
  assert.match(cash, />\s*Ver medios\s*</)
  assert.match(financed, /Hasta \{mercadoPagoPricing\.maxInstallmentCount\} cuotas sin interés/)
  assert.match(financed, />\s*Ver cuotas\s*</)
  assert.doesNotMatch(list, /Hasta [0-9] cuotas/)
})

// ─────────────────────────────────────────────────────────────
// RESUMEN: líneas por modalidad
// ─────────────────────────────────────────────────────────────

test("9-11. las líneas de producto suman exactamente 'Productos' en transferencia, contado y cuotas", () => {
  for (const lines of CARTS) {
    const pricing = calculateMercadoPagoCheckoutPricing({
      lines,
      shippingCharged: 6_900,
      storeBenefitPercent: null,
      requestedCustomerCredit: 0,
      settings: SETTINGS,
    })

    for (const mode of ["cash", "financed"] as const) {
      const summary = getMercadoPagoSummaryBreakdown(pricing, mode)
      const amounts = getCheckoutSummaryLineAmounts({
        lines,
        mode,
        installmentsFinancing: SETTINGS.installmentsFinancing,
        productsSubtotal: summary.productsSubtotal,
      })
      assert.equal(sumCents(amounts), cents(summary.productsSubtotal), `${mode}`)
    }

    const productsTotal = pricing.productsTotal
    const transfer = calculateTransferCheckoutPricing({
      productsTotal,
      shippingCharged: 6_900,
      storeBenefitPercent: null,
      requestedCustomerCredit: 0,
      transferDiscountPercent: 10,
      nationalTaxesIncidencePercent: 21,
    })
    const transferSummary = getTransferSummaryBreakdown({
      productsTotal,
      storeBenefitDiscountAmount: 0,
      shipping: 6_900,
      transferDiscountAmount: transfer.transferDiscountAmount,
    })
    const transferAmounts = getCheckoutSummaryLineAmounts({
      lines,
      mode: "transfer",
      installmentsFinancing: SETTINGS.installmentsFinancing,
      productsSubtotal: transferSummary.productsSubtotal,
    })
    assert.equal(sumCents(transferAmounts), cents(transferSummary.productsSubtotal))
  }
})

test("contado: cada línea es exactamente su precio de contado; cuotas: su financiado canónico", () => {
  const lines = [line(1, 46_000), line(2, 12_345, 2)]
  const pricing = calculateMercadoPagoCheckoutPricing({
    lines,
    shippingCharged: 8_000,
    storeBenefitPercent: null,
    requestedCustomerCredit: 0,
    settings: SETTINGS,
  })
  const cash = getCheckoutSummaryLineAmounts({
    lines,
    mode: "cash",
    installmentsFinancing: SETTINGS.installmentsFinancing,
    productsSubtotal: getMercadoPagoSummaryBreakdown(pricing, "cash").productsSubtotal,
  })
  assert.deepEqual(cash, [46_000, 24_690])

  const financed = getCheckoutSummaryLineAmounts({
    lines,
    mode: "financed",
    installmentsFinancing: SETTINGS.installmentsFinancing,
    productsSubtotal: getMercadoPagoSummaryBreakdown(pricing, "financed").productsSubtotal,
  })
  // 46.000 financiado canónico (máx. 6 cuotas) = 66.672; el ajuste de
  // redondeo de cuotas (centavos) se reparte sin mover pesos enteros.
  assert.equal(Math.floor(financed[0]), 66_672)
  assert.ok(financed[1] > 24_690)
})

test("12-14. Productos − beneficio + envío (− saldo) = total; el envío nunca se financia; el producto no cambia", () => {
  const lines = [line(1, 30_000)]
  const snapshot = JSON.stringify(lines)
  const pricing = calculateMercadoPagoCheckoutPricing({
    lines,
    shippingCharged: 5_000,
    storeBenefitPercent: 10,
    requestedCustomerCredit: 2_000,
    settings: SETTINGS,
  })
  for (const mode of ["cash", "financed"] as const) {
    const summary = getMercadoPagoSummaryBreakdown(pricing, mode)
    const quote = mode === "cash" ? pricing.cash : pricing.financed!
    assert.equal(summary.shipping, 5_000)
    assert.equal(
      cents(summary.productsSubtotal) - cents(summary.storeBenefitDiscount) + cents(summary.shipping) - cents(quote.customerCreditApplied),
      cents(quote.externalAmountDue),
    )
  }
  assert.equal(JSON.stringify(lines), snapshot)
  assert.match(checkout, /formatPrice\(summaryLineAmounts\[itemIndex\] \?\? item\.unitPrice \* item\.quantity\)/)
  assert.doesNotMatch(checkout, /\.precio\s*=[^=]|unitPrice\s*=[^=]/)
})

test("reparto proporcional exacto en centavos (sin perder ni inventar un centavo)", () => {
  assert.deepEqual(allocateAmountAcrossLines([100, 200], 300), [100, 200])
  assert.deepEqual(allocateAmountAcrossLines([1, 1, 1], 1), [0.34, 0.33, 0.33])
  assert.equal(sumCents(allocateAmountAcrossLines([46_000, 24_690], 63_639)), cents(63_639))
  assert.deepEqual(allocateAmountAcrossLines([], 10), [])
})

// ─────────────────────────────────────────────────────────────
// SALDO: las cuotas informativas usan el total real
// ─────────────────────────────────────────────────────────────

test("15-16. con saldo a favor, 'Ver cuotas' muestra las MISMAS cuotas que al elegir 'en cuotas' y siguen siendo divisibles", () => {
  const lines = [line(1, 46_000)]
  const shipping = 8_000
  for (const balance of [0, 1_234.56, 5_000, 20_000]) {
    const beforeCredit = calculateMercadoPagoCheckoutPricing({
      lines,
      shippingCharged: shipping,
      storeBenefitPercent: null,
      requestedCustomerCredit: 0,
      settings: SETTINGS,
    })
    const financedTotal = beforeCredit.financedTotal!

    // Lo que hace el checkout con "en cuotas" elegida (saldo máximo aplicable).
    const selectedCredit = calculateCustomerCreditApplication({
      availableBalance: balance,
      eligibleTotal: financedTotal,
      requestedAmount: getMaxApplicableCustomerCredit(balance, financedTotal),
    }).appliedAmount
    const selected = calculateMercadoPagoCheckoutPricing({
      lines,
      shippingCharged: shipping,
      storeBenefitPercent: null,
      requestedCustomerCredit: selectedCredit,
      settings: SETTINGS,
    })

    // Lo que muestra "Ver cuotas" ANTES de elegir la opción.
    const preview = calculateMercadoPagoCheckoutPricing({
      lines,
      shippingCharged: shipping,
      storeBenefitPercent: null,
      requestedCustomerCredit: getMaxApplicableCustomerCredit(balance, financedTotal),
      settings: SETTINGS,
    })

    assert.deepEqual(preview.installmentPlans, selected.installmentPlans, `saldo ${balance}`)
    assert.equal(preview.financed?.externalAmountDue, selected.financed?.externalAmountDue)
    for (const plan of preview.installmentPlans) {
      assert.equal(cents(plan.amount) * plan.count, cents(preview.financed!.externalAmountDue))
    }
  }
  assert.match(checkout, /<InstallmentPlanList plans=\{financedPreviewPricing\.installmentPlans\} \/>/)
  assert.match(checkout, /getMaxApplicableCustomerCredit\(\s*customerCredit\.balance,\s*mercadoPagoPricingBeforeCredit\.financedTotal,\s*\)/)
})

// ─────────────────────────────────────────────────────────────
// TÉRMINOS Y CONDICIONES
// ─────────────────────────────────────────────────────────────

test("17-19. sin aceptar términos el botón queda deshabilitado en las 3 opciones; al aceptar se habilita", () => {
  assert.match(
    checkout,
    /const canSubmitCheckout =\s*isFormValid &&\s*!isProcessing &&\s*!hasKnownStockConflict &&\s*isSelectedPaymentValid &&\s*termsAccepted/,
  )
  assert.match(checkout, /disabled=\{!canSubmitCheckout\}/)
  // No depende de la opción elegida: vale igual para transferencia, contado y cuotas.
  const handleSubmit = block(checkout, "  const handleSubmit = (e: React.FormEvent) => {")
  assert.match(handleSubmit, /if \(!termsAccepted\) return/)
  assert.ok(handleSubmit.indexOf("if (!termsAccepted) return") < handleSubmit.indexOf("setMercadoPagoConfirmOpen(true)"))
  assert.match(checkout, /termsAccepted: true,/)
})

test("20. el texto del checkbox enlaza a /terminos (en otra pestaña, sin perder el checkout)", () => {
  const terms = checkout.slice(checkout.indexOf("data-terms-acceptance"), checkout.indexOf("</label>", checkout.indexOf("data-terms-acceptance")))
  assert.match(terms, /type="checkbox"/)
  assert.match(terms, /Al comprar, aceptás los\{" "\}/)
  assert.match(terms, /href="\/terminos"/)
  assert.match(terms, /target="_blank"/)
  assert.match(terms, />\s*términos y condiciones\s*</)
})

test("21-22. la aceptación sobrevive al cambio de modalidad y se resetea con una compra/sesión nueva", () => {
  assert.match(
    checkout,
    /const termsAccepted =\s*Boolean\(cartSessionId\) && termsAcceptedSessionId === cartSessionId/,
  )
  const select = block(checkout, "  const selectPaymentOption = (option: CheckoutPaymentOption) => {")
  assert.doesNotMatch(select, /setTermsAcceptedSessionId/)
  // Nunca se persiste en storage.
  assert.doesNotMatch(checkout, /(localStorage|sessionStorage)[^\n]*terms/i)
})

test("el servidor exige el flag explícito en las 3 rutas de compra, antes de cualquier efecto", () => {
  assert.equal(hasAcceptedCheckoutTerms({ termsAccepted: true }), true)
  for (const value of [false, null, undefined]) {
    assert.equal(hasAcceptedCheckoutTerms({ termsAccepted: value }), false)
  }
  assert.equal(hasAcceptedCheckoutTerms({ termsAccepted: "true" as unknown as boolean }), false)
  assert.match(CHECKOUT_TERMS_NOT_ACCEPTED_MESSAGE, /términos y condiciones/)

  for (const [name, route] of Object.entries(routes)) {
    const guard = route.indexOf("if (!hasAcceptedCheckoutTerms(payload)) {")
    assert.ok(guard > 0, name)
    assert.ok(guard < route.indexOf(".insert("), `${name}: antes de crear nada`)
    assert.ok(guard < route.indexOf("loadAndValidateCheckoutOrderCatalog("), `${name}: antes de leer catálogo`)
  }
})

// ─────────────────────────────────────────────────────────────
// MODAL DE CONFIRMACIÓN DE MERCADO PAGO
// ─────────────────────────────────────────────────────────────

test("23-27. MP (contado y cuotas) abre la confirmación sin llamar al servidor; transferencia sigue directo", () => {
  const handleSubmit = block(checkout, "  const handleSubmit = (e: React.FormEvent) => {")
  assert.match(
    handleSubmit,
    /if \(!customerCreditCoversTotal && selectedPayment === "mercadopago"\) \{\s*setMercadoPagoConfirmOpen\(true\)\s*return\s*\}/,
  )
  // handleSubmit nunca crea/reutiliza la preferencia: no hay fetch acá.
  assert.doesNotMatch(handleSubmit, /fetch\(/)
  assert.match(handleSubmit, /void submitCheckout\(\)/)

  const submit = checkout.slice(checkout.indexOf("  const submitCheckout = async () => {"))
  assert.match(submit.slice(0, 4_000), /await fetch\(endpoint/)

  const modalStart = checkout.indexOf("{mercadoPagoConfirmOpen && mercadoPagoQuote && (")
  const modal = checkout.slice(modalStart, checkout.indexOf("</PaymentInfoModal>", modalStart))
  // Confirmar continúa (recién ahí se crea la preferencia); Volver sólo cierra.
  assert.match(modal, /onClick=\{\(\) => void submitCheckout\(\)\}[\s\S]*Continuar a Mercado Pago/)
  assert.match(modal, /onClick=\{\(\) => setMercadoPagoConfirmOpen\(false\)\}\s*>\s*Volver/)
  assert.equal((modal.match(/submitCheckout\(/g) ?? []).length, 1)
})

test("28-30. confirmación: contado muestra total y medios; cuotas muestra total financiado, cuotas y la advertencia", () => {
  const modalStart = checkout.indexOf("{mercadoPagoConfirmOpen && mercadoPagoQuote && (")
  const modal = checkout.slice(modalStart, checkout.indexOf("</PaymentInfoModal>", modalStart))
  assert.match(modal, /title="Vas a continuar a Mercado Pago"/)

  const financed = modal.slice(modal.indexOf('data-mercadopago-confirm="financed"'), modal.indexOf('data-mercadopago-confirm="cash"'))
  assert.match(financed, /Elegiste pagar en cuotas\./)
  assert.match(financed, /Total financiado: \{formatPrice\(finalTotal\)\}/)
  assert.match(financed, /Hasta \{maxInstallmentPlan\.count\} cuotas sin interés\./)
  assert.match(financed, /<InstallmentPlanList plans=\{mercadoPagoPricing\.installmentPlans\} \/>/)
  assert.match(financed, /\{MERCADOPAGO_FINANCED_TOTAL_WARNING\}/)
  assert.match(
    checkout,
    /const MERCADOPAGO_FINANCED_TOTAL_WARNING =\s*"Si dentro de Mercado Pago elegís pagar en 1 solo pago o con dinero en cuenta, se mantendrá este total financiado\."/,
  )

  const cash = modal.slice(modal.indexOf('data-mercadopago-confirm="cash"'))
  assert.match(cash, /Elegiste pagar al contado\./)
  assert.match(cash, /Total: \{formatPrice\(finalTotal\)\}/)
  assert.match(cash, /<MercadoPagoCashMediaList \/>/)
  // Sólo medios que la preferencia al contado (installments=1) admite.
  assert.match(checkout, /"Dinero disponible en tu cuenta de Mercado Pago",\s*"Tarjeta de débito",\s*"Tarjeta de crédito en 1 pago",/)
})

// ─────────────────────────────────────────────────────────────
// REGRESIÓN (las suites específicas siguen en checkout-price-change,
// transfer-checkout-attempt, cart-catalog-refresh y checkout-presentation)
// ─────────────────────────────────────────────────────────────

test("31-35. huellas, retry, refresco de precios, revalidación de transferencia y fórmulas siguen en su lugar", () => {
  const mp = routes.mercadopago
  assert.match(mp, /createCheckoutEconomicFingerprint\(/)
  assert.match(mp, /"claim_mercadopago_order_preference"/)
  assert.match(mp, /getMercadoPagoPreferenceInstallments\(order\)/)
  assert.match(mp, /code: "PRICING_CHANGED"/)
  assert.match(routes.transferencia, /createTransferEconomicFingerprint\(/)
  assert.match(routes.transferencia, /code: "PRICING_CHANGED"/)
  assert.match(checkout, /useCommercialRefresh\(\{/)

  const pricing = calculateMercadoPagoCheckoutPricing({
    lines: [line(1, 46_000)],
    shippingCharged: 8_000,
    storeBenefitPercent: null,
    requestedCustomerCredit: 0,
    settings: SETTINGS,
  })
  assert.equal(pricing.cash.externalAmountDue, 54_000)
  assert.equal(pricing.financed?.externalAmountDue, 74_672.04)
  assert.equal(pricing.financed?.preferenceMaxInstallments, 6)
  assert.equal(pricing.cash.preferenceMaxInstallments, 1)
})
