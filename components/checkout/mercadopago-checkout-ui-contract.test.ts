import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

const checkout = readSource("../../app/checkout/page.tsx")
const route = readSource("../../app/api/mercadopago/create-preference/route.ts")
const css = readSource("../../app/globals.css")

function extractBlock(source: string, startMarker: string) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `no se encontró ${startMarker}`)
  return source.slice(start, source.indexOf("\n}\n", start))
}

// ─────────────────────────────────────────────────────────────
// UI de Mercado Pago
// ─────────────────────────────────────────────────────────────

test("sólo Mercado Pago y Transferencia son métodos principales", () => {
  const methods = extractBlock(checkout, "function getPaymentMethods(")
  const ids = [...methods.matchAll(/id: "([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(ids, ["mercadopago", "transferencia"])
})

test("Mercado Pago tiene únicamente dos decisiones: Al contado / En cuotas", () => {
  const modes = [...checkout.matchAll(/data-mercadopago-mode="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(modes, ["cash", "financed"])
  assert.match(checkout, /Cómo querés pagar con Mercado Pago/)
  assert.match(checkout, />\s*Al contado\s*</)
  assert.match(checkout, />\s*En cuotas\s*</)
  // El título viejo y los botones de pago único/2/3/6 ya no existen.
  assert.doesNotMatch(checkout, /Modalidad de pago/)
  assert.doesNotMatch(checkout, /Pago único/)
  assert.doesNotMatch(checkout, /setInstallmentsModality/)
  assert.doesNotMatch(checkout, /installmentsModality:/)
  assert.match(checkout, /mercadoPagoMode: effectiveMercadoPagoMode,/)
})

test("las filas 2/3/6 cuotas son sólo informativas (no son botones ni radios ni cambian estado)", () => {
  const start = checkout.indexOf("mercadoPagoPricing.installmentPlans.map((plan) => (")
  assert.ok(start >= 0)
  const rows = checkout.slice(start, checkout.indexOf("</ul>", start))
  assert.match(rows, /<li key=\{plan\.count\} data-installment-plan=\{plan\.count\}>/)
  assert.doesNotMatch(rows, /onClick|role="radio"|<button|aria-checked|set[A-Z]\w*\(/)
  assert.match(rows, /\{plan\.count\} cuotas de\{" "\}/)
  assert.match(rows, /formatPrice\(plan\.amount\)/)
})

test("resumen: contado dice 'Pago con Mercado Pago al contado'; cuotas 'Hasta N cuotas sin interés de $X'", () => {
  assert.match(checkout, /"Pago con Mercado Pago al contado"/)
  assert.match(checkout, /`Hasta \$\{maxInstallmentPlan\.count\} cuotas sin interés de \$\{formatPrice\(maxInstallmentPlan\.amount\)\}`/)
  // El total del resumen es el de la modalidad elegida (el mismo que se cobra).
  assert.match(checkout, /mercadoPagoQuote\?\.externalAmountDue \?\? customerCreditApplication\.externalAmountDue/)
})

test("CFTEA sólo se muestra en cuotas; al contado no hay disclosure de financiación", () => {
  assert.match(checkout, /\{isMercadoPagoFinanced && mercadoPagoFinancedQuote && \(\s*<p[^>]*>\s*Costo financiero total efectivo anual \(CFTEA\)/)
  assert.doesNotMatch(checkout, /cfteaPercent != null && \(/)
})

// ─────────────────────────────────────────────────────────────
// Pagar SIEMPRE revalida server-side (el refresco en vivo es sólo UX)
// ─────────────────────────────────────────────────────────────

test("pagar fuerza validación server-side: catálogo y configuración frescos ANTES de reutilizar, reemplazar o crear", () => {
  const catalogIndex = route.indexOf("loadAndValidateCheckoutOrderCatalog(")
  const settingsIndex = route.indexOf("getSiteSettings({ fresh: true })")
  const pricingIndex = route.indexOf("calculateMercadoPagoCheckoutPricing({")
  const expectedTotalIndex = route.indexOf('code: "PRICING_CHANGED"')
  const reuseIndex = route.indexOf("const activeAttempt = existingAttempts.find(")
  const pendingIndex = route.indexOf("resolvePendingCustomerCheckoutOrder({")
  const insertIndex = route.indexOf(".insert(orderPayload")

  for (const index of [catalogIndex, settingsIndex, pricingIndex, expectedTotalIndex, reuseIndex, pendingIndex, insertIndex]) {
    assert.ok(index > 0)
  }
  assert.ok(catalogIndex < pricingIndex && settingsIndex < pricingIndex)
  assert.ok(pricingIndex < expectedTotalIndex)
  assert.ok(expectedTotalIndex < reuseIndex)
  assert.ok(reuseIndex < pendingIndex && pendingIndex < insertIndex)
  // Nunca se reutiliza una orden con otra huella económica.
  assert.match(route, /if \(!isEconomicallyEquivalentAttempt\(order, economicFingerprint\)\) \{\s*return null/)
})

test("el checkout reacciona al 409 PRICING_CHANGED: refresca, avisa el nuevo total y no redirige a Mercado Pago", () => {
  const start = checkout.indexOf('if (response.status === 409 && data?.code === "PRICING_CHANGED")')
  assert.ok(start >= 0)
  const block = checkout.slice(start, checkout.indexOf("return\n      }", start))
  assert.match(block, /refreshCommercialData\(true\)/)
  assert.match(block, /setCommercialUpdateNotice\(/)
  assert.doesNotMatch(block, /window\.location/)
  // Mercado Pago y transferencia mandan el total visto; la compra con saldo no cobra nada externo.
  assert.match(checkout, /expectedTotal: customerCreditCoversTotal \? undefined : expectedCheckoutTotal,/)
})

test("carrito y checkout avisan cuando cambian precios o condiciones (nunca en silencio)", () => {
  const wrapper = readSource("../cart/cart-wrapper.tsx")
  const drawer = readSource("../cart/cart-drawer.tsx")
  const refreshLib = readSource("../../lib/cart/cart-catalog-refresh.ts")

  assert.match(refreshLib, /"Los precios o condiciones de tu compra fueron actualizados\."/)
  assert.match(checkout, /useCommercialRefresh\(\{/)
  assert.match(checkout, /onChange: \(\) => setCommercialUpdateNotice\(COMMERCIAL_UPDATE_NOTICE\)/)
  assert.match(wrapper, /useCommercialRefresh\(\{/)
  assert.match(drawer, /role="status"/)
})

// ─────────────────────────────────────────────────────────────
// Contraste global (tokens semánticos, dark intacto)
// ─────────────────────────────────────────────────────────────

test("contraste light: el texto secundario sale de tokens semánticos (~85% negro), no de literales", () => {
  assert.match(css, /--beyonix-light-text-secondary: #262b33;/)
  assert.match(css, /--muted-foreground: var\(--beyonix-light-text-secondary\);/)
  assert.match(css, /--account-text-secondary: var\(--beyonix-light-text-secondary\);/)
  assert.match(css, /--beyonix-text-secondary: var\(--beyonix-light-text-secondary\);/)
  assert.equal(
    (css.match(/--admin-text-soft: var\(--beyonix-light-text-secondary\);/g) ?? []).length,
    3,
  )
  // Ya no quedan literales de gris lavado para texto en las reglas light del Admin
  // (fuera de disabled/placeholder/marcas decorativas).
  assert.doesNotMatch(css, /\.admin-order-rs-sub \{\n\s*color: rgba\(15, 23, 42, 0\.62\)/)
  // Curva text-white/N del Admin light: piso 82% (antes 60%).
  assert.match(css, /\.text-white\\\/15 \{ color: color-mix\(in oklab, var\(--admin-text\) 82%, transparent\) !important; \}/)
})

test("dark mode no se toca: tokens oscuros originales intactos", () => {
  const rootBlock = extractBlock(css, ":root {")
  const darkBlock = extractBlock(css, ".dark {")
  for (const block of [rootBlock, darkBlock]) {
    assert.match(block, /--muted-foreground: oklch\(0\.75 0 0\);/)
    assert.match(block, /--foreground: oklch\(0\.98 0 0\);/)
  }
  assert.match(css, /--admin-text-soft: rgba\(248, 250, 252, 0\.68\);/)
  assert.match(css, /--admin-text-muted: rgba\(248, 250, 252, 0\.46\);/)
})

test("disabled y placeholder siguen distinguibles del texto secundario en light", () => {
  assert.match(css, /--beyonix-light-text-disabled: rgba\(15, 23, 42, 0\.55\);/)
  assert.match(css, /--account-text-disabled: var\(--beyonix-light-text-disabled\);/)
  assert.match(
    css,
    /:is\(button, input, select, textarea, \[role="button"\], \[role="radio"\], \[role="tab"\]\):is\(:disabled, \[aria-disabled="true"\]\):not\(#\\#\)/,
  )
  assert.match(css, /:is\(input, textarea\)::placeholder \{\n\s*color: var\(--account-text-placeholder\) !important;/)
  // Los disabled/placeholder del Admin conservan su gris propio.
  assert.match(css, /:where\(input, textarea, select\):disabled \{[^}]*color: rgba\(15, 23, 42, 0\.55\) !important;/)
})

test("tipografía chica +1px sólo en la escala de captions (text-sm y mayores intactos)", () => {
  assert.match(css, /--text-xs: 0\.8125rem;/)
  assert.match(css, /--text-10px: 11px;/)
  assert.match(css, /--text-11px: 12px;/)
  assert.match(css, /--text-12px: 13px;/)
  assert.match(css, /--text-13px: 14px;/)
  assert.match(css, /--text-14px: 14px;/)
  assert.match(css, /--text-16px: 16px;/)
  assert.doesNotMatch(css, /--text-sm:/)
})
