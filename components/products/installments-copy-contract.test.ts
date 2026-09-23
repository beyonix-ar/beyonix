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

test("checkout: Mercado Pago en cuotas, método de pago y resumen dicen 'sin interés' -- el CFTEA no se tocó", () => {
  const checkout = readSource("../../app/checkout/page.tsx")

  // Opción "En cuotas": "Hasta N cuotas sin interés".
  assert.match(checkout, /Hasta \{mercadoPagoPricing\.maxInstallmentCount\} cuotas sin interés/)
  // Selector de medio de pago ("Tarjeta o saldo en cuenta · Hasta N cuotas...").
  assert.match(checkout, /Hasta \$\{bestCartInstallmentCount\} cuotas sin interés/)
  // Resumen del pedido en cuotas: "Hasta N cuotas sin interés de $X".
  assert.match(
    checkout,
    /`Hasta \$\{maxInstallmentPlan\.count\} cuotas sin interés de \$\{formatPrice\(maxInstallmentPlan\.amount\)\}`/,
  )
  assert.doesNotMatch(checkout, /cuotas fijas/)

  // CFTEA: disclosure legal intacta, redactada aparte del copy comercial.
  assert.match(checkout, /Costo financiero total efectivo anual \(CFTEA\):\{" "\}/)
  assert.match(checkout, /`\$\{plan\.count\} cuotas \$\{plan\.cfteaPercent\.toFixed\(1\)\}%`/)
  assert.match(
    checkout,
    /Precio de contado \{formatPrice\(cashTotalBeforeCredit\)\} — precio financiado\{" "\}/,
  )

  // Transferencia sigue mostrando su propio descuento, sin relación con cuotas.
  assert.match(
    checkout,
    /Transferencia \{siteSettings\.pricing\.transferDiscountPercent\}% OFF/,
  )
})

test("al contado sigue usando el precio de contado/transferencia -- ninguna cuota lo modifica", () => {
  const checkout = readSource("../../app/checkout/page.tsx")
  const pricing = readSource("../../lib/pricing/checkout-pricing.ts")

  // "En cuotas" sólo si el carrito lo admite; en cualquier otro caso, contado.
  assert.match(
    checkout,
    /mercadoPagoMode === "financed" && mercadoPagoPricingBeforeCredit\.financed[\s\S]{0,20}\? "financed"[\s\S]{0,20}: "cash"/,
  )
  // Contado: total = contado, preferencia en 1 pago, sin redondeo de cuotas.
  assert.match(pricing, /total: cashTotal,[\s\S]{0,200}roundingAdjustment: 0,\s*preferenceMaxInstallments: 1,/)
})
