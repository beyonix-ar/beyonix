import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  deriveMercadoPagoObservedCosts,
  normalizeMercadoPagoCostsMode,
  resolveInstallmentsFinancing,
  type MercadoPagoObservationSourceRow,
} from "./observed-costs.ts"
import {
  normalizeSiteSettingsPatch,
  normalizeStoredInstallmentsFinancingSettings,
} from "../site-settings.ts"

const NOW = new Date("2026-10-01T12:00:00.000Z")
const MANUAL = {
  baseProcessingPercent: 3.46,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}

function payment(
  id: number,
  paidAt: string,
  snapshot: NonNullable<MercadoPagoObservationSourceRow["mercadopago_payment_snapshot"]>,
): MercadoPagoObservationSourceRow {
  return { id, paid_at: paidAt, mercadopago_payment_snapshot: snapshot }
}

// Pago real de la orden #18 (30/09): $100, dinero en cuenta, fee $4,19.
const REAL_ACCOUNT_MONEY = payment(18, "2026-09-30T20:48:46.000Z", {
  installments: 1,
  transaction_amount: 100,
  fee_details: [{ type: "mercadopago_fee", amount: 4.19 }],
  payment_type_id: "account_money",
})

test("pago real con dinero en cuenta: queda como referencia y NO define la comisión base (que es de crédito)", () => {
  const observed = deriveMercadoPagoObservedCosts([REAL_ACCOUNT_MONEY], NOW)
  assert.equal(observed.singlePaymentByType.account_money?.percentWithIva, 4.19)
  assert.equal(observed.singlePaymentByType.account_money?.orderId, 18)
  assert.equal(observed.base, null)
  assert.equal(observed.analyzedPayments, 1)
  const { effective, sources } = resolveInstallmentsFinancing(MANUAL, "automatic", observed)
  assert.equal(effective.baseProcessingPercent, 3.46)
  assert.equal(sources.base, "manual", "sin crédito en 1 pago observado, usa el respaldo manual")
})

test("no mezcla medios: débito y dinero en cuenta nunca alimentan la base; cuotas sólo de crédito", () => {
  const rows = [
    payment(40, "2026-09-30T10:00:00.000Z", { installments: 1, transaction_amount: 10_000, fee_details: [{ type: "mercadopago_fee", amount: 300 }], payment_type_id: "debit_card" }),
    payment(41, "2026-09-29T10:00:00.000Z", { installments: 1, transaction_amount: 10_000, fee_details: [{ type: "mercadopago_fee", amount: 450 }], payment_type_id: "credit_card" }),
    // Un "pago raro" en cuotas con otro medio no toca el costo de cuotas.
    payment(42, "2026-09-30T11:00:00.000Z", { installments: 3, transaction_amount: 10_000, fee_details: [{ type: "financing_fee", amount: 5_000 }], payment_type_id: "debit_card" }),
  ]
  const observed = deriveMercadoPagoObservedCosts(rows, NOW)
  assert.equal(observed.base?.orderId, 41, "la base es la de crédito aunque el débito sea más nuevo")
  assert.equal(observed.base?.percentWithIva, 4.5)
  assert.equal(observed.singlePaymentByType.debit_card?.percentWithIva, 3)
  assert.equal(observed.surchargeByCount[3], null)
})

test("usa la tasa exacta de charges_details si está y registra los días de liberación", () => {
  const observed = deriveMercadoPagoObservedCosts(
    [
      payment(50, "2026-09-30T20:48:46.000Z", {
        installments: 1,
        transaction_amount: 100,
        fee_details: [{ type: "mercadopago_fee", amount: 4.19 }],
        charges_details: [{ name: "mercadopago_fee", rate: 4.18774 }],
        money_release_date: "2026-10-18T20:48:46.000Z",
        payment_type_id: "credit_card",
        payment_method_id: "visa",
      }),
    ],
    NOW,
  )
  assert.equal(observed.base?.percentWithIva, 4.188)
  assert.equal(observed.base?.releaseDays, 18)
  assert.equal(observed.base?.paymentMethodId, "visa")
  assert.equal(resolveInstallmentsFinancing(MANUAL, "automatic", observed).effective.baseProcessingPercent, 3.46)
})

