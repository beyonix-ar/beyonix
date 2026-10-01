import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  deriveMercadoPagoObservedCosts,
  MERCADOPAGO_COST_MODALITIES,
  resolveInstallmentsFinancing,
  type MercadoPagoObservationSourceRow,
} from "./observed-costs.ts"
import {
  applyInterestFreePolicy,
  DEFAULT_INTEREST_FREE_POLICY,
  normalizeInterestFreePolicy,
  validateInterestFreePolicy,
  type InterestFreePolicy,
} from "./interest-free-policy.ts"
import { probeInterestFreeMinimum, probeMercadoPagoInterestFreeReference } from "./interest-free-reference.ts"
import {
  buildMercadoPagoPricingSnapshot,
  calculateMercadoPagoCheckoutPricing,
  getMercadoPagoModeQuote,
  type CheckoutPricingLine,
} from "../pricing/checkout-pricing.ts"
import type { InstallmentCount, InstallmentsFinancingConfig } from "../products/installments.ts"

// Admin → Financiación: aprendizaje automático de costos reales de Mercado
// Pago (una venta alcanza), Automático/Manual, cuotas sin interés ON/OFF y
// mínimos propios evaluados sobre el TOTAL final.

const NOW = new Date("2026-10-01T12:00:00.000Z")
const MANUAL: InstallmentsFinancingConfig = {
  baseProcessingPercent: 3.46,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}

let nextId = 100
function credit(
  installments: 1 | InstallmentCount,
  percentWithIva: number,
  paidAt: string,
  extra: Partial<NonNullable<MercadoPagoObservationSourceRow["mercadopago_payment_snapshot"]>> = {},
): MercadoPagoObservationSourceRow {
  const amount = 100_000
  return {
    id: nextId++,
    paid_at: paidAt,
    mercadopago_payment_snapshot: {
      installments,
      transaction_amount: amount,
      payment_type_id: "credit_card",
      payment_method_id: "visa",
      fee_details:
        installments === 1
          ? [{ type: "mercadopago_fee", amount: (amount * percentWithIva) / 100 }]
          : [
              { type: "mercadopago_fee", amount: 4_190 },
              { type: "financing_fee", amount: (amount * percentWithIva) / 100 },
            ],
      checkout_modality: installments === 1 ? "mercadopago_cash" : "mercadopago_financed",
      ...extra,
    },
  }
}

const withoutIva = (percent: number) => Math.round((percent / 1.21) * 100) / 100

function financedTotal(config: InstallmentsFinancingConfig, confirmed: InstallmentCount[]) {
  const lines: CheckoutPricingLine[] = [
    {
      productId: 1,
      variantId: 1,
      conditionedStockId: null,
      quantity: 1,
      unitPrice: 100_000,
    },
  ]
  return calculateMercadoPagoCheckoutPricing({
    lines,
    shippingCharged: 0,
    storeBenefitPercent: null,
    requestedCustomerCredit: 0,
    settings: { installmentsFinancing: config, transferDiscountPercent: 10, nationalTaxesIncidencePercent: 21 },
    interestFreeLookup: () => confirmed,
  })
}

// ─── Automático / Manual ───

test("Automático usa el costo observado si existe; si no, el respaldo manual", () => {
  const observed = deriveMercadoPagoObservedCosts([credit(6, 24.2, "2026-09-30T10:00:00.000Z")], NOW)
  const { effective, sources } = resolveInstallmentsFinancing(MANUAL, "automatic", observed)
  assert.equal(effective.surchargePercentByCount[6], 20)
  assert.equal(sources.surchargeByCount[6], "observed")
  assert.equal(effective.surchargePercentByCount[3], 10.49, "sin pagos de 3 cuotas: respaldo")
  assert.equal(sources.surchargeByCount[3], "manual")
  assert.equal(effective.baseProcessingPercent, 3.46)
})

test("Manual ignora lo observado; volver a Automático lo retoma", () => {
  const observed = deriveMercadoPagoObservedCosts([credit(1, 4.84, "2026-09-30T10:00:00.000Z"), credit(6, 24.2, "2026-09-30T11:00:00.000Z")], NOW)
  const manual = resolveInstallmentsFinancing(MANUAL, "manual", observed)
  assert.deepEqual(manual.effective, MANUAL)
  assert.equal(manual.sources.base, "manual")
  assert.equal(manual.sources.surchargeByCount[6], "manual")
  const automatic = resolveInstallmentsFinancing(MANUAL, "automatic", observed)
  assert.equal(automatic.effective.baseProcessingPercent, 4)
  assert.equal(automatic.effective.surchargePercentByCount[6], 20)
})

