import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  createCheckoutEconomicFingerprint,
  createMercadoPagoCheckoutFingerprint,
  getMercadoPagoCheckoutAttemptDecision,
  getMercadoPagoReservationPreferenceExpiration,
  getPendingCustomerCheckoutOrderAction,
  getStaleMercadoPagoAttemptAction,
  isEconomicallyEquivalentAttempt,
  isMercadoPagoOrderFromReservationSession,
} from "./checkout-attempt.ts"
import {
  MERCADOPAGO_SUPERSEDED_PAYMENT_STATUS,
  supersedeStaleMercadoPagoOrder,
  type SupersedableMercadoPagoOrder,
  type SupersedeMercadoPagoOrderDependencies,
} from "./checkout-supersede.ts"
import {
  buildCheckoutEconomicState,
  buildMercadoPagoPricingSnapshot,
  calculateMercadoPagoCheckoutPricing,
  getMercadoPagoModeQuote,
  getMercadoPagoPreferencePaymentMethods,
  type CheckoutPricingLine,
  type CheckoutPricingSettings,
  type MercadoPagoCheckoutMode,
} from "../pricing/checkout-pricing.ts"
import { computeCustomerCheckoutFingerprint } from "../orders/checkout-order-creation.ts"

// Bug real reproducido: TRIPODE a ~$46.000, intento "en cuotas" creado por
// ~$72.914, el cliente sale de Mercado Pago sin pagar, Admin baja el precio a
// $1.000, el checkout muestra ~$9.000 y al presionar Pagar Mercado Pago volvía
// a recibir el monto viejo. Causa: la orden pendiente se encontraba por
// `customer_checkout_fingerprint` (usuario+carrito+envío, SIN precios) y se
// reutilizaba su init_point / external_amount_due persistidos.

const SETTINGS: CheckoutPricingSettings = {
  installmentsFinancing: {
    baseProcessingPercent: 6.42,
    ivaPercent: 21,
    surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
  },
  transferDiscountPercent: 10,
  nationalTaxesIncidencePercent: 21,
  financedPricePolicy: "cover_costs",
}

interface Scenario {
  unitPrice?: number
  quantity?: number
  variantId?: number | null
  shippingCharged?: number
  shippingType?: string
  mode?: MercadoPagoCheckoutMode
  settings?: CheckoutPricingSettings
  /** Cuotas que Mercado Pago confirma sin interés para el total (la financiación no depende del producto). */
  confirmed?: Array<2 | 3 | 6>
  storeBenefit?: { id: string; percent: number } | null
  requestedCredit?: number
}

function evaluate({
  unitPrice = 46_000,
  quantity = 1,
  variantId = 7,
  shippingCharged = 8_000,
  shippingType = "domicilio",
  mode = "financed",
  settings = SETTINGS,
  confirmed = [2, 3, 6],
  storeBenefit = null,
  requestedCredit = 0,
}: Scenario = {}) {
  const lines: CheckoutPricingLine[] = [
    {
      productId: 101,
      variantId,
      conditionedStockId: null,
      quantity,
      unitPrice,
    },
  ]
  const pricing = calculateMercadoPagoCheckoutPricing({
    lines,
    shippingCharged,
    storeBenefitPercent: storeBenefit?.percent ?? null,
    requestedCustomerCredit: requestedCredit,
    settings,
    interestFreeLookup: () => confirmed,
  })
  const quote = getMercadoPagoModeQuote(pricing, mode)
  assert.ok(quote, "la modalidad pedida tiene que existir para el carrito")
  const economicFingerprint = createCheckoutEconomicFingerprint(
    buildCheckoutEconomicState({
      lines,
      shipping: {
        provider: "andreani",
        type: shippingType,
        sucursalId: null,
        costReal: shippingCharged,
        costCharged: shippingCharged,
        freeShippingApplied: false,
      },
      storeBenefit,
      requestedCustomerCredit: requestedCredit,
      mode,
      pricing,
      settings,
    }),
  )
  const snapshot = buildMercadoPagoPricingSnapshot({
    pricing,
    mode,
    settings,
    economicFingerprint,
  })

  return { lines, pricing, quote, economicFingerprint, snapshot }
}

const CUSTOMER = {
  cliente_nombre: "Martín Núñez",
  cliente_email: "martin@example.com",
}

const TAB_A_SESSION = "session-tab-a-0001"
const TAB_B_SESSION = "session-tab-b-0002"

function mercadoPagoFingerprint(economicFingerprint: string, sessionId = TAB_A_SESSION) {
  return createMercadoPagoCheckoutFingerprint({
    sessionId,
    userId: "user-1",
    customer: CUSTOMER,
    economicFingerprint,
  })
}

