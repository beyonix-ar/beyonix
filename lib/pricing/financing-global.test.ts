import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  calculateMercadoPagoCheckoutPricing,
  getMercadoPagoFinancingCandidates,
  getMercadoPagoModeQuote,
  type CheckoutPricingLine,
  type CheckoutPricingSettings,
} from "./checkout-pricing.ts"
import { getFinancedPrice, type InterestFreeLookup } from "./financed-pricing.ts"
import {
  buildPublicInterestFreeOffer,
  getInterestFreeMessage,
  INTEREST_FREE_OFFER_MAX_AGE_MS,
} from "./interest-free-communication.ts"
import {
  applyInterestFreePolicy,
  DEFAULT_INTEREST_FREE_POLICY,
  type InterestFreePolicy,
  type MercadoPagoInterestFreeReference,
  type MercadoPagoInterestFreeStatus,
} from "../mercadopago/interest-free-policy.ts"
import { parseInterestFreeInstallmentCounts } from "../mercadopago/interest-free-installments.ts"
import type { InstallmentCount } from "../products/installments.ts"

// Financiación centralizada: nunca depende del producto; depende del MONTO
// FINAL que se cobra por Mercado Pago y de lo que Mercado Pago confirma.
// BEYONIX absorbe como máximo 6 cuotas. Admin → Financiación es la única fuente.

const SETTINGS: CheckoutPricingSettings = {
  installmentsFinancing: { baseProcessingPercent: 3.46, ivaPercent: 21, surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 } },
  transferDiscountPercent: 10,
  nationalTaxesIncidencePercent: 21,
}
const NOW = new Date("2026-10-01T12:00:00.000Z")

const line = (productId: number, unitPrice: number, quantity = 1): CheckoutPricingLine => ({
  productId,
  variantId: null,
  conditionedStockId: null,
  quantity,
  unitPrice,
})

function input(lines: CheckoutPricingLine[], { shipping = 0, credit = 0, benefit = null as number | null } = {}) {
  return { lines, shippingCharged: shipping, storeBenefitPercent: benefit, requestedCustomerCredit: credit, settings: SETTINGS }
}

const pricingWith = (lines: CheckoutPricingLine[], lookup: InterestFreeLookup | null, options = {}) =>
  calculateMercadoPagoCheckoutPricing({ ...input(lines, options), interestFreeLookup: lookup })

// ─── El monto final manda ───

test("total final: varias unidades suman, envío pagado suma, envío gratis suma 0, saldo y beneficio reducen el monto consultado", () => {
  const amount = (lines: CheckoutPricingLine[], options = {}) =>
    getMercadoPagoFinancingCandidates(input(lines, options)).find((candidate) => candidate.count === 6)!.amount
  const base = amount([line(1, 25_000)])
  assert.ok(amount([line(1, 25_000, 2)]) > base * 1.99, "2 unidades ~ duplican el monto")
  assert.ok(amount([line(1, 25_000), line(2, 25_000)]) > base * 1.99, "otro producto suma igual")
  assert.equal(amount([line(1, 25_000)], { shipping: 8_000 }) >= base + 8_000, true, "el envío que paga el cliente suma")
  assert.equal(amount([line(1, 25_000)], { shipping: 0 }), base, "envío gratis suma 0")
  assert.ok(amount([line(1, 25_000)], { credit: 10_000 }) < base, "el saldo aplicado reduce lo que cobra Mercado Pago")
  assert.ok(amount([line(1, 25_000)], { benefit: 10 }) < base, "el descuento reduce el monto")
})

test("la decisión de cuotas sigue al total: 1 unidad no alcanza, 2 unidades sí (mismo producto)", () => {
  const mercadoPago: InterestFreeLookup = (amount) => (amount >= 60_000 ? [2, 3, 6] : amount >= 35_000 ? [2, 3] : [])
  assert.equal(pricingWith([line(1, 20_000)], mercadoPago).financed, null)
  assert.equal(pricingWith([line(1, 20_000, 2)], mercadoPago).offeredInstallmentCount, 3)
  assert.equal(pricingWith([line(1, 20_000, 4)], mercadoPago).offeredInstallmentCount, 6)
})

// ─── Mercado Pago manda; BEYONIX máximo 6 ───

for (const [confirmed, expected] of [
  [[], null],
  [[2], 2],
  [[2, 3], 3],
  [[2, 3, 6], 6],
] as Array<[InstallmentCount[], InstallmentCount | null]>) {
  test(`MP confirma [${confirmed.join(", ")}] -> máximo ${expected ?? "ninguno (1 pago)"}, precio con el costo de ese máximo`, () => {
    const pricing = pricingWith([line(1, 100_000)], () => confirmed)
    assert.equal(pricing.offeredInstallmentCount, expected)
    if (expected === null) {
      assert.equal(pricing.financed, null)
      return
    }
    assert.equal(pricing.financedTotal, getFinancedPrice(100_000, expected, SETTINGS.installmentsFinancing))
    assert.equal(pricing.financed?.preferenceMaxInstallments, expected)
  })
}