test("la base prefiere la última tarjeta de crédito aunque haya pagos más nuevos con otro medio", () => {
  const credit = payment(10, "2026-09-20T10:00:00.000Z", {
    installments: 1,
    transaction_amount: 50_000,
    fee_details: [{ type: "mercadopago_fee", amount: 2_500 }],
    payment_type_id: "credit_card",
  })
  const observed = deriveMercadoPagoObservedCosts([REAL_ACCOUNT_MONEY, credit], NOW)
  assert.equal(observed.base?.orderId, 10)
  assert.equal(observed.base?.percentWithIva, 5)
})

test("descarta pagos chicos, futuros, sin costo, sin medio o con tasas imposibles", () => {
  const rows = [
    // Sin medio de pago: no se puede saber de qué modalidad es.
    payment(1, "2026-05-01T00:00:00.000Z", { installments: 1, transaction_amount: 10_000, fee_details: [{ type: "mercadopago_fee", amount: 400 }] }),
    payment(2, "2026-09-30T00:00:00.000Z", { installments: 1, transaction_amount: 50, fee_details: [{ type: "mercadopago_fee", amount: 2 }] }),
    payment(3, "2026-10-05T00:00:00.000Z", { installments: 1, transaction_amount: 10_000, fee_details: [{ type: "mercadopago_fee", amount: 400 }] }),
    payment(4, "2026-09-30T00:00:00.000Z", { installments: 1, transaction_amount: 10_000, fee_details: null }),
    payment(5, "2026-09-30T00:00:00.000Z", { installments: 1, transaction_amount: 10_000, fee_details: [{ type: "mercadopago_fee", amount: 9_000 }], payment_type_id: "credit_card" }),
    { id: 6, paid_at: null, mercadopago_payment_snapshot: { installments: 1, transaction_amount: 10_000, fee_details: [] } },
  ]
  const observed = deriveMercadoPagoObservedCosts(rows, NOW)
  assert.equal(observed.base, null)
  assert.equal(observed.analyzedPayments, 2, "pasan fecha/monto el pago sin medio y el de tasa imposible")
  assert.deepEqual(observed.history, [], "nada confiable: ningún costo aprendido")
})

test("costo por cuotas: sólo con cargo de financiación (cuotas sin interés absorbidas)", () => {
  const absorbed = payment(20, "2026-09-29T00:00:00.000Z", {
    installments: 6,
    transaction_amount: 100_000,
    fee_details: [
      { type: "mercadopago_fee", amount: 4_190 },
      { type: "financing_fee", amount: 22_620 },
    ],
    payment_type_id: "credit_card",
  })
  // En cuotas pero financiado por el comprador: no dice nada del costo de BEYONIX.
  const buyerFinanced = payment(21, "2026-09-30T00:00:00.000Z", {
    installments: 3,
    transaction_amount: 100_000,
    fee_details: [{ type: "mercadopago_fee", amount: 4_190 }],
    payment_type_id: "credit_card",
  })
  const observed = deriveMercadoPagoObservedCosts([absorbed, buyerFinanced], NOW)
  assert.equal(observed.surchargeByCount[6]?.percentWithIva, 22.62)
  assert.equal(observed.surchargeByCount[3], null)
  assert.equal(observed.surchargeByCount[2], null)
  assert.equal(observed.base, null, "un pago en cuotas nunca define la base")

  const { effective, sources } = resolveInstallmentsFinancing(MANUAL, "automatic", observed)
  assert.equal(effective.surchargePercentByCount[6], 18.69, "22,62% con IVA = 18,69% sin IVA")
  assert.equal(sources.surchargeByCount[6], "observed")
  assert.equal(effective.surchargePercentByCount[3], 10.49)
  assert.equal(sources.surchargeByCount[3], "manual")
})

test("manual fuerza los valores cargados aunque haya observaciones; automático sin lectura usa el respaldo", () => {
  const observed = deriveMercadoPagoObservedCosts(
    [payment(30, "2026-09-30T00:00:00.000Z", { installments: 1, transaction_amount: 10_000, fee_details: [{ type: "mercadopago_fee", amount: 605 }], payment_type_id: "credit_card" })],
    NOW,
  )
  assert.equal(resolveInstallmentsFinancing(MANUAL, "automatic", observed).effective.baseProcessingPercent, 5)

  const manual = resolveInstallmentsFinancing(MANUAL, "manual", observed)
  assert.deepEqual(manual.effective, MANUAL)
  assert.equal(manual.sources.base, "manual")

  const unavailable = resolveInstallmentsFinancing(MANUAL, "automatic", null)
  assert.deepEqual(unavailable.effective, MANUAL)
})