/** Orden pendiente tal como quedó persistida por el primer intento. */
function persistedOrder(
  state: ReturnType<typeof evaluate>,
  overrides: Partial<SupersedableMercadoPagoOrder> = {},
): SupersedableMercadoPagoOrder {
  return {
    id: 501,
    estado: "pendiente",
    financial_status: "pending_payment",
    payment_status: "preference_created",
    payment_method_id: "mercadopago",
    total: state.quote!.total,
    external_amount_due: state.quote!.externalAmountDue,
    credit_balance_used: 0,
    mercadopago_checkout_fingerprint: mercadoPagoFingerprint(state.economicFingerprint),
    mercadopago_init_point: "https://mercadopago.example/checkout/viejo",
    mercadopago_preference_id: "pref-viejo",
    mercadopago_preference_expires_at: "2026-09-23T15:30:00.000Z",
    mercadopago_preference_claimed_at: null,
    mercadopago_reservation_session_id: TAB_A_SESSION,
    store_benefit_id: null,
    pricing_snapshot: state.snapshot,
    ...overrides,
  }
}

const NOW = new Date("2026-09-23T15:10:00.000Z")

// ── Fake mínimo del cliente Supabase: registra cada operación ──
interface RecordedOperation {
  table: string
  kind: string
  payload?: unknown
  filters: Array<[string, ...unknown[]]>
}

function createFakeAdmin({ updateMatches = true } = {}) {
  const operations: RecordedOperation[] = []
  const rpcCalls: Array<{ name: string; args: unknown }> = []

  function builder(table: string) {
    const operation: RecordedOperation = { table, kind: "select", filters: [] }
    operations.push(operation)
    const result = () =>
      operation.table === "ordenes" && operation.kind === "update"
        ? { data: updateMatches ? { id: 501 } : null, error: null }
        : { data: null, error: null }
    const chain: Record<string, unknown> = {}
    for (const method of ["eq", "in", "is", "or", "neq", "lte", "gte", "not"]) {
      chain[method] = (...args: unknown[]) => {
        operation.filters.push([method, ...args])
        return chain
      }
    }
    chain.update = (payload: unknown) => {
      operation.kind = "update"
      operation.payload = payload
      return chain
    }
    chain.insert = (payload: unknown) => {
      operation.kind = "insert"
      operation.payload = payload
      return chain
    }
    chain.select = () => chain
    chain.maybeSingle = () => Promise.resolve(result())
    chain.then = (resolve: (value: unknown) => unknown) => resolve(result())
    return chain
  }

  return {
    operations,
    rpcCalls,
    client: {
      from: builder,
      rpc: (name: string, args: unknown) => {
        rpcCalls.push({ name, args })
        return Promise.resolve({ data: [{ movement_id: null, restored_amount: 0 }], error: null })
      },
    } as never,
  }
}

function createDependencies({
  payment = null,
  expireFails = false,
}: { payment?: { status: string } | null; expireFails?: boolean } = {}) {
  const expiredPreferences: string[] = []
  const dependencies: SupersedeMercadoPagoOrderDependencies = {
    expirePreference: async (preferenceId) => {
      if (expireFails) throw new Error("MP no disponible")
      expiredPreferences.push(preferenceId)
    },
    findPayment: async () => payment,
  }
  return { dependencies, expiredPreferences }
}

// ─────────────────────────────────────────────────────────────
// 1-5. Reproducción del bug real
// ─────────────────────────────────────────────────────────────

