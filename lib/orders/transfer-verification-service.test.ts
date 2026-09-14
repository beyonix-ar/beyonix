import assert from "node:assert/strict"
import test from "node:test"

import { attemptTransferAutoVerification } from "./transfer-verification-service.ts"
import { TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS } from "./transfer-auto-verification.ts"
import type { MercadoPagoBankTransferCandidate } from "../mercadopago/bank-transfer-search.ts"

const RECENT_CREATED_AT = new Date().toISOString()

function baseOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    created_at: RECENT_CREATED_AT,
    estado: "pendiente",
    payment_method_id: "transferencia",
    payment_status: "pendiente_comprobante",
    payment_proof_url: null,
    payment_proof_uploaded_at: null,
    financial_status: "pending_payment",
    external_amount_due: 900,
    total: 900,
    cliente_email: "cliente@example.com",
    cliente_nombre: "Cliente Test",
    ...overrides,
  }
}

function buildValidCuil(prefix: string, dni: string): string {
  const first10 = `${prefix}${dni}`
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 10; i += 1) sum += Number(first10[i]) * weights[i]
  const mod = sum % 11
  const verifier = 11 - mod
  const checkDigit = verifier === 11 ? 0 : verifier === 10 ? 9 : verifier
  return `${first10}${checkDigit}`
}

const VALID_CUIL = buildValidCuil("20", "30111222")

function candidate(overrides: Partial<MercadoPagoBankTransferCandidate> = {}): MercadoPagoBankTransferCandidate {
  return {
    id: "177895301225",
    status: "approved",
    operationType: "money_transfer",
    paymentMethodId: "account_money",
    transactionAmount: 900,
    currencyId: "ARS",
    dateCreated: RECENT_CREATED_AT,
    dateApproved: RECENT_CREATED_AT,
    identificationType: "CUIL",
    identificationNumber: VALID_CUIL,
    bankTransferId: null,
    ...overrides,
  }
}

type RpcResponse = { data: unknown; error: { message: string } | null }

function createFakeAdmin(options: {
  rpcResponses: Record<string, RpcResponse | ((args: Record<string, unknown>) => RpcResponse)>
  orderRow: Record<string, unknown>
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = []
  const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = []

  function tableBuilder(table: string) {
    const builder: {
      update: (values: Record<string, unknown>) => typeof builder
      select: () => typeof builder
      insert: (values: Record<string, unknown>) => Promise<{ data: null; error: null }>
      eq: () => typeof builder
      neq: () => typeof builder
      in: () => typeof builder
      order: () => typeof builder
      limit: () => typeof builder
      maybeSingle: () => Promise<{ data: unknown; error: null }>
      then: (resolve: (value: { data: null; error: null }) => unknown) => unknown
    } = {
      update(values) {
        updateCalls.push({ table, values })
        if (table === "ordenes") Object.assign(options.orderRow, values)
        return builder
      },
      select() {
        return builder
      },
      insert(values) {
        insertCalls.push({ table, values })
        return Promise.resolve({ data: null, error: null })
      },
      eq() {
        return builder
      },
      neq() {
        return builder
      },
      in() {
        return builder
      },
      order() {
        return builder
      },
      limit() {
        return builder
      },
      maybeSingle() {
        return Promise.resolve({
          data: table === "ordenes" ? { ...options.orderRow } : null,
          error: null,
        })
      },
      then(resolve) {
        return Promise.resolve({ data: null, error: null }).then(resolve)
      },
    }
    return builder
  }

  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      const configured = options.rpcResponses[name]
      if (!configured) throw new Error(`rpc inesperada en el mock: ${name}`)
      const response = typeof configured === "function" ? configured(args) : configured
      if (!response.error && name === "claim_transfer_verification_attempt") {
        options.orderRow.transfer_verification_status = "checking"
      }
      if (!response.error && name === "confirm_transfer_auto_verification") {
        Object.assign(options.orderRow, {
          payment_status: "confirmado",
          estado: "pagado",
          financial_status: "payment_confirmed",
          transfer_verification_status: "auto_verified",
          transfer_matched_payment_id: args.p_matched_payment_id,
        })
      }
      return response
    },
    from: tableBuilder,
  }

  return { admin, rpcCalls, updateCalls, insertCalls }
}

const declaredValid = { firstName: "Jose", lastName: "Perez", dni: "30111222", amount: 900 }

