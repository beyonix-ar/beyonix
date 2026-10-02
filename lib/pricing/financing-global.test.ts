import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

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
  DEFAULT_INTEREST_FREE_POLICY,
  normalizeInterestFreePolicy,
  normalizeMercadoPagoInterestFreeStatus,
  type MercadoPagoInterestFreeReference,
  type MercadoPagoInterestFreeStatus,
} from "../mercadopago/interest-free-policy.ts"
import {
  parseInterestFreeInstallmentCounts,
  parseInterestFreeInstallmentsByBrand,
} from "../mercadopago/interest-free-installments.ts"
import type { InstallmentCount } from "../products/installments.ts"
import { calculateCustomerShippingCost, DEFAULT_SHIPPING_SETTINGS } from "../store-config.ts"

// Financiación centralizada: nunca depende del producto; depende del MONTO
// FINAL que se cobra por Mercado Pago y de lo que Mercado Pago confirma.
// BEYONIX absorbe como máximo 6 cuotas. Admin → Financiación es la única fuente.

const SETTINGS: CheckoutPricingSettings = {
  installmentsFinancing: { baseProcessingPercent: 3.46, ivaPercent: 21, surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 } },
  transferDiscountPercent: 10,
  nationalTaxesIncidencePercent: 21,
  financedPricePolicy: "cover_costs",
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

test("cliente elige menos cuotas -> mismo precio financiado (2, 3 y 6 dividen el mismo total)", () => {
  const pricing = pricingWith([line(1, 100_000)], () => [2, 3, 6])
  const total = pricing.financed!.externalAmountDue
  assert.deepEqual(pricing.installmentPlans.map((plan) => plan.count), [2, 3, 6])
  for (const plan of pricing.installmentPlans) {
    assert.equal(Math.round(plan.amount * plan.count * 100) / 100, total, `${plan.count} cuotas cobran el mismo total`)
  }
})

test("cuotas con interés a cargo del comprador no cuentan como sin interés", () => {
  const issuer = (costs: Array<[number, number, string[]]>) => ({
    payer_costs: costs.map(([installments, rate, labels]) => ({ installments, installment_rate: rate, labels })),
  })
  const free = ["interest_deduction_by_collector"]
  // 3 cuotas con tasa para el comprador: no es "sin interés" y tampoco habilita 6.
  assert.deepEqual(
    parseInterestFreeInstallmentCounts([[issuer([[2, 0, free], [3, 12.5, []], [6, 0, free]])]]),
    [2],
  )
  // Sin la etiqueta de financiación a cargo del vendedor tampoco cuenta, aunque la tasa sea 0.
  assert.deepEqual(parseInterestFreeInstallmentCounts([[issuer([[2, 0, []]])]]), [])
})

test("compatibilidad por marca: 2/3 Visa+Mastercard, 6 sólo Visa; ninguna otra marca se presume compatible", () => {
  const issuer = (...counts: number[]) => ({
    payer_costs: counts.map((installments) => ({ installments, installment_rate: 0, labels: ["interest_deduction_by_collector"] })),
  })
  const parsed = parseInterestFreeInstallmentsByBrand([
    { brand: "visa", response: [issuer(2, 3, 6)] },
    { brand: "master", response: [issuer(2, 3)] },
  ])!
  assert.deepEqual(parsed.counts, [2, 3, 6])
  assert.deepEqual(parsed.brandsByCount, { 2: ["visa", "master"], 3: ["visa", "master"], 6: ["visa"] })
  assert.ok(!JSON.stringify(parsed).includes("amex"))
})

// ─── Monto real que cobra Mercado Pago (envío, bonificación, saldo) ───