test("1-5. preference inicial a $46.000 financiado; Admin baja a $1.000 -> Pagar NO reutiliza la orden vieja y la nueva usa el precio actual", async () => {
  const initial = evaluate({ unitPrice: 46_000, mode: "financed" })
  assert.ok(initial.quote.externalAmountDue > 46_000 + 8_000, "el financiado inicial es el monto alto")

  const oldOrder = persistedOrder(initial)

  // Admin cambia el precio: el servidor recalcula con datos actuales.
  const afterPriceChange = evaluate({ unitPrice: 1_000, mode: "financed" })
  assert.notEqual(afterPriceChange.economicFingerprint, initial.economicFingerprint)

  // La identidad de la compra (usuario+carrito+envío) NO cambia: por eso el
  // índice único la encontraba y se reutilizaba. Ahora eso ya no alcanza.
  const customerFingerprint = (state: ReturnType<typeof evaluate>) =>
    computeCustomerCheckoutFingerprint({
      userId: "user-1",
      items: state.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        variantId: line.variantId,
        conditionedStockId: line.conditionedStockId,
      })),
      shipping: { provider: "andreani", type: "domicilio", sucursalId: null },
      storeBenefitId: null,
    })
  assert.equal(customerFingerprint(initial), customerFingerprint(afterPriceChange))

  // La orden vieja tiene preferencia VIVA (antes -> "reuse" del init_point viejo).
  assert.equal(getMercadoPagoCheckoutAttemptDecision(oldOrder, NOW).kind, "reuse")
  assert.equal(
    getPendingCustomerCheckoutOrderAction(oldOrder, afterPriceChange.economicFingerprint, TAB_A_SESSION),
    "supersede_stale",
  )
  assert.equal(isEconomicallyEquivalentAttempt(oldOrder, afterPriceChange.economicFingerprint), false)

  // Baja segura: vence la preferencia vieja en MP y cancela la orden.
  const admin = createFakeAdmin()
  const { dependencies, expiredPreferences } = createDependencies()
  const result = await supersedeStaleMercadoPagoOrder(admin.client, oldOrder, {
    dependencies,
    currentEconomicFingerprint: afterPriceChange.economicFingerprint,
    now: NOW,
  })
  assert.equal(result, "superseded")
  assert.deepEqual(expiredPreferences, ["pref-viejo"])

  const cancel = admin.operations.find(
    (operation) => operation.table === "ordenes" && operation.kind === "update",
  )
  assert.ok(cancel)
  assert.equal((cancel.payload as { estado: string }).estado, "cancelado")
  assert.equal(
    (cancel.payload as { payment_status: string }).payment_status,
    MERCADOPAGO_SUPERSEDED_PAYMENT_STATUS,
  )
  assert.equal((cancel.payload as { mercadopago_init_point: null }).mercadopago_init_point, null)

  // La nueva orden/preferencia se arma con el total ACTUAL.
  const financedNow = afterPriceChange.quote
  assert.ok(financedNow.externalAmountDue < 10_000, `nuevo total ${financedNow.externalAmountDue}`)
  assert.equal(afterPriceChange.snapshot.externalAmountDue, financedNow.externalAmountDue)
  assert.notEqual(financedNow.externalAmountDue, oldOrder.external_amount_due)
})

// ─────────────────────────────────────────────────────────────
// 6-10. Cada cambio económico invalida el intento previo
// ─────────────────────────────────────────────────────────────

test("6. cambia el envío -> huella distinta (se recalcula)", () => {
  const base = evaluate()
  assert.notEqual(evaluate({ shippingCharged: 9_500 }).economicFingerprint, base.economicFingerprint)
  assert.notEqual(evaluate({ shippingType: "sucursal" }).economicFingerprint, base.economicFingerprint)
})

test("7. cambia el % de transferencia -> huella distinta (snapshot recalculado)", () => {
  const base = evaluate({ mode: "cash" })
  const changed = evaluate({
    mode: "cash",
    settings: { ...SETTINGS, transferDiscountPercent: 15 },
  })
  assert.notEqual(changed.economicFingerprint, base.economicFingerprint)
  assert.notEqual(changed.snapshot.transferPriceTotal, base.snapshot.transferPriceTotal)
})

test("8. cambia el fee de Mercado Pago -> huella y total financiado distintos", () => {
  const base = evaluate()
  const changed = evaluate({
    settings: {
      ...SETTINGS,
      installmentsFinancing: {
        ...SETTINGS.installmentsFinancing,
        surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 22.5 },
      },
    },
  })
  assert.notEqual(changed.economicFingerprint, base.economicFingerprint)
  assert.ok(changed.quote.total > base.quote.total)

  // IVA configurado también forma parte del estado económico.
  const ivaChanged = evaluate({
    settings: {
      ...SETTINGS,
      installmentsFinancing: { ...SETTINGS.installmentsFinancing, ivaPercent: 10.5 },
    },
  })
  assert.notEqual(ivaChanged.economicFingerprint, base.economicFingerprint)
})

test("9. Mercado Pago confirma otro máximo -> huella distinta y otro tope para la preferencia", () => {
  const base = evaluate()
  const upToThree = evaluate({ confirmed: [2, 3] })
  assert.notEqual(upToThree.economicFingerprint, base.economicFingerprint)
  assert.equal(base.quote.preferenceMaxInstallments, 6)
  assert.equal(upToThree.quote.preferenceMaxInstallments, 3)
})

test("10. contado <-> cuotas son intentos distintos, con totales distintos", () => {
  const cash = evaluate({ mode: "cash" })
  const financed = evaluate({ mode: "financed" })
  assert.notEqual(cash.economicFingerprint, financed.economicFingerprint)
  assert.notEqual(
    mercadoPagoFingerprint(cash.economicFingerprint),
    mercadoPagoFingerprint(financed.economicFingerprint),
  )
  assert.notEqual(cash.quote.externalAmountDue, financed.quote.externalAmountDue)
})