test("escenario feliz: monto + DNI derivado coinciden -> verified y persiste transfer_matched_payment_id", async () => {
  const orderRow = baseOrderRow()
  const { admin, rpcCalls } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: { data: { ...orderRow }, error: null },
      confirm_transfer_auto_verification: { data: { ...orderRow, payment_status: "confirmado" }, error: null },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    { searchTransfers: async () => ({ candidates: [candidate()], exhaustive: true }) },
  )

  assert.equal(result.status, "verified")
  const confirmCall = rpcCalls.find((c) => c.name === "confirm_transfer_auto_verification")
  assert.equal(confirmCall?.args.p_matched_payment_id, "177895301225")
  assert.equal(confirmCall?.args.p_matched_dni_derived, "30111222")
})

test("sin candidatos en Mercado Pago -> manual_review, no llama a confirm_transfer_auto_verification", async () => {
  const orderRow = baseOrderRow()
  const { admin, rpcCalls } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: { data: { ...orderRow }, error: null },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    { searchTransfers: async () => ({ candidates: [], exhaustive: true }) },
  )

  assert.equal(result.status, "manual_review")
  if (result.status === "manual_review") assert.equal(result.reason, "no_candidates")
  assert.equal(rpcCalls.some((c) => c.name === "confirm_transfer_auto_verification"), false)
})

test("búsqueda no exhaustiva (se cortó por el tope de páginas sin cubrir toda la ventana) -> manual_review, nunca auto-confirma con un conjunto parcial", async () => {
  const orderRow = baseOrderRow()
  const { admin, rpcCalls } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: { data: { ...orderRow }, error: null },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    // Aunque venga un candidato que matchearía perfecto, exhaustive=false
    // tiene que ganar siempre: no se puede demostrar que no había OTRO
    // candidato ambiguo fuera de lo recorrido.
    { searchTransfers: async () => ({ candidates: [candidate()], exhaustive: false }) },
  )

  assert.equal(result.status, "manual_review")
  if (result.status === "manual_review") assert.equal(result.reason, "search_not_exhaustive")
  assert.equal(rpcCalls.some((c) => c.name === "confirm_transfer_auto_verification"), false)
})

test("Mercado Pago cae (timeout/API down) -> manual_review con motivo reintentable, nunca 500 sin controlar", async () => {
  const orderRow = baseOrderRow()
  const { admin } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: { data: { ...orderRow }, error: null },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    {
      searchTransfers: async () => {
        throw new Error("fetch failed: timeout")
      },
    },
  )

  assert.equal(result.status, "manual_review")
  if (result.status === "manual_review") assert.equal(result.reason, "mercadopago_unavailable")
})

test("monto informado por el cliente no coincide con el esperado -> manual_review SIN consultar Mercado Pago", async () => {
  const orderRow = baseOrderRow({ total: 900, external_amount_due: 900 })
  const { admin } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: { data: { ...orderRow }, error: null },
    },
  })

  let searchCalled = false
  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: { ...declaredValid, amount: 850 } },
    {
      searchTransfers: async () => {
        searchCalled = true
        return { candidates: [candidate()], exhaustive: true }
      },
    },
  )

  assert.equal(result.status, "manual_review")
  if (result.status === "manual_review") assert.equal(result.reason, "declared_amount_mismatch")
  assert.equal(searchCalled, false)
})

test("DNI informado con formato inválido -> manual_review sin consultar Mercado Pago", async () => {
  const orderRow = baseOrderRow()
  const { admin } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: { data: { ...orderRow }, error: null },
    },
  })

  let searchCalled = false
  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: { ...declaredValid, dni: "abc" } },
    { searchTransfers: async () => { searchCalled = true; return { candidates: [], exhaustive: true } } },
  )

  assert.equal(result.status, "manual_review")
  if (result.status === "manual_review") assert.equal(result.reason, "declared_dni_invalid")
  assert.equal(searchCalled, false)
})

test("transferencia ya usada por otro pedido -> manual_review, nunca acredita dos veces (unique constraint)", async () => {
  const orderRow = baseOrderRow()
  const { admin } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: { data: { ...orderRow }, error: null },
      confirm_transfer_auto_verification: {
        data: null,
        error: { message: "TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada." },
      },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    { searchTransfers: async () => ({ candidates: [candidate()], exhaustive: true }) },
  )

  assert.equal(result.status, "manual_review")
  if (result.status === "manual_review") assert.equal(result.reason, "payment_id_already_used")
})

test("monto esperado cambió entre la lectura previa y la confirmación (AMOUNT_MISMATCH bajo lock) -> manual_review, nunca confirma contra un monto vencido", async () => {
  const orderRow = baseOrderRow()
  const { admin } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: { data: { ...orderRow }, error: null },
      confirm_transfer_auto_verification: {
        data: null,
        error: { message: "AMOUNT_MISMATCH: el monto vigente del pedido no coincide." },
      },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    { searchTransfers: async () => ({ candidates: [candidate()], exhaustive: true }) },
  )

  assert.equal(result.status, "manual_review")
  if (result.status === "manual_review") assert.equal(result.reason, "expected_amount_changed")
})