test("ejemplo: productos $90.000 + envío $18.000 − bonificación $10.000 − saldo $5.000 = $93.000 para Mercado Pago", () => {
  const settings = { ...DEFAULT_SHIPPING_SETTINGS, freeShippingMode: "full" as const, freeShippingMinAmount: 50_000, shippingBonusMax: 10_000 }
  const shipping = calculateCustomerShippingCost(90_000, 18_000, settings)
  assert.equal(shipping, 8_000)
  const pricing = pricingWith([line(1, 90_000)], () => [2, 3, 6], { shipping, credit: 5_000 })
  assert.equal(pricing.cash.externalAmountDue, 93_000)
  // Cuotas: el monto consultado/cobrado es el financiado de productos + envío pagado − saldo.
  const expected = getFinancedPrice(90_000, 6, SETTINGS.installmentsFinancing)! + 8_000 - 5_000
  assert.ok(Math.abs(pricing.financed!.externalAmountDue - expected) < 0.1)
})

test("envío: pagado suma, gratis suma $0, parcialmente bonificado suma sólo lo que paga el cliente", () => {
  const settings = { ...DEFAULT_SHIPPING_SETTINGS, freeShippingMode: "full" as const, freeShippingMinAmount: 50_000, shippingBonusMax: 20_000 }
  // Andreani $30.000, BEYONIX bonifica $20.000: el cliente paga $10.000.
  assert.equal(calculateCustomerShippingCost(90_000, 30_000, settings), 10_000)
  // Bonificación que cubre todo: envío gratis.
  assert.equal(calculateCustomerShippingCost(90_000, 15_000, settings), 0)

  const asked: number[] = []
  const lookup: InterestFreeLookup = (amount) => {
    asked.push(amount)
    return [2, 3, 6]
  }
  const amountFor = (shipping: number) => {
    asked.length = 0
    pricingWith([line(1, 90_000)], lookup, { shipping })
    return asked[0]
  }
  const free = amountFor(0)
  assert.ok(Math.abs(amountFor(10_000) - free - 10_000) < 0.1, "sólo suma la parte que paga el cliente")
  assert.ok(Math.abs(amountFor(30_000) - free - 30_000) < 0.1, "envío pagado completo suma completo")
})

// ─── Cuotas OFF y Mercado Pago caído ───

const reference = (overrides: Partial<MercadoPagoInterestFreeReference> = {}): MercadoPagoInterestFreeReference => ({
  checkedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
  minimumAmountByCount: { 2: 41_000, 3: 47_000, 6: 73_000 },
  brandsByCount: { 2: ["visa", "master"], 3: ["visa", "master"], 6: ["visa", "master"] },
  maxProbedAmount: 2_000_000,
  ...overrides,
})
const ok = (ref: MercadoPagoInterestFreeReference | null): MercadoPagoInterestFreeStatus => ({
  reference: ref,
  lastAttemptAt: ref?.checkedAt ?? null,
  lastError: null,
  lastFailure: null,
})
const text = (offer: ReturnType<typeof buildPublicInterestFreeOffer>) =>
  getInterestFreeMessage(offer)?.text.replace(/ /g, " ") ?? null