test("cantidad, variante, beneficio y saldo pedido también invalidan el intento previo", () => {
  const base = evaluate()
  assert.notEqual(evaluate({ quantity: 2 }).economicFingerprint, base.economicFingerprint)
  assert.notEqual(evaluate({ variantId: 8 }).economicFingerprint, base.economicFingerprint)
  assert.notEqual(
    evaluate({ storeBenefit: { id: "b-1", percent: 10 } }).economicFingerprint,
    base.economicFingerprint,
  )
  assert.notEqual(evaluate({ requestedCredit: 2_000 }).economicFingerprint, base.economicFingerprint)
})

// ─────────────────────────────────────────────────────────────
// 11-14. Contado vs cuotas en la preferencia
// ─────────────────────────────────────────────────────────────

const CREDIT_EXCLUSIONS = [{ id: "debit_card" }, { id: "prepaid_card" }, { id: "ticket" }, { id: "atm" }]

test("A. preferencia en 1 pago (precio contado) -> 1 pago con cualquier medio (crédito incluido), sin medios diferidos", () => {
  const cash = evaluate({ mode: "cash" })
  assert.equal(cash.snapshot.mercadoPagoModality, "mercadopago_cash")
  assert.deepEqual(
    getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: cash.snapshot }),
    {
      installments: 1,
      default_installments: 1,
      excluded_payment_types: [{ id: "ticket" }, { id: "atm" }],
    },
  )
  assert.equal(cash.snapshot.cftea, null, "al contado nunca hay CFTEA")
})

test("B. preferencia crédito -> máximo que confirma Mercado Pago para el total, sólo tarjeta de crédito", () => {
  const financed = evaluate({ mode: "financed" })
  assert.equal(financed.snapshot.mercadoPagoModality, "mercadopago_financed")
  assert.deepEqual(
    getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: financed.snapshot }),
    { installments: 6, excluded_payment_types: CREDIT_EXCLUSIONS },
  )

  const upToThree = evaluate({ mode: "financed", confirmed: [2, 3] })
  assert.deepEqual(
    getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: upToThree.snapshot }),
    { installments: 3, excluded_payment_types: CREDIT_EXCLUSIONS },
  )

  // Sin tope válido: crédito en 1 pago, nunca más cuotas de las calculadas.
  assert.deepEqual(
    getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: { mercadoPagoModality: "mercadopago_financed", preferenceMaxInstallments: 12 } }),
    { installments: 1, default_installments: 1, excluded_payment_types: CREDIT_EXCLUSIONS },
  )
})

test("B. ninguna preferencia intenta excluir dinero en cuenta (Mercado Pago no lo permite)", () => {
  for (const snapshot of [
    { mercadoPagoModality: "mercadopago_cash" },
    { mercadoPagoModality: "mercadopago_financed", preferenceMaxInstallments: 6 },
    { mercadoPagoModality: "mercadopago_financed", preferenceMaxInstallments: null },
  ]) {
    const methods = getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: snapshot })
    const excluded = (methods.excluded_payment_types ?? []).map((type) => type.id as string)
    assert.equal(excluded.includes("account_money"), false, JSON.stringify(snapshot))
    assert.equal("excluded_payment_methods" in methods, false, "no se excluyen marcas puntuales")
  }
})

test("13. la preferencia al contado nunca usa el total financiado", () => {
  const cash = evaluate({ mode: "cash", unitPrice: 47_900, shippingCharged: 8_000 })
  assert.equal(cash.quote.externalAmountDue, 55_900)
  assert.equal(cash.quote.externalAmountDue, cash.pricing.cashTotal)
  assert.notEqual(cash.quote.externalAmountDue, cash.pricing.financed?.externalAmountDue)
})

test("14. la preferencia en cuotas nunca usa el total de contado", () => {
  const financed = evaluate({ mode: "financed", unitPrice: 47_900, shippingCharged: 8_000 })
  assert.ok(financed.quote.externalAmountDue > financed.pricing.cashTotal)
  assert.equal(financed.quote.externalAmountDue, financed.pricing.financed?.externalAmountDue)
  // Total divisible exacto por cada cuota ofrecida.
  for (const plan of financed.pricing.installmentPlans) {
    assert.equal(Math.round(plan.amount * plan.count * 100), Math.round(financed.quote.externalAmountDue * 100))
  }
})

// ─────────────────────────────────────────────────────────────
// 15-21. Idempotencia y seguridad que tienen que seguir intactas
// ─────────────────────────────────────────────────────────────

test("15. reintento sin ningún cambio económico -> reutiliza correctamente", () => {
  const first = evaluate()
  const retry = evaluate()
  assert.equal(retry.economicFingerprint, first.economicFingerprint)
  assert.equal(
    mercadoPagoFingerprint(retry.economicFingerprint),
    mercadoPagoFingerprint(first.economicFingerprint),
  )
  const order = persistedOrder(first)
  assert.equal(getPendingCustomerCheckoutOrderAction(order, retry.economicFingerprint, TAB_A_SESSION), "resume_equivalent")
  assert.equal(getMercadoPagoCheckoutAttemptDecision(order, NOW).kind, "reuse")
})