// ─── Aprendizaje: una venta alcanza ───

for (const count of [3, 6] as const) {
  test(`un pago nuevo cambia ${count} cuotas -> la siguiente venta calcula con el valor nuevo`, () => {
    const expected = count === 3 ? 12.69 : 22.62
    const real = count === 3 ? 15 : 24.2
    const before = deriveMercadoPagoObservedCosts([credit(count, expected, "2026-09-20T10:00:00.000Z")], NOW)
    const sale1 = resolveInstallmentsFinancing(MANUAL, "automatic", before).effective
    assert.equal(sale1.surchargePercentByCount[count], withoutIva(expected))

    // Venta 1 aprobada: Mercado Pago cobró más. Nada manual: el próximo cálculo lo usa.
    const after = deriveMercadoPagoObservedCosts(
      [credit(count, expected, "2026-09-20T10:00:00.000Z"), credit(count, real, "2026-09-30T10:00:00.000Z")],
      NOW,
    )
    const sale2 = resolveInstallmentsFinancing(MANUAL, "automatic", after).effective
    assert.equal(sale2.surchargePercentByCount[count], withoutIva(real))
    const [change] = after.history
    assert.equal(change.modality, `credit_${count}`)
    assert.equal(change.previousPercentWithIva, expected)
    assert.equal(change.percentWithIva, real)
    assert.equal(after.lastAppliedAt, "2026-09-30T10:00:00.000Z")

    const tier = count === 3 ? [2, 3] : [2, 3, 6]
    assert.ok(
      financedTotal(sale2, tier as InstallmentCount[]).financedTotal! >
        financedTotal(sale1, tier as InstallmentCount[]).financedTotal!,
      "la venta 2 cubre el costo nuevo",
    )
  })
}

test("el costo aprendido se conserva aunque se venda poco: no vence por antigüedad", () => {
  const observed = deriveMercadoPagoObservedCosts([credit(6, 24.2, "2026-01-05T10:00:00.000Z")], NOW)
  assert.equal(observed.surchargeByCount[6]?.percentWithIva, 24.2)
})

test("no mezcla modalidades: dinero en cuenta/débito no son crédito, 3 no define 6 ni 6 define 3", () => {
  const observed = deriveMercadoPagoObservedCosts(
    [
      { ...credit(1, 4.19, "2026-09-30T10:00:00.000Z"), mercadopago_payment_snapshot: { ...credit(1, 4.19, "x").mercadopago_payment_snapshot, payment_type_id: "account_money" } },
      { ...credit(1, 3, "2026-09-30T11:00:00.000Z"), mercadopago_payment_snapshot: { ...credit(1, 3, "x").mercadopago_payment_snapshot, payment_type_id: "debit_card" } },
      credit(3, 15, "2026-09-30T12:00:00.000Z"),
    ],
    NOW,
  )
  assert.equal(observed.base, null, "sin crédito 1 pago no hay base observada")
  assert.equal(observed.singlePaymentByType.account_money?.percentWithIva, 4.19)
  assert.equal(observed.singlePaymentByType.debit_card?.percentWithIva, 3)
  assert.equal(observed.surchargeByCount[3]?.percentWithIva, 15)
  assert.equal(observed.surchargeByCount[6], null, "3 cuotas nunca define 6")
  assert.equal(observed.surchargeByCount[2], null)

  const sixOnly = deriveMercadoPagoObservedCosts([credit(6, 24.2, "2026-09-30T12:00:00.000Z")], NOW)
  assert.equal(sixOnly.surchargeByCount[3], null, "6 cuotas nunca define 3")
  // La consulta a la base también separa cada modalidad (medio + cuotas).
  assert.deepEqual(
    MERCADOPAGO_COST_MODALITIES.map(({ paymentTypeId, installments }) => `${paymentTypeId}:${installments}`),
    ["credit_card:1", "credit_card:2", "credit_card:3", "credit_card:6", "debit_card:1", "account_money:1"],
  )
})