test("modo guardado: sin modo o inválido = manual (compatibilidad con la configuración existente)", () => {
  assert.equal(normalizeMercadoPagoCostsMode(undefined), "manual")
  assert.equal(normalizeMercadoPagoCostsMode("otro"), "manual")
  assert.equal(normalizeMercadoPagoCostsMode("automatic"), "automatic")
  // Sin política guardada: cuotas sin interés activas y sin mínimos propios (comportamiento previo).
  const DEFAULT_POLICY = { enabled: true, minimumAmountByCount: { 3: null, 6: null } }
  assert.deepEqual(normalizeStoredInstallmentsFinancingSettings(MANUAL), { ...MANUAL, mode: "manual", interestFreePolicy: DEFAULT_POLICY })

  const [change] = normalizeSiteSettingsPatch({ installmentsFinancing: { ...MANUAL, mode: "automatic" } })
  assert.equal(change.key, "installments_financing")
  assert.deepEqual(change.value, { ...MANUAL, mode: "automatic", interestFreePolicy: DEFAULT_POLICY })

  const [withPolicy] = normalizeSiteSettingsPatch({
    installmentsFinancing: { ...MANUAL, mode: "automatic", interestFreePolicy: { enabled: false, minimumAmountByCount: { 3: "50000", 6: -1 } } },
  })
  assert.deepEqual((withPolicy.value as { interestFreePolicy: unknown }).interestFreePolicy, {
    enabled: false,
    minimumAmountByCount: { 3: 50_000, 6: null },
  })
})

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

test("contrato: la configuración pública lleva sólo el costo efectivo; las observaciones son de Admin", () => {
  const siteSettings = readSource("../site-settings.ts")
  assert.match(
    siteSettings,
    /installmentsFinancing: resolveInstallmentsFinancing\(\s*storedFinancing,\s*storedFinancing\.mode,\s*observedCosts,\s*\)\.effective,/,
  )
  // Sólo se leen pagos cuando el modo guardado es automático.
  assert.match(siteSettings, /storedFinancing\.mode === "automatic"\s*\? await loadMercadoPagoObservedCosts\(admin\)\s*: null/)

  const adminRoute = readSource("../../app/api/admin/settings/route.ts")
  assert.match(adminRoute, /getMercadoPagoCostsOverview\(\)/)
  assert.match(adminRoute, /requireInternalUser\(request, \[\.\.\.MANAGE_ROLES\]\)/)
  const publicRoute = readSource("../../app/api/store/settings/route.ts")
  assert.doesNotMatch(publicRoute, /getMercadoPagoCostsOverview|mercadoPagoCosts/)
})

test("UI: Financiación tiene Automático (recomendado) y Manual (emergencia); Configuración sólo deriva", () => {
  const section = readSource("../../app/admin/sections/financiacion/financing-panel.tsx")
  assert.match(section, /role="radiogroup"/)
  assert.match(section, /role="radio"/)
  assert.match(section, /"Recomendado" : "Emergencia"/)
  assert.match(section, /El cálculo deja de seguir los costos observados\./)
  assert.match(
    section,
    /"Estás usando valores manuales\. BEYONIX dejará de usar automáticamente los costos observados hasta volver al modo Automático\."/,
  )
  // El IVA nunca se presenta como observado: Mercado Pago no lo discrimina.
  assert.match(section, /Mercado Pago no lo informa por separado/)

  const container = readSource("../../app/admin/sections/financiacion/admin-financiacion.tsx")
  // Nunca se guardan defaults de costos si no llegó el estado real.
  assert.match(container, /disabled=\{loading \|\| overview === null\}/)
  assert.match(container, /body: JSON\.stringify\(\{ installmentsFinancing \}\)/)

  const page = readSource("../../app/admin/sections/modificaciones/admin-modificaciones.tsx")
  for (const block of ["stock", "shipping", "pricing", "customerCredit"]) {
    assert.match(page, new RegExp(`saveSection\\("${block}", \\{ \\w+ \\}\\)`))
  }
  // Sin controles duplicados: Configuración no edita installmentsFinancing.
  assert.doesNotMatch(page, /installmentsFinancing|MercadoPagoCostsSection/)
  assert.match(page, /<FinancingShortcutCard overview=\{mercadoPagoCosts\} \/>/)
})