test("16. reintento con cambio económico -> NO reutiliza", () => {
  const order = persistedOrder(evaluate())
  const changed = evaluate({ unitPrice: 45_999 })
  assert.equal(getPendingCustomerCheckoutOrderAction(order, changed.economicFingerprint, TAB_A_SESSION), "supersede_stale")
})

test("16b. una orden previa a esta versión (sin huella económica) nunca se reutiliza", () => {
  const order = persistedOrder(evaluate(), {
    pricing_snapshot: { economicFingerprint: null },
  })
  assert.equal(getPendingCustomerCheckoutOrderAction(order, evaluate().economicFingerprint, TAB_A_SESSION), "supersede_stale")
})

test("17. la huella sigue impidiendo dos órdenes simultáneas idénticas", () => {
  const a = evaluate()
  const b = evaluate()
  assert.equal(mercadoPagoFingerprint(a.economicFingerprint), mercadoPagoFingerprint(b.economicFingerprint))
})

test("18. otra sesión de checkout (otra reserva del Paso 3) con las mismas condiciones nunca retoma la orden ajena: la reemplaza", () => {
  // Cada sesión tiene su propia reserva de 20 minutos. Retomar la orden de
  // la sesión A desde B juzgaba el pago con el vencimiento de la reserva de A
  // (ya vencida -> "Tu reserva venció" con la reserva de B recién creada) y
  // dejaba la reserva de B huérfana.
  const tabA = evaluate()
  const tabB = evaluate()
  assert.equal(tabA.economicFingerprint, tabB.economicFingerprint)
  assert.notEqual(
    mercadoPagoFingerprint(tabA.economicFingerprint, TAB_A_SESSION),
    mercadoPagoFingerprint(tabB.economicFingerprint, TAB_B_SESSION),
  )
  const order = persistedOrder(tabA)
  assert.equal(getPendingCustomerCheckoutOrderAction(order, tabB.economicFingerprint, TAB_B_SESSION), "supersede_stale")
  // La misma sesión sigue siendo idempotente.
  assert.equal(getPendingCustomerCheckoutOrderAction(order, tabA.economicFingerprint, TAB_A_SESSION), "resume_equivalent")
  // Una orden previa a la columna de sesión tampoco se retoma desde un checkout nuevo.
  const legacy = persistedOrder(tabA, { mercadopago_reservation_session_id: null })
  assert.equal(getPendingCustomerCheckoutOrderAction(legacy, tabB.economicFingerprint, TAB_B_SESSION), "supersede_stale")
})

test("19. un pago aprobado sigue bloqueando: nunca se reemplaza ni se toca la orden", async () => {
  const state = evaluate()
  const paid = persistedOrder(state, {
    estado: "pagado",
    financial_status: "payment_confirmed",
    payment_status: "approved",
  })
  assert.equal(getStaleMercadoPagoAttemptAction(paid, NOW), "already_paid")

  const admin = createFakeAdmin()
  const { dependencies, expiredPreferences } = createDependencies()
  const result = await supersedeStaleMercadoPagoOrder(admin.client, paid, {
    dependencies,
    currentEconomicFingerprint: evaluate({ unitPrice: 1_000 }).economicFingerprint,
    now: NOW,
  })
  assert.equal(result, "already_paid")
  assert.equal(admin.operations.length, 0)
  assert.equal(expiredPreferences.length, 0)

  // Pago aprobado en Mercado Pago que el webhook todavía no procesó.
  const approvedInFlight = await supersedeStaleMercadoPagoOrder(
    createFakeAdmin().client,
    persistedOrder(state),
    {
      dependencies: createDependencies({ payment: { status: "approved" } }).dependencies,
      currentEconomicFingerprint: evaluate({ unitPrice: 1_000 }).economicFingerprint,
      now: NOW,
    },
  )
  assert.equal(approvedInFlight, "already_paid")
})

test("20. rechazado/cancelado sigue permitiendo reclamar (mismas condiciones) o reemplazar (condiciones nuevas)", async () => {
  const state = evaluate()
  for (const paymentStatus of ["rejected", "cancelled"]) {
    const order = persistedOrder(state, {
      payment_status: paymentStatus,
      mercadopago_init_point: null,
      mercadopago_preference_expires_at: null,
    })
    assert.equal(getMercadoPagoCheckoutAttemptDecision(order, NOW).kind, "claim_preference")
    assert.equal(getStaleMercadoPagoAttemptAction(order, NOW), "supersede")

    const result = await supersedeStaleMercadoPagoOrder(createFakeAdmin().client, order, {
      dependencies: createDependencies({ payment: { status: paymentStatus } }).dependencies,
      currentEconomicFingerprint: evaluate({ unitPrice: 1_000 }).economicFingerprint,
      now: NOW,
    })
    assert.equal(result, "superseded")
  }
})

