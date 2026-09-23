import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  buildTransferEconomicState,
  calculateTransferCheckoutPricing,
} from "../payments/transfer-checkout.ts"
import { calculateTransferPaymentTotalAfterCustomerCredit } from "../payments/transfer.ts"
import {
  createTransferEconomicFingerprint,
  getPendingTransferCheckoutAction,
  getTransferCheckoutIdempotencyKey,
  isTransferOrderSupersedable,
  supersedeStaleTransferOrder,
  TRANSFER_SUPERSEDED_PAYMENT_STATUS,
  type PendingCheckoutOrderRow,
} from "./transfer-checkout-attempt.ts"

interface Scenario {
  unitPrice?: number
  quantity?: number
  shippingCharged?: number
  shippingType?: string
  transferDiscountPercent?: number
  requestedCredit?: number
  storeBenefit?: { id: string; percent: number } | null
  direccion?: string
}

function evaluate({
  unitPrice = 46_000,
  quantity = 1,
  shippingCharged = 8_000,
  shippingType = "domicilio",
  transferDiscountPercent = 10,
  requestedCredit = 0,
  storeBenefit = null,
  direccion = "Avenida Córdoba 1234",
}: Scenario = {}) {
  const pricing = calculateTransferCheckoutPricing({
    productsTotal: unitPrice * quantity,
    shippingCharged,
    storeBenefitPercent: storeBenefit?.percent ?? null,
    requestedCustomerCredit: requestedCredit,
    transferDiscountPercent,
    nationalTaxesIncidencePercent: 21,
  })
  const economicFingerprint = createTransferEconomicFingerprint(
    buildTransferEconomicState({
      lines: [{ productId: 101, variantId: 7, conditionedStockId: null, quantity, unitPrice }],
      shipping: {
        provider: "andreani",
        type: shippingType,
        sucursalId: null,
        costReal: shippingCharged,
        costCharged: shippingCharged,
        freeShippingApplied: false,
      },
      customer: { cliente_nombre: "Martín Núñez", cliente_direccion: direccion },
      storeBenefit,
      requestedCustomerCredit: requestedCredit,
      pricing,
      nationalTaxesIncidencePercent: 21,
    }),
  )
  return { pricing, economicFingerprint }
}

function pendingTransfer(
  state: ReturnType<typeof evaluate>,
  overrides: Partial<PendingCheckoutOrderRow> = {},
): PendingCheckoutOrderRow {
  return {
    id: 700,
    estado: "pendiente",
    usuario_id: "user-1",
    payment_method_id: "transferencia",
    payment_status: "pendiente_comprobante",
    financial_status: "pending_payment",
    payment_proof_url: null,
    payment_proof_uploaded_at: null,
    transfer_verification_status: null,
    transfer_amount_declared: null,
    total: state.pricing.transferTotal,
    external_amount_due: state.pricing.externalAmountDue,
    credit_balance_used: 0,
    store_benefit_id: null,
    checkout_idempotency_key: "checkout:session-tab-a-0001",
    pricing_snapshot: { economicFingerprint: state.economicFingerprint },
    ...overrides,
  }
}