test("MP ofrece 9/12/18 sin interés -> BEYONIX sigue en máximo 6 y no los absorbe", () => {
  const issuer = (...counts: number[]) => ({
    payer_costs: counts.map((installments) => ({ installments, installment_rate: 0, labels: ["interest_deduction_by_collector"] })),
  })
  // Aunque Mercado Pago marque 9/12/18 sin interés, sólo existen 2/3/6 para BEYONIX.
  assert.deepEqual(parseInterestFreeInstallmentCounts([[issuer(2, 3, 6, 9, 12, 18)]]), [2, 3, 6])
  const pricing = pricingWith([line(1, 100_000)], () => [2, 3, 6])
  assert.equal(pricing.financed?.preferenceMaxInstallments, 6)
})

test("1 pago es siempre precio contado (crédito 1 pago, débito o dinero en cuenta)", () => {
  const pricing = pricingWith([line(1, 100_000)], () => [2, 3, 6], { shipping: 5_000 })
  const cash = getMercadoPagoModeQuote(pricing, "cash")!
  assert.equal(cash.total, 105_000)
  assert.equal(cash.preferenceMaxInstallments, 1)
  assert.ok(pricing.financed!.total > cash.total)
})

// ─── Política: OFF y mínimos propios ───

const policy = (enabled: boolean, three: number | null = null, six: number | null = null): InterestFreePolicy => ({
  enabled,
  minimumAmountByCount: { 3: three, 6: six },
})
const reference = (overrides: Partial<MercadoPagoInterestFreeReference> = {}): MercadoPagoInterestFreeReference => ({
  checkedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
  minimumAmountByCount: { 3: 41_000, 6: 73_000 },
  minimumAmountForTwo: 41_000,
  brandsByCount: { 2: ["visa", "master"], 3: ["visa", "master"], 6: ["visa", "master"] },
  maxProbedAmount: 2_000_000,
  ...overrides,
})
const ok = (ref: MercadoPagoInterestFreeReference | null): MercadoPagoInterestFreeStatus => ({
  reference: ref,
  lastAttemptAt: ref?.checkedAt ?? null,
  lastError: null,
})

test("OFF desactiva cuotas: no hay oferta pública ni cuotas confirmadas para ningún total", () => {
  assert.equal(buildPublicInterestFreeOffer(ok(reference()), policy(false), NOW), null)
  assert.deepEqual(applyInterestFreePolicy([2, 3, 6], 900_000, policy(false)), [])
})

test("un mínimo manual nunca crea una promoción que Mercado Pago no confirma", () => {
  // MP sólo confirma 2: un mínimo para 3/6 no habilita 3 ni 6.
  const offer = buildPublicInterestFreeOffer(
    ok(reference({ minimumAmountByCount: { 3: null, 6: null } })),
    policy(true, 50_000, 80_000),
    NOW,
  )
  assert.deepEqual(offer?.tiers.map((tier) => tier.count), [2])
  assert.deepEqual(applyInterestFreePolicy([2], 500_000, policy(true, 50_000, 80_000)), [2])
  // Más restrictivo que MP: el mínimo efectivo es el mayor.
  const strict = buildPublicInterestFreeOffer(ok(reference()), policy(true, 50_000, 80_000), NOW)!
  assert.deepEqual(
    strict.tiers.map((tier) => [tier.count, tier.minimumAmount]),
    [[2, 50_000], [3, 50_000], [6, 80_000]],
  )
})

// ─── Texto global estable ───

test("texto global: estructura estable, sólo cambian la cantidad máxima y el monto mínimo (dinámicos)", () => {
  const offer = buildPublicInterestFreeOffer(ok(reference()), DEFAULT_INTEREST_FREE_POLICY, NOW)
  const text = (amount?: number) => getInterestFreeMessage(offer, amount)?.text.replace(/\u00a0/g, " ")
  // Sin monto (Home/categorías): el mayor rango vigente.
  assert.equal(text(), "Hasta 6 cuotas sin interés a partir de $ 73.000")
  // Con el total del carrito: cambia al agregar unidades (+/-), sin otra estructura.
  assert.equal(text(20_000), "Hasta 2 cuotas sin interés a partir de $ 41.000")
  assert.equal(text(50_000), "Hasta 3 cuotas sin interés a partir de $ 41.000")
  assert.equal(text(90_000), "Hasta 6 cuotas sin interés a partir de $ 73.000")
  assert.equal(getInterestFreeMessage(offer, 20_000)?.qualifies, false)
  assert.equal(getInterestFreeMessage(offer, 90_000)?.qualifies, true)
})

test("marcas: un rango que sólo aplica a Visa lo dice; nunca se comunica como universal", () => {
  const offer = buildPublicInterestFreeOffer(
    ok(reference({ brandsByCount: { 2: ["visa", "master"], 3: ["visa", "master"], 6: ["visa"] } })),
    DEFAULT_INTEREST_FREE_POLICY,
    NOW,
  )
  assert.equal(getInterestFreeMessage(offer)?.text.replace(/\u00a0/g, " "), "Hasta 6 cuotas sin interés a partir de $ 73.000 con Visa")
  assert.equal(getInterestFreeMessage(offer, 50_000)?.text.replace(/\u00a0/g, " "), "Hasta 3 cuotas sin interés a partir de $ 41.000")
})