test("21. el snapshot histórico no cambia después y la baja nunca reescribe montos", async () => {
  const initial = evaluate({ unitPrice: 46_000 })
  const frozen = JSON.stringify(initial.snapshot)
  evaluate({ unitPrice: 1_000 })
  assert.equal(JSON.stringify(initial.snapshot), frozen)

  const admin = createFakeAdmin()
  await supersedeStaleMercadoPagoOrder(admin.client, persistedOrder(initial), {
    dependencies: createDependencies().dependencies,
    currentEconomicFingerprint: evaluate({ unitPrice: 1_000 }).economicFingerprint,
    now: NOW,
  })
  const cancel = admin.operations.find(
    (operation) => operation.table === "ordenes" && operation.kind === "update",
  )
  const keys = Object.keys(cancel?.payload as object)
  for (const forbidden of ["total", "original_total", "external_amount_due", "pricing_snapshot", "shipping_cost_charged"]) {
    assert.ok(!keys.includes(forbidden), `la baja no debe tocar ${forbidden}`)
  }
})

// ─────────────────────────────────────────────────────────────
// Concurrencia
// ─────────────────────────────────────────────────────────────

test("concurrencia: pago en proceso, claim vigente, fallo al vencer la preferencia o carrera perdida -> nunca se cancela", async () => {
  const state = evaluate()
  const current = evaluate({ unitPrice: 1_000 }).economicFingerprint

  const inProcess = await supersedeStaleMercadoPagoOrder(createFakeAdmin().client, persistedOrder(state), {
    dependencies: createDependencies({ payment: { status: "in_process" } }).dependencies,
    currentEconomicFingerprint: current,
    now: NOW,
  })
  assert.equal(inProcess, "payment_in_process")

  const claimed = persistedOrder(state, {
    mercadopago_init_point: null,
    mercadopago_preference_expires_at: null,
    mercadopago_preference_claimed_at: new Date(NOW.getTime() - 60_000).toISOString(),
  })
  assert.equal(getStaleMercadoPagoAttemptAction(claimed, NOW), "busy")

  const expireFailedAdmin = createFakeAdmin()
  const expireFailed = await supersedeStaleMercadoPagoOrder(expireFailedAdmin.client, persistedOrder(state), {
    dependencies: createDependencies({ expireFails: true }).dependencies,
    currentEconomicFingerprint: current,
    now: NOW,
  })
  assert.equal(expireFailed, "busy")
  assert.equal(expireFailedAdmin.operations.length, 0, "si el link viejo puede seguir cobrando, no se cancela")

  const raceLost = await supersedeStaleMercadoPagoOrder(
    createFakeAdmin({ updateMatches: false }).client,
    persistedOrder(state),
    { dependencies: createDependencies().dependencies, currentEconomicFingerprint: current, now: NOW },
  )
  assert.equal(raceLost, "busy")
})