function createFakeAdmin({ updateMatches = true } = {}) {
  const operations: Array<{ table: string; kind: string; payload?: unknown; filters: unknown[][] }> = []
  const rpcCalls: string[] = []
  const client = {
    from(table: string) {
      const operation = { table, kind: "select", payload: undefined as unknown, filters: [] as unknown[][] }
      operations.push(operation)
      const result = () =>
        table === "ordenes" && operation.kind === "update"
          ? { data: updateMatches ? { id: 700 } : null, error: null }
          : { data: null, error: null }
      const chain: Record<string, unknown> = {}
      for (const method of ["eq", "in", "is", "or", "neq"]) {
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
    },
    rpc(name: string) {
      rpcCalls.push(name)
      return Promise.resolve({ data: [], error: null })
    },
  }
  return { client: client as never, operations, rpcCalls }
}

test("el cálculo extraído usa exactamente las fórmulas de siempre de la ruta", () => {
  const { pricing } = evaluate({ unitPrice: 50_000, shippingCharged: 5_900 })
  const reference = calculateTransferPaymentTotalAfterCustomerCredit({
    productsTotal: 50_000,
    shipping: 5_900,
    customerCreditAmount: 0,
    transferDiscountPercent: 10,
  })
  assert.equal(pricing.transferDiscountAmount, reference.discount)
  assert.equal(pricing.transferTotal, 50_000 + 5_900 - reference.discount)
  assert.equal(pricing.externalAmountDue, pricing.transferTotal)
  assert.equal(pricing.pricingSnapshot.transferPriceTotal, pricing.transferTotal)
  assert.equal(pricing.pricingSnapshot.cashPriceTotal, 55_900)
})

test("1. transferencia con precio viejo -> Admin cambia el precio -> el nuevo intento usa el precio actual", async () => {
  const initial = evaluate({ unitPrice: 46_000 })
  const oldOrder = pendingTransfer(initial)

  const afterPriceChange = evaluate({ unitPrice: 1_000 })
  assert.notEqual(afterPriceChange.economicFingerprint, initial.economicFingerprint)
  assert.equal(getPendingTransferCheckoutAction(oldOrder, afterPriceChange.economicFingerprint), "supersede_stale")

  const admin = createFakeAdmin()
  const result = await supersedeStaleTransferOrder(admin.client, oldOrder, {
    currentEconomicFingerprint: afterPriceChange.economicFingerprint,
  })
  assert.equal(result, "superseded")
  assert.ok(afterPriceChange.pricing.externalAmountDue < 10_000)
  assert.notEqual(afterPriceChange.pricing.externalAmountDue, oldOrder.external_amount_due)
})

test("2. un intento viejo (transferencia o Mercado Pago) no bloquea indefinidamente", async () => {
  const current = evaluate({ unitPrice: 1_000 }).economicFingerprint
  const oldTransfer = pendingTransfer(evaluate())
  assert.equal(isTransferOrderSupersedable(oldTransfer), true)

  const admin = createFakeAdmin()
  assert.equal(
    await supersedeStaleTransferOrder(admin.client, oldTransfer, { currentEconomicFingerprint: current }),
    "superseded",
  )
  const cancel = admin.operations.find((operation) => operation.table === "ordenes" && operation.kind === "update")
  assert.equal((cancel?.payload as { payment_status: string }).payment_status, TRANSFER_SUPERSEDED_PAYMENT_STATUS)
  assert.equal((cancel?.payload as { estado: string }).estado, "cancelado")

  // Un intento de Mercado Pago de la misma compra nunca equivale a una
  // transferencia: se da de baja con el flujo seguro de MP.
  assert.equal(
    getPendingTransferCheckoutAction({ payment_method_id: "mercadopago", pricing_snapshot: null }, current),
    "mercadopago_attempt",
  )

  // Una orden previa a esta versión (sin huella) tampoco bloquea: es obsoleta.
  assert.equal(
    getPendingTransferCheckoutAction(pendingTransfer(evaluate(), { pricing_snapshot: null }), current),
    "supersede_stale",
  )
})

test("3. mismo carrito sin cambios sigue idempotente: se devuelve el mismo pedido", () => {
  const first = evaluate()
  const retry = evaluate()
  assert.equal(retry.economicFingerprint, first.economicFingerprint)
  assert.equal(getPendingTransferCheckoutAction(pendingTransfer(first), retry.economicFingerprint), "resume_equivalent")
})

test("4. doble click no duplica: el INSERT que choca devuelve el pedido idéntico o pide reintentar", () => {
  const route = readFileSync(
    new URL("../../app/api/transferencia/create-order/route.ts", import.meta.url),
    "utf8",
  )
  const conflictStart = route.indexOf("if (isDuplicateCustomerCheckoutAttempt(orderError)) {")
  assert.ok(conflictStart > 0)
  const conflictBlock = route.slice(conflictStart, route.indexOf('if (orderError?.code === "23505")', conflictStart))
  assert.match(conflictBlock, /===\s*"resume_equivalent"[\s\S]*existingTransferOrderResponse\(conflictOrder\)/)
  assert.doesNotMatch(conflictBlock, /supersede/i, "nunca se da de baja un pedido recién creado por la otra request")
  assert.match(conflictBlock, /ORDER_BEING_CREATED_MESSAGE/)
  // La clave idempotente por sesión sigue existiendo (invitados y reintentos de la misma pestaña).
  assert.equal(getTransferCheckoutIdempotencyKey("session-tab-a-0001", null), "checkout:session-tab-a-0001")
})

test("5. dos pestañas (otra sesión) no duplican: misma compra -> mismo pedido", () => {
  const tabA = evaluate()
  const tabB = evaluate()
  const order = pendingTransfer(tabA, { checkout_idempotency_key: "checkout:session-tab-a-0001" })
  assert.equal(getPendingTransferCheckoutAction(order, tabB.economicFingerprint), "resume_equivalent")
})

test("6. cambio de envío, de % de transferencia o de beneficio también invalida lo viejo", () => {
  const base = evaluate()
  const order = pendingTransfer(base)
  for (const changed of [
    evaluate({ shippingCharged: 9_500 }),
    evaluate({ shippingType: "sucursal" }),
    evaluate({ transferDiscountPercent: 15 }),
    evaluate({ storeBenefit: { id: "b-1", percent: 10 } }),
    evaluate({ quantity: 2 }),
    evaluate({ requestedCredit: 2_000 }),
    evaluate({ direccion: "Otra calle 55" }),
  ]) {
    assert.notEqual(changed.economicFingerprint, base.economicFingerprint)
    assert.equal(getPendingTransferCheckoutAction(order, changed.economicFingerprint), "supersede_stale")
  }
  assert.ok(evaluate({ transferDiscountPercent: 15 }).pricing.externalAmountDue < base.pricing.externalAmountDue)
})

test("un pedido con comprobante, verificación iniciada o pago informado NUNCA se da de baja", async () => {
  const current = evaluate({ unitPrice: 1_000 }).economicFingerprint
  const state = evaluate()
  for (const overrides of [
    { payment_proof_url: "proofs/700.pdf" },
    { payment_proof_uploaded_at: "2026-09-23T15:00:00.000Z" },
    { transfer_verification_status: "checking" },
    { transfer_verification_status: "manual_review" },
    { transfer_amount_declared: 55_000 },
    { payment_status: "en_revision" },
    { financial_status: "payment_confirmed" },
    { estado: "pagado" },
  ] satisfies Array<Partial<PendingCheckoutOrderRow>>) {
    const admin = createFakeAdmin()
    const result = await supersedeStaleTransferOrder(admin.client, pendingTransfer(state, overrides), {
      currentEconomicFingerprint: current,
    })
    assert.equal(result, "payment_in_review", JSON.stringify(overrides))
    assert.equal(admin.operations.length, 0)
  }
})

test("la baja es un UPDATE condicional (re-verifica sin rastro de pago), devuelve saldo y beneficio, y respeta carreras", async () => {
  const current = evaluate({ unitPrice: 1_000 }).economicFingerprint
  const admin = createFakeAdmin()
  await supersedeStaleTransferOrder(
    admin.client,
    pendingTransfer(evaluate(), { credit_balance_used: 3_000, store_benefit_id: "benefit-1" }),
    { currentEconomicFingerprint: current },
  )
  const cancel = admin.operations.find((operation) => operation.table === "ordenes" && operation.kind === "update")
  const filters = JSON.stringify(cancel?.filters)
  for (const expected of [
    '["eq","estado","pendiente"]',
    '["is","payment_proof_url",null]',
    '["is","payment_proof_uploaded_at",null]',
    '["is","transfer_verification_status",null]',
    '["is","transfer_amount_declared",null]',
  ]) {
    assert.ok(filters.includes(expected), expected)
  }
  assert.deepEqual(admin.rpcCalls, ["reverse_customer_credit_for_order"])
  assert.ok(admin.operations.some((operation) => operation.table === "customer_store_benefits" && operation.kind === "update"))
  assert.ok(admin.operations.some((operation) => operation.table === "order_audit_events" && operation.kind === "insert"))

  const raceLost = await supersedeStaleTransferOrder(
    createFakeAdmin({ updateMatches: false }).client,
    pendingTransfer(evaluate()),
    { currentEconomicFingerprint: current },
  )
  assert.equal(raceLost, "busy")
})

test("reemplazar un pedido de la MISMA sesión no choca contra su clave idempotente", () => {
  assert.equal(
    getTransferCheckoutIdempotencyKey("session-tab-a-0001", {
      id: 700,
      checkout_idempotency_key: "checkout:session-tab-a-0001",
    }),
    "checkout:session-tab-a-0001:after:700",
  )
  // Pedido de otra sesión (u otro medio): la nueva conserva la clave normal.
  assert.equal(
    getTransferCheckoutIdempotencyKey("session-tab-b-0002", {
      id: 700,
      checkout_idempotency_key: "checkout:session-tab-a-0001",
    }),
    "checkout:session-tab-b-0002",
  )
})

test("la ruta rechaza con PRICING_CHANGED antes de cualquier efecto si el total visto no coincide", () => {
  const route = readFileSync(
    new URL("../../app/api/transferencia/create-order/route.ts", import.meta.url),
    "utf8",
  )
  const pricingChanged = route.indexOf('code: "PRICING_CHANGED"')
  const pendingResolution = route.indexOf("await resolvePendingOrder(")
  const claim = route.indexOf("await claimActiveStoreBenefit(")
  const insert = route.indexOf(".insert(orderPayload")
  assert.ok(pricingChanged > 0 && pricingChanged < pendingResolution)
  assert.ok(pendingResolution < claim && claim < insert)
  assert.match(route, /getSiteSettings\(\{ fresh: true \}\)/)
})