test("datos no confiables nunca reemplazan el costo: cuotas sin cargo de financiación, en una compra 1 pago o fuera de rango", () => {
  const rows = [
    credit(6, 22.62, "2026-09-20T10:00:00.000Z"),
    // Cuotas en una compra "1 pago": imposible (la preferencia tiene 1 cuota).
    credit(6, 30, "2026-09-25T10:00:00.000Z", { checkout_modality: "mercadopago_cash" }),
    // Tasa fuera de rango.
    credit(6, 80, "2026-09-26T10:00:00.000Z"),
    // Financiado por el comprador: sin cargo de financiación para BEYONIX.
    credit(6, 0, "2026-09-27T10:00:00.000Z", { fee_details: [{ type: "mercadopago_fee", amount: 4_190 }] }),
  ]
  const observed = deriveMercadoPagoObservedCosts(rows, NOW)
  assert.equal(observed.surchargeByCount[6]?.percentWithIva, 22.62)
  assert.equal(observed.history.length, 1)
})

test("una sola venta confiable alcanza aunque el salto sea grande (18,69% -> 30%): la siguiente venta ya usa 30%", () => {
  const before = deriveMercadoPagoObservedCosts([credit(6, 22.62, "2026-09-20T10:00:00.000Z")], NOW)
  assert.equal(resolveInstallmentsFinancing(MANUAL, "automatic", before).effective.surchargePercentByCount[6], 18.69)

  // 30% sin IVA = 36,3% con IVA, cobrado en UN pago real aprobado de 6 cuotas.
  const after = deriveMercadoPagoObservedCosts(
    [credit(6, 22.62, "2026-09-20T10:00:00.000Z"), credit(6, 36.3, "2026-09-25T10:00:00.000Z")],
    NOW,
  )
  assert.equal(resolveInstallmentsFinancing(MANUAL, "automatic", after).effective.surchargePercentByCount[6], 30)
  assert.deepEqual(after.history[0], {
    modality: "credit_6",
    previousPercentWithIva: 22.62,
    percentWithIva: 36.3,
    observedAt: "2026-09-25T10:00:00.000Z",
    orderId: after.history[0].orderId,
  })
  assert.equal(after.lastAppliedAt, "2026-09-25T10:00:00.000Z")
  // Sin lógica de "esperar un segundo pago".
  const source = readFileSync(new URL("./observed-costs.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /ANOMALY|CONFIRMATION_TOLERANCE|pending\.set|"discarded"|"confirmed"/)
})

test("un dato inválido después de uno válido no reemplaza el costo observado", () => {
  const valid = credit(6, 24.2, "2026-09-20T10:00:00.000Z")
  const observed = deriveMercadoPagoObservedCosts(
    [
      valid,
      credit(6, 120, "2026-09-25T10:00:00.000Z"),
      credit(6, 24.2, "2026-09-26T10:00:00.000Z", { charges_details: [{ name: "financing_fee", rate: -5 }] }),
      credit(6, Number.NaN, "2026-09-27T10:00:00.000Z"),
      { ...credit(3, 15, "2026-09-28T10:00:00.000Z"), mercadopago_payment_snapshot: { ...credit(3, 15, "x").mercadopago_payment_snapshot, installments: 6, payment_type_id: "debit_card" } },
    ],
    NOW,
  )
  assert.equal(observed.surchargeByCount[6]?.percentWithIva, 24.2)
  assert.equal(observed.surchargeByCount[6]?.orderId, valid.id)
  assert.equal(observed.history.length, 1)
})
test("el histórico no se modifica retroactivamente: ventas viejas conservan su snapshot y su historial", () => {
  const rows = [credit(6, 22.62, "2026-09-20T10:00:00.000Z"), credit(6, 24.2, "2026-09-25T10:00:00.000Z")]
  const before = deriveMercadoPagoObservedCosts(rows, NOW)
  const after = deriveMercadoPagoObservedCosts([...rows, credit(6, 25, "2026-09-30T10:00:00.000Z")], NOW)
  assert.deepEqual(after.history.slice(1), before.history, "los eventos anteriores quedan iguales")

  // La orden vieja guardó su precio con el costo de su momento.
  const oldConfig = resolveInstallmentsFinancing(MANUAL, "automatic", before).effective
  const oldPricing = financedTotal(oldConfig, [2, 3, 6])
  const snapshot = buildMercadoPagoPricingSnapshot({
    pricing: oldPricing,
    mode: "financed",
    settings: { installmentsFinancing: oldConfig, transferDiscountPercent: 10, nationalTaxesIncidencePercent: 21 },
    economicFingerprint: "fp",
  })
  const frozen = JSON.stringify(snapshot)
  resolveInstallmentsFinancing(MANUAL, "automatic", after)
  assert.equal(JSON.stringify(snapshot), frozen)
  assert.equal(snapshot.installmentsFinancing.surchargePercentByCount[6], withoutIva(24.2))
})

// ─── 1 pago / precio financiado ───

test("1 pago es siempre precio contado (también con crédito); el financiado cubre el peor costo del rango", () => {
  const pricing = financedTotal(MANUAL, [2, 3, 6])
  const cash = getMercadoPagoModeQuote(pricing, "cash")!
  assert.equal(cash.externalAmountDue, pricing.cashTotal)
  assert.equal(cash.preferenceMaxInstallments, 1)
  // Hasta 6: precio con el costo de 6, aunque el cliente elija 2 o 3.
  assert.equal(pricing.offeredInstallmentCount, 6)
  assert.ok(pricing.financedTotal! > financedTotal(MANUAL, [2, 3]).financedTotal!)
  // Nunca más de 6: Mercado Pago no puede abrir 9/12/18 en la preferencia.
  assert.equal(pricing.financed?.preferenceMaxInstallments, 6)
})

// ─── Política: ON/OFF, mínimos y total final ───

const policy = (enabled: boolean, three: number | null, six: number | null): InterestFreePolicy => ({
  enabled,
  minimumAmountByCount: { 3: three, 6: six },
})

test("OFF desactiva las cuotas sin interés para cualquier total", () => {
  assert.deepEqual(applyInterestFreePolicy([2, 3, 6], 500_000, policy(false, null, null)), [])
  const route = readFileSync(new URL("../../app/api/mercadopago/installments/route.ts", import.meta.url), "utf8")
  assert.match(route, /if \(!interestFreePolicy\.enabled\) return \[String\(amount\), \[\]\] as const/)
  const preference = readFileSync(new URL("../../app/api/mercadopago/create-preference/route.ts", import.meta.url), "utf8")
  assert.match(preference, /mode === "financed" && interestFreePolicy\.enabled/)
  assert.match(preference, /applyInterestFreePolicy\(result\.counts, amount, interestFreePolicy\)/)
})

test("el total final manda: $20.000 sin cuotas, $40.000 hasta 3, $95.000 hasta 6 (según lo que confirme Mercado Pago)", () => {
  const mercadoPago = (amount: number): InstallmentCount[] => (amount >= 60_000 ? [2, 3, 6] : amount >= 35_000 ? [2, 3] : [])
  const own = DEFAULT_INTEREST_FREE_POLICY
  assert.deepEqual(applyInterestFreePolicy(mercadoPago(20_000), 20_000, own), [])
  assert.deepEqual(applyInterestFreePolicy(mercadoPago(40_000), 40_000, own), [2, 3])
  assert.deepEqual(applyInterestFreePolicy(mercadoPago(95_000), 95_000, own), [2, 3, 6])

  // Mínimos BEYONIX más restrictivos: 3 desde $50.000 y 6 desde $80.000.
  const strict = policy(true, 50_000, 80_000)
  assert.deepEqual(applyInterestFreePolicy(mercadoPago(40_000), 40_000, strict), [])
  assert.deepEqual(applyInterestFreePolicy(mercadoPago(70_000), 70_000, strict), [2, 3])
  assert.deepEqual(applyInterestFreePolicy(mercadoPago(95_000), 95_000, strict), [2, 3, 6])
  // Nunca agrega lo que Mercado Pago no confirmó.
  assert.deepEqual(applyInterestFreePolicy([2, 3], 500_000, strict), [2, 3])
})

test("mínimo BEYONIX >= referencia de Mercado Pago (y 6 >= 3); sin referencia no se inventa", () => {
  const reference = {
    checkedAt: NOW.toISOString(),
    minimumAmountByCount: { 3: 35_000, 6: 60_000 },
    minimumAmountForTwo: 35_000,
    brandsByCount: {},
    maxProbedAmount: 2_000_000,
  }
  assert.equal(validateInterestFreePolicy(policy(true, 50_000, 80_000), reference), null)
  assert.match(validateInterestFreePolicy(policy(true, 20_000, null), reference) ?? "", /3 cuotas .* no puede ser menor que la referencia de Mercado Pago/)
  assert.match(validateInterestFreePolicy(policy(true, null, 59_000), reference) ?? "", /6 cuotas/)
  assert.match(validateInterestFreePolicy(policy(true, 90_000, 80_000), reference) ?? "", /6 cuotas no puede ser menor que el mínimo para 3/)
  assert.equal(validateInterestFreePolicy(policy(true, 20_000, null), null), null)
  // El servidor repite la validación al guardar.
  const settingsRoute = readFileSync(new URL("../../app/api/admin/settings/route.ts", import.meta.url), "utf8")
  assert.match(settingsRoute, /validateInterestFreePolicy\(/)
  assert.match(settingsRoute, /await getMercadoPagoInterestFreeReference\(\)/)
})

test("política guardada: valores inválidos se normalizan sin romper el comportamiento actual", () => {
  assert.deepEqual(normalizeInterestFreePolicy(undefined), DEFAULT_INTEREST_FREE_POLICY)
  assert.deepEqual(normalizeInterestFreePolicy({ enabled: "no", minimumAmountByCount: { 3: "abc", 6: 0 } }), DEFAULT_INTEREST_FREE_POLICY)
})

// ─── Referencia observada de Mercado Pago ───

type ProbeLookupResult = { status: "confirmed"; counts: InstallmentCount[]; brandsByCount: Partial<Record<InstallmentCount, Array<"visa" | "master">>> }

/** Mercado Pago simulado con umbrales arbitrarios (nunca los mismos que el negocio "espera"). */
function fakeMercadoPago(thresholds: Partial<Record<InstallmentCount, number>>) {
  const lookups: number[] = []
  const lookup = async (amount: number): Promise<ProbeLookupResult> => {
    lookups.push(amount)
    const counts = ([2, 3, 6] as const).filter((count) => thresholds[count] !== undefined && amount >= thresholds[count]!)
    return { status: "confirmed", counts, brandsByCount: Object.fromEntries(counts.map((count) => [count, ["visa", "master"]])) }
  }
  return { lookup, lookups }
}

test("la referencia busca cada cuota por separado: 3 busca 3 y 6 busca 6 (sin hardcodear umbrales)", async () => {
  for (const thresholds of [
    { 2: 21_000, 3: 47_000, 6: 83_000 },
    { 2: 12_000, 3: 12_000, 6: 1_340_000 },
  ]) {
    const { lookup, lookups } = fakeMercadoPago(thresholds)
    const reference = await probeMercadoPagoInterestFreeReference(lookup, NOW)
    assert.deepEqual(reference?.minimumAmountByCount, { 3: thresholds[3], 6: thresholds[6] })
    assert.equal(reference?.minimumAmountForTwo, thresholds[2])
    assert.deepEqual(reference?.brandsByCount[6], ["visa", "master"])
    assert.equal(reference?.checkedAt, NOW.toISOString())
    assert.ok(new Set(lookups).size <= 60, `búsqueda acotada (${new Set(lookups).size} montos)`)
  }
})

test("2 no implica 3: si Mercado Pago sólo confirma 2 (caso real de la cuenta hoy), 3 y 6 quedan sin referencia", async () => {
  const { lookup } = fakeMercadoPago({ 2: 35_000 })
  const reference = await probeMercadoPagoInterestFreeReference(lookup, NOW)
  assert.equal(reference?.minimumAmountForTwo, 35_000)
  assert.deepEqual(reference?.minimumAmountByCount, { 3: null, 6: null })
  // Y con 2 confirmada, 3 no se da por buena: la búsqueda de 3 no se detiene en 2.
  assert.deepEqual(await probeInterestFreeMinimum(3, lookup), { status: "ok", minimum: null, brands: [] })
})

test("la referencia nunca se inventa: sin respuesta confiable de Mercado Pago no hay referencia", async () => {
  assert.equal(await probeMercadoPagoInterestFreeReference(async () => ({ status: "unavailable" })), null)
  const source = readFileSync(new URL("./interest-free-reference.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /\b(35[._]?000|60[._]?000)\b/, "sin umbrales de negocio en el código")
})