import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { INSTALLMENTS_COPY } from "../../lib/pricing/financed-pricing.ts"

// Decisión de negocio vigente: de cara al cliente las cuotas se comunican
// SIEMPRE como "sin interés" (nunca "sin recargo") en PDP, modal, tarjetas
// de catálogo, hero y checkout, desde una sola constante (INSTALLMENTS_COPY).
// La regla "Mismo precio en contado y cuotas" (`cuotas_sin_recargo`) sigue
// definiendo sólo el importe; su texto ya no se muestra al cliente. Este
// contrato sólo verifica EL TEXTO -- el cálculo (financedPrice,
// installmentPlans, getInstallmentAmount, roundUpCheckoutTotalForInstallments)
// es responsabilidad de financed-price-display-contract.test.ts.

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return listSources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

test("C. copy único: 'cuotas sin interés'", () => {
  assert.equal(INSTALLMENTS_COPY, "cuotas sin interés")
})

test("B/D. ningún componente de cara al cliente dice 'sin recargo' ni 'Mismo precio en contado…/que al contado'", () => {
  // El Admin (app/admin y sus APIs) conserva el nombre interno de la regla de precio.
  const sources = [...listSources("components"), ...listSources("app")].filter(
    (path) => !/^app\/(api\/)?admin\//.test(path.replace(/\\/g, "/")),
  )
  const offenders = sources.filter((path) => {
    const source = readFileSync(path, "utf8")
    return /sin recargo|Mismo precio en contado|Mismo precio que al contado/i.test(source)
  })
  assert.deepEqual(offenders, [])
})

test("PDP/modal (product-purchase-box.tsx): cuota máxima y opciones expandidas usan INSTALLMENTS_COPY, sin línea extra", () => {
  const source = readSource("./product-purchase-box.tsx")

  assert.match(source, /Hasta \{maxInstallmentPlan\.count\} \{INSTALLMENTS_COPY\} de \{formatPrice\(maxInstallmentPlan\.amount\)\}/)
  assert.match(source, /\{plan\.count\} \{INSTALLMENTS_COPY\} de \{formatPrice\(plan\.amount\)\}/)
  // Debajo de la cuota máxima sólo queda "Ver opciones de financiación".
  const block = source.slice(source.indexOf("Hasta {maxInstallmentPlan.count}"), source.indexOf("Ver opciones de financiación"))
  assert.doesNotMatch(block, /<p/)
  assert.doesNotMatch(source, /installmentsWithoutSurcharge/)
})

test("PDP se sirve a través de product-details-panel.tsx en la página de producto y en el modal -- un solo lugar para corregir", () => {
  const pageLayout = readSource("./product-page-layout.tsx")
  const modal = readSource("./product-details-modal.tsx")

  assert.match(pageLayout, /ProductDetailsPanel/)
  assert.match(modal, /ProductDetailsPanel/)
})

// La tarjeta de catálogo real es shared-product-card (categorías, productos,
// home y favoritos); category-product-card.tsx no se renderizaba desde 6e2d4f8.
test("tarjeta de catálogo (shared-product-card) y hero usan INSTALLMENTS_COPY", () => {
  const sharedCard = readSource("./shared/shared-product-card.tsx")
  const hero = readSource("../hero-section.tsx")

  assert.match(sharedCard, /\$\{INSTALLMENTS_COPY\} de \$\$\{maxInstallmentAmount/)
  assert.match(hero, /\$\{INSTALLMENTS_COPY\} de \$\{formatPrice\(featuredInstallmentAmount\)\}/)
  // Precio financiado de cada card: tier confirmado por Mercado Pago con la
  // regla del producto (nunca el gross-up directo ni la cuota configurada).
  for (const source of [sharedCard, hero]) {
    assert.match(source, /getProductInterestFreeOffer\(/)
    assert.doesNotMatch(source, /getFinancedPrice\(/)
  }
})

test("checkout: cada cuota sin interés, método de pago y resumen usan INSTALLMENTS_COPY -- el CFTEA no se tocó", () => {
  const checkout = readSource("../../app/checkout/page.tsx")

  assert.match(checkout, /const installmentsCopy = INSTALLMENTS_COPY/)
  // Una opción por cuota confirmada: "N cuotas sin interés".
  assert.match(checkout, /title=\{`\$\{plan\.count\} \$\{installmentsCopy\}`\}/)
  // Resumen con la cuota ELEGIDA: "Tarjeta de crédito: N cuotas ... de $X".
  assert.match(
    checkout,
    /`Tarjeta de crédito: \$\{selectedInstallmentPlan\.count\} \$\{installmentsCopy\} de \$\{formatPrice\(selectedInstallmentPlan\.amount\)\}`/,
  )
  assert.doesNotMatch(checkout, /cuotas fijas/)

  // CFTEA: disclosure legal intacta (compacta, en el detalle de cuotas),
  // redactada aparte del copy comercial: 1 decimal es-AR por plan.
  assert.match(checkout, /CFTEA: \{cfteaSummary\}/)
  assert.match(checkout, /`\$\{plan\.count\} cuotas \$\{formatCfteaPercent\(plan\.cfteaPercent\)\}%`/)
  assert.match(checkout, /minimumFractionDigits: 1,\s*maximumFractionDigits: 1,/)

  // Transferencia sigue mostrando su propio descuento, sin relación con cuotas:
  // en la opción de pago y como nota bajo "Productos" del resumen.
  assert.match(checkout, /\{siteSettings\.pricing\.transferDiscountPercent\}% de descuento/)
  assert.match(
    checkout,
    /Incluye \{siteSettings\.pricing\.transferDiscountPercent\}% OFF por transferencia/,
  )
})

test("1 pago sigue usando el precio de contado -- ninguna cuota lo modifica", () => {
  const checkout = readSource("../../app/checkout/page.tsx")
  const pricing = readSource("../../lib/pricing/checkout-pricing.ts")

  // Cuotas sólo con una cuota elegida y confirmada sin interés; si no, 1 pago (contado).
  assert.match(
    checkout,
    /mercadoPagoMode === "financed" &&\s*selectedInstallmentCount != null &&\s*mercadoPagoPricingBeforeCredit\.interestFreeInstallmentCounts\.includes\(selectedInstallmentCount\)\s*\? "financed"\s*: "cash"/,
  )
  // Contado: total = contado, preferencia en 1 pago, sin redondeo de cuotas.
  assert.match(pricing, /total: cashTotal,[\s\S]{0,200}roundingAdjustment: 0,\s*preferenceMaxInstallments: 1,/)
})