const ROOT = new URL("../../", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8")

test("cuotas OFF: sin texto público, sin consultas a Mercado Pago, sólo 1 pago a contado", () => {
  assert.equal(buildPublicInterestFreeOffer(ok(reference()), { enabled: false }, NOW), null)
  assert.match(read("app/api/mercadopago/installments/route.ts"), /if \(!interestFreePolicy\.enabled\) return \{ key: String\(amount\), counts: \[\], brands: \{\} \}/)
  assert.match(read("app/api/mercadopago/create-preference/route.ts"), /mode === "financed" && siteSettings\.interestFreePolicy\.enabled/)
  assert.match(read("app/api/cron/sync-mercadopago-installments/route.ts"), /skipped: "interest_free_disabled"/)
})

test("Mercado Pago caído en el checkout: no inventa cuotas, sólo 1 pago a contado", () => {
  const pricing = pricingWith([line(1, 100_000)], () => null)
  assert.equal(pricing.financed, null)
  assert.equal(pricing.offeredInstallmentCount, null)
  assert.equal(pricing.cash.total, 100_000)
  // Todavía consultando: tampoco se muestra un precio financiado dudoso.
  assert.equal(pricingWith([line(1, 100_000)], () => undefined).financed, null)
})

// ─── Sin mínimos propios: Mercado Pago es la fuente de verdad ───

test("sin mínimos propios: cada cuota se comunica desde el MISMO monto que confirma Mercado Pago", () => {
  const offer = buildPublicInterestFreeOffer(ok(reference()), DEFAULT_INTEREST_FREE_POLICY, NOW)!
  assert.deepEqual(
    offer.tiers.map((tier) => [tier.count, tier.minimumAmount]),
    [[2, 41_000], [3, 47_000], [6, 73_000]],
  )
  // Mínimos propios guardados antes se ignoran: la política sólo tiene ON/OFF.
  assert.deepEqual(normalizeInterestFreePolicy({ enabled: true, minimumAmountByCount: { 3: 80_000, 6: 120_000 } }), { enabled: true })
  for (const path of [
    "lib/mercadopago/interest-free-policy.ts",
    "lib/pricing/interest-free-communication.ts",
    "app/api/admin/settings/route.ts",
    "app/api/mercadopago/create-preference/route.ts",
    "app/api/mercadopago/installments/route.ts",
    "app/admin/sections/financiacion/financing-panel.tsx",
  ]) {
    assert.doesNotMatch(read(path), /applyInterestFreePolicy|validateInterestFreePolicy|Mínimo BEYONIX|policy\.minimumAmountByCount/, path)
  }
})

// ─── Texto global estable ───

for (const [label, minimums, expected] of [
  ["MP no confirma nada", { 2: null, 3: null, 6: null }, null],
  ["MP sólo 2", { 2: 35_000, 3: null, 6: null }, "Hasta 2 cuotas sin interés a partir de $ 35.000"],
  ["MP 2 y 3", { 2: 35_000, 3: 52_000, 6: null }, "Hasta 3 cuotas sin interés a partir de $ 52.000"],
  ["MP 2, 3 y 6", { 2: 35_000, 3: 52_000, 6: 88_000 }, "Hasta 6 cuotas sin interés a partir de $ 88.000"],
] as Array<[string, Record<InstallmentCount, number | null>, string | null]>) {
  test(`texto global: ${label} -> ${expected ?? "sin texto"}`, () => {
    assert.equal(text(buildPublicInterestFreeOffer(ok(reference({ minimumAmountByCount: minimums })), DEFAULT_INTEREST_FREE_POLICY, NOW)), expected)
  })
}

test("mismo texto global en Home, categorías, tarjetas, ficha, carrito y checkout: nunca depende del precio ni del total", () => {
  const offer = buildPublicInterestFreeOffer(ok(reference()), DEFAULT_INTEREST_FREE_POLICY, NOW)
  assert.equal(getInterestFreeMessage.length, 1, "no recibe monto")
  assert.equal(text(offer), "Hasta 6 cuotas sin interés a partir de $ 73.000")
  for (const [path, call] of [
    ["components/hero-section.tsx", /getInterestFreeMessage\(interestFreeOffer\)/],
    ["components/products/shared/shared-product-card.tsx", /getInterestFreeMessage\(interestFreeOffer\)/],
    ["components/products/product-details-panel.tsx", /getInterestFreeMessage\(interestFreeOffer\)/],
    ["components/cart/cart-summary.tsx", /getInterestFreeMessage\(siteSettings\.interestFreeOffer\)/],
    ["app/checkout/page.tsx", /getInterestFreeMessage\(siteSettings\.interestFreeOffer\)/],
  ] as const) {
    assert.match(read(path), call, path)
  }
})

test("marcas: si la cuota máxima sólo aplica a Visa lo dice; nunca se comunica como universal", () => {
  const offer = buildPublicInterestFreeOffer(
    ok(reference({ brandsByCount: { 2: ["visa", "master"], 3: ["visa", "master"], 6: ["visa"] } })),
    DEFAULT_INTEREST_FREE_POLICY,
    NOW,
  )
  assert.equal(text(offer), "Hasta 6 cuotas sin interés a partir de $ 73.000 con Visa")
})

test("MP falla o la referencia es vieja -> no se comunica ninguna promoción", () => {
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

test("referencia guardada con el formato anterior (2 cuotas aparte) se sigue leyendo", () => {
  const status = normalizeMercadoPagoInterestFreeStatus({
    reference: { checkedAt: NOW.toISOString(), minimumAmountByCount: { 3: null, 6: null }, minimumAmountForTwo: 35_000, brandsByCount: { 2: ["visa", "master"] }, maxProbedAmount: 2_000_000 },
    lastAttemptAt: NOW.toISOString(),
    lastError: null,
  })
  assert.deepEqual(status.reference?.minimumAmountByCount, { 2: 35_000, 3: null, 6: null })
  assert.equal(status.lastFailure, null)
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
  const files = ["app", "components", "lib", "hooks", "context"].flatMap((dir) => sourceFiles(fileURLToPath(new URL(dir, ROOT))))
  const offenders = files.filter((path) => {
    const source = readFileSync(path, "utf8")
    // La única mención permitida es la lista de columnas legacy que la API de
    // catálogo descarta explícitamente.
    const withoutLegacyGuard = source.replace(/for \(const legacyField of \[[\s\S]*?\]\)/, "")
    return /\.cuotas_(2|3|6)_habilitadas|cuotas_sin_recargo:|getEligibleInstallmentCounts|getCartInstallmentEligibility|getProductInterestFreeOffer|getMaxEligibleInstallmentCount|hasInstallmentsWithoutSurcharge|Mismo precio en contado y cuotas|max_installments|same_price_cash_installments/.test(withoutLegacyGuard)
  })
  assert.deepEqual(offenders, [])

  const form = read("app/admin/sections/productos/producto-form.tsx")
  assert.doesNotMatch(form, /"2 cuotas"|"3 cuotas"|"6 cuotas"|cuotasSinRecargo/)
  const line: CheckoutPricingLine = { productId: 1, variantId: null, conditionedStockId: null, quantity: 1, unitPrice: 1 }
  assert.deepEqual(Object.keys(line).sort(), ["conditionedStockId", "productId", "quantity", "unitPrice", "variantId"])
})

// ─── Sincronización real (VPS/PM2, sin Vercel cron) ───

test("sincronización periódica: timer de systemd del VPS, sin cron de Vercel; fresca, fallo registrado", () => {
  const vercel = JSON.parse(read("vercel.json")) as { crons?: Array<{ path: string }> }
  assert.equal(vercel.crons?.some((cron) => cron.path.includes("sync-mercadopago-installments")), false, "producción no corre en Vercel")
  const service = read("deploy/systemd/beyonix-sync-mercadopago-installments.service")
  assert.match(service, /http:\/\/127\.0\.0\.1:3000\/api\/cron\/sync-mercadopago-installments/)
  assert.match(service, /--config \/etc\/beyonix\/curl-verify-transfer-orders\.conf/)
  assert.doesNotMatch(service, /Bearer|CRON_SECRET=/, "el secreto nunca vive en el unit")
  assert.match(read("deploy/systemd/beyonix-sync-mercadopago-installments.timer"), /Unit=beyonix-sync-mercadopago-installments\.service/)

  const cron = read("app/api/cron/sync-mercadopago-installments/route.ts")
  assert.match(cron, /isCronRequestAuthorized\(request\.headers\.get\("authorization"\), process\.env\.CRON_SECRET\)/)
  const sync = read("lib/mercadopago/interest-free-sync.ts")
  assert.match(sync, /getInterestFreeInstallments\(amount, \{ fresh: true \}\)/)
  assert.match(sync, /reference: previous\.reference,/)
  const admin = read("app/api/admin/financiacion/referencia-mercadopago/route.ts")
  assert.match(admin, /syncMercadoPagoInterestFreeReference\(auth\.admin, \{ updatedBy: auth\.user\.id \}\)/)
  // La preferencia revalida en vivo, sin caché.
  assert.match(read("app/api/mercadopago/create-preference/route.ts"), /getInterestFreeInstallments\(candidate\.amount, \{ fresh: true \}\)/)
  assert.match(read("app/checkout/page.tsx"), /useInterestFreeInstallments\(/)
})
