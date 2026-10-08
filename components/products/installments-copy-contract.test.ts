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

test("PDP/modal (product-purchase-box.tsx): una sola línea de cuotas, sin tabla de planes", () => {
  const source = readSource("./product-purchase-box.tsx")
  assert.match(source, /\{interestFreeText && \(/)
  assert.doesNotMatch(source, /maxInstallmentPlan|installmentPlans|Ver opciones de financiación|installmentsWithoutSurcharge/)
  const communication = readSource("../../lib/pricing/interest-free-communication.ts")
  // El texto global usa el mismo copy "cuotas sin interés".
  assert.match(communication, /`Hasta \$\{tier\.count\} \$\{INSTALLMENTS_COPY\} a partir de \$\{AMOUNT_FORMAT\.format\(tier\.minimumAmount\)\}/)
})

test("PDP se sirve a través de product-details-panel.tsx en la página de producto y en el modal -- un solo lugar para corregir", () => {
  const pageLayout = readSource("./product-page-layout.tsx")
  const modal = readSource("./product-details-modal.tsx")

  assert.match(pageLayout, /ProductDetailsPanel/)
  assert.match(modal, /ProductDetailsPanel/)
})

// La tarjeta de catálogo real es shared-product-card (categorías, productos,
// home y favoritos); category-product-card.tsx no se renderizaba desde 6e2d4f8.
test("tarjeta de catálogo (shared-product-card) y hero: cuotas sólo si el precio del producto alcanza el mínimo", () => {
  const sharedCard = readSource("./shared/shared-product-card.tsx")
  const hero = readSource("../hero-section.tsx")
  // Un producto debajo del mínimo de Mercado Pago no muestra "a partir de $X".
  assert.match(sharedCard, /getProductInterestFreeMessage\(/)
  assert.match(hero, /getProductInterestFreeMessage\(/)
  for (const source of [sharedCard, hero]) {
    assert.doesNotMatch(source, /getInterestFreeMessage\(|getProductInterestFreeOffer\(|maxInstallmentAmount|featuredInstallmentAmount/)
  }
})

test("checkout: la opción de cuotas, el resumen y la confirmación usan INSTALLMENTS_COPY -- el CFTEA no se tocó", () => {
  const checkout = readSource("../../app/checkout/page.tsx")
  const financed = readSource("../../lib/pricing/financed-pricing.ts")

  // Un solo copy de cuotas: "Hasta N cuotas sin interés" sale de INSTALLMENTS_COPY.
  assert.match(financed, /headline: `Hasta \$\{maxCount\} \$\{INSTALLMENTS_COPY\}`/)
  assert.match(checkout, /getCheckoutInstallmentsOptionCopy\(\s*offeredInstallmentPlans\.map\(\(plan\) => plan\.count\),\s*\)/)
  assert.match(checkout, /`Tarjeta de crédito · \$\{selectedInstallmentsCopy\.headline\}`/)
  assert.doesNotMatch(checkout, /cuotas fijas/)

  // CFTEA: disclosure legal intacta (compacta, en el detalle de cuotas),
  // redactada aparte del copy comercial: 1 decimal es-AR por plan.
  assert.match(checkout, /CFTEA: \{cfteaSummary\}/)
  assert.match(checkout, /`\$\{plan\.count\} cuotas \$\{formatCfteaPercent\(plan\.cfteaPercent\)\}%`/)
  assert.match(checkout, /minimumFractionDigits: 1,\s*maximumFractionDigits: 1,/)

  // Transferencia sigue mostrando su propio descuento, sin relación con cuotas:
  // en la opción de pago y como nota bajo "Productos" del resumen.
  assert.match(checkout, /data-transfer-discount-highlight>\{siteSettings\.pricing\.transferDiscountPercent\}% OFF/)
  assert.match(
    checkout,
    /Incluye \{siteSettings\.pricing\.transferDiscountPercent\}% OFF por transferencia/,
  )
})

test("1 pago sigue usando el precio de contado -- ninguna cuota lo modifica", () => {
  const checkout = readSource("../../app/checkout/page.tsx")
  const pricing = readSource("../../lib/pricing/checkout-pricing.ts")

  // Cuotas sólo con alguna cuota confirmada sin interés (tier); si no, 1 pago (contado).
  assert.match(
    checkout,
    /mercadoPagoMode === "financed" &&\s*mercadoPagoPricingBeforeCredit\.offeredInstallmentCount != null\s*\? "financed"\s*: "cash"/,
  )
  // Contado: total = contado, preferencia en 1 pago, sin redondeo de cuotas.
  assert.match(pricing, /total: cashTotal,[\s\S]{0,200}roundingAdjustment: 0,\s*preferenceMaxInstallments: 1,/)
})
