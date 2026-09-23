import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Decisión de negocio vigente (ver comentarios actualizados en
// product-purchase-box.tsx): las cuotas se comunican como "sin interés" en
// PDP, modal, tarjetas de catálogo y checkout -- el precio financiado ya
// incorpora el costo de Mercado Pago de antemano, así que ninguna cuota
// agrega recargo adicional sobre ese total. Este contrato sólo verifica EL
// TEXTO -- el cálculo (financedPrice, installmentPlans, getInstallmentAmount,
// roundUpCheckoutTotalForInstallments) es responsabilidad de
// financed-price-display-contract.test.ts y no se toca acá.

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

test("PDP/modal (product-purchase-box.tsx, componente compartido): cuota máxima y opciones expandidas dicen 'sin interés'", () => {
  const source = readSource("./product-purchase-box.tsx")

  assert.match(
    source,
    /Hasta \{maxInstallmentPlan\.count\} cuotas sin interés de \{formatPrice\(maxInstallmentPlan\.amount\)\}/,
  )
  assert.match(
    source,
    /\{plan\.count\} cuotas sin interés de \{formatPrice\(plan\.amount\)\}/,
  )
})

test("PDP se sirve a través de product-details-panel.tsx en la página de producto y en el modal -- un solo lugar para corregir", () => {
  const pageLayout = readSource("./product-page-layout.tsx")
  const modal = readSource("./product-details-modal.tsx")

  assert.match(pageLayout, /ProductDetailsPanel/)
  assert.match(modal, /ProductDetailsPanel/)
})

test("tarjetas de catálogo (shared-product-card, category-product-card) y hero dicen 'sin interés'", () => {
  const sharedCard = readSource("./shared/shared-product-card.tsx")
  const categoryCard = readSource("../category/category-product-card.tsx")
  const hero = readSource("../hero-section.tsx")

  assert.match(sharedCard, /cuotas sin interés de \$\$\{maxInstallmentAmount/)
  assert.match(categoryCard, /cuotas sin interés de \$\{formatPrice\(plan\.amount\)\}/)
  assert.match(hero, /cuotas sin interés de \$\{formatPrice\(featuredInstallmentAmount\)\}/)
})

test("checkout: modalidad de pago, método de pago y resumen dicen 'sin interés' -- el CFTEA no se tocó", () => {
  const checkout = readSource("../../app/checkout/page.tsx")

  // Opciones 2/3/6 cuotas.
  assert.match(checkout, /\{count\} cuotas sin interés/)
  // Selector de medio de pago ("Tarjeta o saldo en cuenta · Hasta N cuotas...").
  assert.match(checkout, /Hasta \$\{bestCartInstallmentCount\} cuotas sin interés/)
  // Resumen del pedido: "N cuotas sin interés de $X", ya no "Pagás N cuotas de $X".
  assert.match(
    checkout,
    /\{effectiveInstallmentsModality\} cuotas sin interés de\{" "\}/,
  )
  assert.doesNotMatch(checkout, /Pagás \{effectiveInstallmentsModality\} cuotas de/)
  assert.doesNotMatch(checkout, /\{count\} cuotas fijas/)

  // El cálculo de cada opción sigue intacto (mismo call site que antes).
  assert.match(
    checkout,
    /getInstallmentAmount\(installmentOptionsTotals\.externalAmountDue, count\)/,
  )
  assert.match(
    checkout,
    /getInstallmentAmount\(finalTotal, effectiveInstallmentsModality\)/,
  )

  // CFTEA: disclosure legal intacta -- se calcula y redacta aparte, nunca se
  // mezcla con el copy comercial de "sin interés".
  assert.match(
    checkout,
    /Costo financiero total efectivo anual \(CFTEA\): \{cfteaPercent\.toFixed\(1\)\}%\./,
  )
  assert.match(
    checkout,
    /Precio de contado \{formatPrice\(cashTotalBeforeCredit\)\} — precio financiado en\{" "\}/,
  )
  assert.match(
    checkout,
    /\{effectiveInstallmentsModality\} cuotas \{formatPrice\(legalFinancedTotal \?\? 0\)\}\./,
  )
  assert.match(checkout, /calculateCftea\(cashTotalBeforeCredit, legalInstallmentAmount, effectiveInstallmentsModality\)/)

  // Transferencia sigue mostrando su propio descuento, sin relación con cuotas.
  assert.match(
    checkout,
    /Transferencia \{siteSettings\.pricing\.transferDiscountPercent\}% OFF/,
  )
})

test("pago único sigue usando el precio de contado/transferencia -- ninguna cuota lo modifica", () => {
  const checkout = readSource("../../app/checkout/page.tsx")

  // Sin modalidad elegida (pago único), el total sigue siendo
  // cashTotalBeforeCredit -- confirmado por el mismo contrato que ya
  // protege esta rama (financed-price-display-contract.test.ts).
  assert.match(
    checkout,
    /isMercadoPagoPayment && effectiveInstallmentsModality != null && cartFinancedTotal != null/,
  )
})