test("MP no confirma nada, falla o la referencia es vieja -> no se comunica ninguna promoción", () => {
  const none = reference({ minimumAmountByCount: { 3: null, 6: null }, minimumAmountForTwo: null })
  assert.equal(buildPublicInterestFreeOffer(ok(none), DEFAULT_INTEREST_FREE_POLICY, NOW), null)
  assert.equal(getInterestFreeMessage(null), null)
  // Último intento fallido: la referencia anterior nunca es garantía.
  assert.equal(
    buildPublicInterestFreeOffer({ ...ok(reference()), lastError: "Mercado Pago no respondió." }, DEFAULT_INTEREST_FREE_POLICY, NOW),
    null,
  )
  const stale = reference({ checkedAt: new Date(NOW.getTime() - INTEREST_FREE_OFFER_MAX_AGE_MS - 1).toISOString() })
  assert.equal(buildPublicInterestFreeOffer(ok(stale), DEFAULT_INTEREST_FREE_POLICY, NOW), null)
  assert.equal(buildPublicInterestFreeOffer(ok(null), DEFAULT_INTEREST_FREE_POLICY, NOW), null)
})

// ─── Sin financiación por producto ───

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

test("no queda financiación por producto: sin toggles 2/3/6, sin 'Mismo precio', sin cálculos por cuotas del producto", () => {
  const root = new URL("../../", import.meta.url)
  const files = ["app", "components", "lib", "hooks", "context"].flatMap((dir) => sourceFiles(new URL(dir, root).pathname.replace(/^\/([A-Za-z]:)/, "$1")))
  const offenders = files.filter((path) => {
    const source = readFileSync(path, "utf8")
    // La única mención permitida es la lista de columnas legacy que la API de
    // catálogo descarta explícitamente.
    const withoutLegacyGuard = source.replace(/for \(const legacyField of \[[\s\S]*?\]\)/, "")
    return /\.cuotas_(2|3|6)_habilitadas|cuotas_sin_recargo:|getEligibleInstallmentCounts|getCartInstallmentEligibility|getProductInterestFreeOffer|getMaxEligibleInstallmentCount|hasInstallmentsWithoutSurcharge|Mismo precio en contado y cuotas|max_installments|same_price_cash_installments/.test(withoutLegacyGuard)
  })
  assert.deepEqual(offenders, [])

  const form = readFileSync(new URL("app/admin/sections/productos/producto-form.tsx", root), "utf8")
  assert.doesNotMatch(form, /"2 cuotas"|"3 cuotas"|"6 cuotas"|cuotasSinRecargo/)
  const line: CheckoutPricingLine = { productId: 1, variantId: null, conditionedStockId: null, quantity: 1, unitPrice: 1 }
  assert.deepEqual(Object.keys(line).sort(), ["conditionedStockId", "productId", "quantity", "unitPrice", "variantId"])
})

test("sincronización con Mercado Pago: cron periódico + 'Comprobar ahora', siempre fresca; OFF no consulta; fallo registrado", () => {
  const root = new URL("../../", import.meta.url)
  const read = (path: string) => readFileSync(new URL(path, root), "utf8")
  const vercel = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string; schedule: string }> }
  assert.deepEqual(
    vercel.crons.find((cron) => cron.path === "/api/cron/sync-mercadopago-installments"),
    { path: "/api/cron/sync-mercadopago-installments", schedule: "*/15 * * * *" },
  )
  const cron = read("app/api/cron/sync-mercadopago-installments/route.ts")
  assert.match(cron, /authorization !== `Bearer \$\{cronSecret\}`/)
  assert.match(cron, /if \(!interestFreePolicy\.enabled\) \{\s*return NextResponse\.json\(\{ ok: true, skipped: "interest_free_disabled" \}\)/)
  const sync = read("lib/mercadopago/interest-free-sync.ts")
  assert.match(sync, /getInterestFreeInstallments\(amount, \{ fresh: true \}\)/)
  assert.match(sync, /reference: previous\.reference, lastAttemptAt: now\.toISOString\(\), lastError: MERCADOPAGO_SYNC_FAILURE_MESSAGE/)
  const admin = read("app/api/admin/financiacion/referencia-mercadopago/route.ts")
  assert.match(admin, /syncMercadoPagoInterestFreeReference\(auth\.admin, \{ updatedBy: auth\.user\.id \}\)/)
  // El checkout comunica la regla global con el total real y decide en vivo.
  const checkout = read("app/checkout/page.tsx")
  assert.match(checkout, /getInterestFreeMessage\(siteSettings\.interestFreeOffer, cashOptionAmount\)/)
  assert.match(checkout, /useInterestFreeInstallments\(/)
})
