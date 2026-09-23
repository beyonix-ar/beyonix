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

test("se muestran exactamente tres opciones: transferencia, Mercado Pago al contado y en cuotas (sin MODO)", () => {
  const options = [...checkout.matchAll(/option="([^"]+)"\n/g)].map((match) => match[1])
  assert.deepEqual(options, ["transferencia", "mercadopago_cash", "mercadopago_financed"])
  assert.match(checkout, /title="Depósito \/ Transferencia"/)
  assert.match(checkout, /title="Mercado Pago al contado"/)
  assert.match(checkout, /title="Mercado Pago en cuotas"/)
  assert.doesNotMatch(checkout, /\bMODO\b/)
  // Sólo dos medios reales por debajo; el payload sigue siendo el mismo.
  assert.match(checkout, /const CHECKOUT_PAYMENT_METHOD_IDS = \["mercadopago", "transferencia"\] as const/)
  assert.match(checkout, /mercadoPagoMode: effectiveMercadoPagoMode,/)
  assert.doesNotMatch(checkout, /Modalidad de pago/)
  assert.doesNotMatch(checkout, /setInstallmentsModality/)
})

test("una sola elección (radio nativo) y sin estado extra: la opción se deriva del estado existente", () => {
  assert.equal((checkout.match(/name="checkout-payment-option"/g) ?? []).length, 1)
  assert.match(checkout, /type="radio"/)
  assert.match(
    checkout,
    /const selectedPaymentOption = getCheckoutPaymentOption\(\s*selectedPayment,\s*effectiveMercadoPagoMode,\s*\)/,
  )
  assert.doesNotMatch(checkout, /useState<CheckoutPaymentOption/)
})

test("el detalle de cuotas es informativo: modal con filas <li>, sin controles ni estado de pago", () => {
  const rowsStart = checkout.indexOf("{plans.map((plan) => (")
  assert.ok(rowsStart > 0)
  const rows = checkout.slice(rowsStart, checkout.indexOf("</ul>", rowsStart))
  assert.match(rows, /<li\s+key=\{plan\.count\}\s+data-installment-plan=\{plan\.count\}/)
  assert.doesNotMatch(rows, /onClick|role="radio"|<button|<input|aria-checked|set[A-Z]\w*\(/)
  // El modal sólo abre/cierra información: nunca cambia medio ni modalidad.
  assert.match(checkout, /useState<"installments" \| "mercadopago_cash" \| null>\(null\)/)
  const infoLinkStart = checkout.indexOf("function CheckoutPaymentInfoLink(")
  const infoLink = checkout.slice(infoLinkStart, checkout.indexOf("\n}\n", infoLinkStart))
  assert.match(infoLink, /type="button"/)
  assert.doesNotMatch(infoLink, /setSelectedPayment|setMercadoPagoMode/)
  const modal = readSource("./payment-info-modal.tsx")
  assert.doesNotMatch(modal, /setSelectedPayment|setMercadoPagoMode|type="radio"/)
})

test("resumen: contado dice 'Pago con Mercado Pago al contado'; cuotas 'Hasta N cuotas sin interés de $X'", () => {
  assert.match(checkout, /"Pago con Mercado Pago al contado"/)
  assert.match(checkout, /`Hasta \$\{maxInstallmentPlan\.count\} cuotas sin interés de \$\{formatPrice\(maxInstallmentPlan\.amount\)\}`/)
  // El total del resumen es el de la modalidad elegida (el mismo que se cobra).
  assert.match(checkout, /mercadoPagoQuote\?\.externalAmountDue \?\? customerCreditApplication\.externalAmountDue/)
})

test("CFTEA: discreto, dentro del detalle de cuotas y nunca en la pantalla principal", () => {
  assert.equal((checkout.match(/data-cftea-disclosure/g) ?? []).length, 1)
  const modalStart = checkout.indexOf('{paymentInfoModal === "installments" && financedPreviewQuote && (')
  const modalEnd = checkout.indexOf("</PaymentInfoModal>", modalStart)
  assert.ok(modalStart > 0 && checkout.indexOf("data-cftea-disclosure") > modalStart && checkout.indexOf("data-cftea-disclosure") < modalEnd)
  assert.match(checkout, /CFTEA: \{cfteaSummary\}/)
  assert.doesNotMatch(checkout, /Costo financiero total efectivo anual/)
  assert.doesNotMatch(checkout, /— precio financiado/)
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