test("concurrencia: el UPDATE de baja es condicional (sigue pendiente, sin pago, sin claim vigente)", async () => {
  const admin = createFakeAdmin()
  await supersedeStaleMercadoPagoOrder(admin.client, persistedOrder(evaluate()), {
    dependencies: createDependencies().dependencies,
    currentEconomicFingerprint: evaluate({ unitPrice: 1_000 }).economicFingerprint,
    now: NOW,
  })
  const cancel = admin.operations.find(
    (operation) => operation.table === "ordenes" && operation.kind === "update",
  )
  const filters = JSON.stringify(cancel?.filters)
  assert.match(filters, /\["eq","estado","pendiente"\]/)
  assert.match(filters, /\["eq","financial_status","pending_payment"\]/)
  assert.match(filters, /\["in","payment_status",\[/)
  assert.match(filters, /mercadopago_preference_claimed_at\.is\.null/)
})

test("la baja devuelve saldo y beneficio de la orden reemplazada para que la misma compra continúe", async () => {
  const admin = createFakeAdmin()
  const order = persistedOrder(evaluate(), {
    credit_balance_used: 3_000,
    store_benefit_id: "benefit-1",
  })
  await supersedeStaleMercadoPagoOrder(admin.client, order, {
    dependencies: createDependencies().dependencies,
    currentEconomicFingerprint: evaluate({ unitPrice: 1_000 }).economicFingerprint,
    now: NOW,
  })

  assert.deepEqual(admin.rpcCalls.map((call) => call.name), ["reverse_customer_credit_for_order"])
  const benefitRestore = admin.operations.find(
    (operation) => operation.table === "customer_store_benefits" && operation.kind === "update",
  )
  assert.ok(benefitRestore)
  assert.match(JSON.stringify(benefitRestore.filters), /\["eq","used_order_id",501\]/)
  assert.ok(
    admin.operations.some(
      (operation) => operation.table === "order_audit_events" && operation.kind === "insert",
    ),
  )
})

test("órdenes previas al modelo contado/cuotas conservan su tope de cuotas al renovar la preferencia (sin exclusiones)", () => {
  assert.deepEqual(getMercadoPagoPreferencePaymentMethods({ installments_count: 3 }), {
    installments: 3,
    default_installments: 3,
  })
  assert.deepEqual(getMercadoPagoPreferencePaymentMethods({ installments_count: null }), {
    installments: 1,
    default_installments: 1,
  })
})

// ─────────────────────────────────────────────────────────────
// Reserva del Paso 3: "Tu reserva venció" con una reserva vigente
// ─────────────────────────────────────────────────────────────
//
// Bug real: un intento en cuotas anterior (sesión A) quedó `pendiente` con su
// reserva de 20 minutos ya vencida (la expiración automática recién lo cancela
// 24 h después). El cliente vuelve, reserva de nuevo (sesión B, 20 minutos
// nuevos), elige cuotas con las mismas condiciones y presiona Pagar. La orden
// de A se encontraba por `customer_checkout_fingerprint` (sin sesión), era
// económicamente idéntica y se "retomaba": su plazo se leía de la reserva de A
// (`loadMercadoPagoReservationDeadline`), vencida -> RESERVATION_EXPIRED -> el
// checkout mostraba "Tu reserva venció" aunque la reserva de B estaba vigente.

const ROUTE = readFileSync(
  new URL("../../app/api/mercadopago/create-preference/route.ts", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n")

test("política: el checkout envía la versión visible y la preferencia devuelve PRICING_CHANGED si cambió", () => {
  const checkout = readFileSync(new URL("../../app/checkout/page.tsx", import.meta.url), "utf8")
  assert.match(checkout, /expectedFinancedPricePolicy: siteSettings\.financedPricePolicy/)
  assert.match(ROUTE, /payload\.expectedFinancedPricePolicy !== siteSettings\.financedPricePolicy/)
  assert.match(ROUTE, /code: "PRICING_CHANGED"/)
})

function expiredOrderFromPreviousSession(state: ReturnType<typeof evaluate>) {
  return persistedOrder(state, {
    // Preferencia y reserva de la sesión A vencidas: ya no se puede reutilizar.
    mercadopago_preference_expires_at: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    mercadopago_reservation_session_id: TAB_A_SESSION,
  })
}

test("reserva: una orden pendiente de otra sesión (reserva vencida) nunca se retoma desde un checkout con reserva vigente", () => {
  const previous = evaluate({ mode: "financed" })
  const current = evaluate({ mode: "financed" })
  const order = expiredOrderFromPreviousSession(previous)
  // Mismas condiciones: antes esto era "resume_equivalent" con el plazo de A.
  assert.ok(isEconomicallyEquivalentAttempt(order, current.economicFingerprint))
  assert.equal(isMercadoPagoOrderFromReservationSession(order, TAB_B_SESSION), false)
  assert.equal(
    getPendingCustomerCheckoutOrderAction(order, current.economicFingerprint, TAB_B_SESSION),
    "supersede_stale",
  )
  // Se da de baja (preferencia vieja vencida, sin claim) y la compra sigue con B.
  assert.equal(getStaleMercadoPagoAttemptAction(order, NOW), "supersede")
})

test("reserva: la baja de la orden de otra sesión queda auditada con su motivo y no cambia el mecanismo de liberación", async () => {
  const admin = createFakeAdmin()
  const result = await supersedeStaleMercadoPagoOrder(
    admin.client,
    expiredOrderFromPreviousSession(evaluate()),
    {
      dependencies: createDependencies().dependencies,
      currentEconomicFingerprint: evaluate().economicFingerprint,
      reason: "reservation_session_replaced",
      now: NOW,
    },
  )
  assert.equal(result, "superseded")
  const cancel = admin.operations.find(
    (operation) => operation.table === "ordenes" && operation.kind === "update",
  )
  // Misma transición que cualquier baja: la cancelación dispara
  // release_order_stock_reservation (sin cambios) sobre la reserva de A.
  assert.equal((cancel?.payload as { estado?: string }).estado, "cancelado")
  assert.equal(
    (cancel?.payload as { payment_status?: string }).payment_status,
    MERCADOPAGO_SUPERSEDED_PAYMENT_STATUS,
  )
  const audit = admin.operations.find(
    (operation) => operation.table === "order_audit_events" && operation.kind === "insert",
  )
  assert.equal(
    (audit?.payload as { metadata?: { reason?: string } }).metadata?.reason,
    "reservation_session_replaced",
  )
})

test("reserva: cambiar entre 1 pago y cuotas en la misma sesión reemplaza el intento, nunca lo trata como reserva vencida", () => {
  const cashOrder = persistedOrder(evaluate({ mode: "cash" }))
  const financedNow = evaluate({ mode: "financed" })
  assert.equal(
    getPendingCustomerCheckoutOrderAction(cashOrder, financedNow.economicFingerprint, TAB_A_SESSION),
    "supersede_stale",
  )
  const financedOrder = persistedOrder(evaluate({ mode: "financed" }))
  const cashNow = evaluate({ mode: "cash" })
  assert.equal(
    getPendingCustomerCheckoutOrderAction(financedOrder, cashNow.economicFingerprint, TAB_A_SESSION),
    "supersede_stale",
  )
  // Elegir modalidad no toca la reserva: el reemplazo pasa por la baja segura,
  // no por loadMercadoPagoReservationDeadline.
  const supersede = ROUTE.slice(ROUTE.indexOf("async function resolvePendingCustomerCheckoutOrder("))
  const supersedeBranch = supersede.slice(supersede.indexOf("const result = await supersedeStaleMercadoPagoOrder("), supersede.indexOf("switch (result)"))
  assert.doesNotMatch(supersedeBranch, /loadMercadoPagoReservationDeadline/)
})

test("reserva: el plazo de una orden sólo se lee si es de la sesión del request (nunca el de otra reserva)", () => {
  const resolver = ROUTE.slice(
    ROUTE.indexOf("async function resolveMercadoPagoOrderAttempt("),
    ROUTE.indexOf("async function releaseMercadoPagoPreferenceClaim("),
  )
  const guard = resolver.indexOf("!isMercadoPagoOrderFromReservationSession(order, reservationSessionId)")
  const deadline = resolver.indexOf("await loadMercadoPagoReservationDeadline(admin, order.id)")
  assert.ok(guard > 0 && deadline > guard, "la sesión se valida antes de leer el plazo")
  // Los tres caminos que retoman una orden pasan la sesión del request.
  assert.equal((ROUTE.match(/economicFingerprint,\s*reservationSessionId: checkoutSessionId,/g) ?? []).length, 3)
  assert.match(ROUTE, /mercadopago_reservation_session_id,/)
})

test("reserva vigente permite crear la preferencia; una realmente vencida (o con menos de 1 minuto) bloquea", () => {
  const vigente = new Date(NOW.getTime() + 12 * 60_000).toISOString()
  assert.equal(
    getMercadoPagoReservationPreferenceExpiration(vigente, NOW)?.toISOString(),
    vigente,
    "la preferencia hereda el vencimiento de la reserva, sin renovarlo",
  )
  assert.equal(getMercadoPagoReservationPreferenceExpiration(new Date(NOW.getTime() - 1_000).toISOString(), NOW), null)
  assert.equal(getMercadoPagoReservationPreferenceExpiration(new Date(NOW.getTime() + 30_000).toISOString(), NOW), null)
  // El servidor sigue respondiendo RESERVATION_EXPIRED cuando la reserva propia vence.
  assert.match(ROUTE, /if \(!expiresAt\) throw new CheckoutReservationExpiredError\(\)/)
  assert.match(ROUTE, /error instanceof CheckoutReservationExpiredError\) \{\s*return NextResponse\.json\(\s*\{ code: "RESERVATION_EXPIRED"/)
  const commit = readFileSync(
    new URL("../../supabase/migrations/20260925130000_mercadopago_checkout_reservation_commit.sql", import.meta.url),
    "utf8",
  )
  assert.match(commit, /if v_session\.expires_at <= v_now \+ interval '60 seconds' then\s*raise exception 'RESERVATION_EXPIRED';/)
})

test("reserva: cuotas sin cantidad preseleccionada se aceptan; una cantidad no confirmada sigue rechazándose (409)", () => {
  assert.match(
    ROUTE,
    /mode === "financed" &&\s*\(!quote \|\|\s*\(selectedInstallmentCount != null &&\s*!pricing\.interestFreeInstallmentCounts\.includes\(selectedInstallmentCount\)\)\)/,
  )
  // La preferencia en cuotas abre hasta el tier, sin preseleccionar cantidad.
  const financed = evaluate({ mode: "financed" })
  const snapshot = buildMercadoPagoPricingSnapshot({
    pricing: financed.pricing,
    mode: "financed",
    settings: SETTINGS,
    economicFingerprint: financed.economicFingerprint,
    selectedInstallmentCount: null,
  })
  const methods = getMercadoPagoPreferencePaymentMethods({ pricing_snapshot: snapshot })
  assert.equal(methods.installments, 6)
  assert.equal(methods.default_installments, undefined)
})