test("stock insuficiente al confirmar (dinero real, sin stock): la RPC ya reclama transfer_matched_payment_id de forma atómica y devuelve la orden en conflicto -- nunca se pierde el pago silenciosamente ni queda sin reservar", async () => {
  const orderRow = baseOrderRow()
  const { admin, updateCalls } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: { data: { ...orderRow }, error: null },
      // Migración 20260914090000: ante conflicto de stock, la RPC ya NO
      // lanza una excepción -- devuelve la orden actualizada con
      // payment_status=auto_verified_stock_conflict Y
      // transfer_matched_payment_id ya reclamado, todo bajo el mismo lock.
      confirm_transfer_auto_verification: {
        data: {
          ...orderRow,
          payment_status: TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
          transfer_matched_payment_id: "177895301225",
          transfer_verification_status: "manual_review",
          transfer_verification_failure_reason: "stock_conflict",
        },
        error: null,
      },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    { searchTransfers: async () => ({ candidates: [candidate()], exhaustive: true }) },
  )

  assert.equal(result.status, "manual_review")
  if (result.status === "manual_review") {
    assert.equal(result.reason, "stock_conflict")
    assert.equal(result.order.transfer_matched_payment_id, "177895301225")
  }
  // La RPC resolvió todo atómicamente -- el servicio ya no necesita (ni
  // debe) hacer un UPDATE propio fuera de lock para marcar el conflicto.
  assert.equal(
    updateCalls.some((c) => c.table === "ordenes" && c.values.payment_status === TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS),
    false,
    "el servicio no debe volver a escribir el conflicto de stock: eso ya lo hizo la RPC bajo lock",
  )
})

test("doble click / dos requests simultáneas: la segunda encuentra el lock 'checking' y no dispara otro intento", async () => {
  const orderRow = baseOrderRow()
  const { admin } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: {
        data: null,
        error: { message: "ALREADY_CHECKING: ya hay una verificación en curso." },
      },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    { searchTransfers: async () => ({ candidates: [candidate()], exhaustive: true }) },
  )

  assert.equal(result.status, "checking_in_progress")
})

test("rate limit: reintentar demasiado rápido devuelve rate_limited sin llamar a Mercado Pago", async () => {
  const orderRow = baseOrderRow()
  const { admin } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: {
        data: null,
        error: { message: "RATE_LIMITED: esperá unos segundos." },
      },
    },
  })

  let searchCalled = false
  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    { searchTransfers: async () => { searchCalled = true; return { candidates: [], exhaustive: true } } },
  )

  assert.equal(result.status, "rate_limited")
  assert.equal(searchCalled, false)
})

test("máximo de intentos alcanzado -> rejected con mensaje claro, no sigue reintentando indefinidamente", async () => {
  const orderRow = baseOrderRow()
  const { admin } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: {
        data: null,
        error: { message: "MAX_ATTEMPTS_EXCEEDED: se alcanzó el máximo." },
      },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    { searchTransfers: async () => ({ candidates: [], exhaustive: true }) },
  )

  assert.equal(result.status, "rejected")
})

test("pedido con el pago ya resuelto (confirmado/rechazado) -> rejected desde el claim, fail-closed", async () => {
  const orderRow = baseOrderRow()
  const { admin } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: {
        data: null,
        error: { message: "ALREADY_RESOLVED: el pago ya fue resuelto." },
      },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    { searchTransfers: async () => ({ candidates: [], exhaustive: true }) },
  )

  assert.equal(result.status, "rejected")
})

test("dos transferencias con el mismo monto (ambiguo) -> manual_review, nunca confirma al azar", async () => {
  const orderRow = baseOrderRow()
  const { admin, rpcCalls } = createFakeAdmin({
    orderRow,
    rpcResponses: {
      claim_transfer_verification_attempt: { data: { ...orderRow }, error: null },
    },
  })

  const result = await attemptTransferAutoVerification(
    admin as never,
    { orderId: 42, declared: declaredValid },
    { searchTransfers: async () => ({ candidates: [candidate({ id: "1" }), candidate({ id: "2" })], exhaustive: true }) },
  )

  assert.equal(result.status, "manual_review")
  if (result.status === "manual_review") assert.equal(result.reason, "multiple_candidates")
  assert.equal(rpcCalls.some((c) => c.name === "confirm_transfer_auto_verification"), false)
})
