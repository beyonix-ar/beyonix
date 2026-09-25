import assert from "node:assert/strict"
import test from "node:test"

import {
  TRANSFER_MATCH_LOOKBACK_MINUTES,
  TRANSFER_VERIFICATION_MAX_AUTOMATIC_ATTEMPTS,
  TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS,
  TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS,
  TRANSFER_VERIFICATION_MANUAL_ATTEMPTS,
  getTransferAutoRetryIntervalMs,
  getTransferMatchWindow,
  isTransferAutoRetryDue,
  isRetryableManualReviewReason,
  matchBankTransferPayment,
} from "./transfer-auto-verification.ts"
import { TRANSFER_PAYMENT_EXPIRATION_HOURS } from "./transfer-expiration.ts"
import type { MercadoPagoBankTransferCandidate } from "../mercadopago/bank-transfer-search.ts"

test("calendario automático cubre 6, 12, 24 y casi 48 horas y se detiene al vencer", () => {
  const hour = 60 * 60 * 1000
  const minute = 60 * 1000
  const now = new Date("2026-09-25T12:00:00.000Z")
  for (const [ageHours, expectedMinutes] of [[1, 13], [6, 58], [12, 58], [24, 118], [47.9, 118]]) {
    const createdAt = new Date(now.getTime() - ageHours * hour)
    assert.equal(getTransferAutoRetryIntervalMs(ageHours * hour), expectedMinutes * minute)
    assert.equal(isTransferAutoRetryDue({ createdAt, lastVerificationAt: new Date(now.getTime() - expectedMinutes * minute), now }), true)
    assert.equal(isTransferAutoRetryDue({ createdAt, lastVerificationAt: new Date(now.getTime() - expectedMinutes * minute + 1000), now }), false)
  }
  assert.equal(isTransferAutoRetryDue({ createdAt: new Date(now.getTime() - 48 * hour), lastVerificationAt: null, now }), false)
  assert.ok(TRANSFER_VERIFICATION_MAX_AUTOMATIC_ATTEMPTS >= 50)
})

test("peor caso: el cron no puede consumir los 30 intentos manuales reservados", () => {
  // Intervalos mínimos exigidos también por la RPC: 13, 58 y 118 minutos.
  // En los tramos semiabiertos de 360, 1080 y 1440 minutos caben, como
  // máximo, 28 + 19 + 13 claims automáticos. Los manuales intercalados
  // desplazan el último intento y sólo pueden reducir esa cantidad.
  const maximumByTier = [
    Math.ceil(360 / 13),
    Math.ceil(1080 / 58),
    Math.ceil(1440 / 118),
  ]
  assert.deepEqual(maximumByTier, [28, 19, 13])
  assert.equal(TRANSFER_VERIFICATION_MAX_AUTOMATIC_ATTEMPTS, 60)
  assert.equal(TRANSFER_VERIFICATION_MANUAL_ATTEMPTS, 30)
  assert.equal(TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS, 90)
  assert.equal(TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS, 150)
  // Tras el peor caso de 60 automáticos y 29 manuales, el manual 30 aún
  // reclama porque la RPC rechaza sólo cuando attempts >= 90.
  assert.ok(60 + 29 < TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS)

  const createdAt = new Date("2026-09-25T00:00:00.000Z")
  let lastVerificationAt: Date = createdAt // primera declaración manual
  let automaticAttempts = 0
  let manualAttempts = 1
  for (let minute = 15; minute < 48 * 60; minute += 15) {
    const now = new Date(createdAt.getTime() + minute * 60_000)
    if ([180, 720, 1500, 2400].includes(minute)) {
      lastVerificationAt = now
      manualAttempts += 1
    }
    if (isTransferAutoRetryDue({ createdAt, lastVerificationAt, now })) {
      automaticAttempts += 1
      lastVerificationAt = now
    }
  }
  assert.ok(automaticAttempts <= TRANSFER_VERIFICATION_MAX_AUTOMATIC_ATTEMPTS)
  assert.ok(automaticAttempts + manualAttempts < TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS)
})

/** Construye un CUIL/CUIT válido (checksum real de AFIP) para un DNI y prefijo dados, sólo para tests. */
function buildValidCuil(prefix: string, dni: string): string {
  const first10 = `${prefix}${dni}`
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 10; i += 1) {
    sum += Number(first10[i]) * weights[i]
  }
  const mod = sum % 11
  const verifier = 11 - mod
  const checkDigit = verifier === 11 ? 0 : verifier === 10 ? 9 : verifier
  return `${first10}${checkDigit}`
}

const VALID_CUIL_20_30111222 = buildValidCuil("20", "30111222")
const VALID_CUIT_23_25999888 = buildValidCuil("23", "25999888")

function candidate(
  overrides: Partial<MercadoPagoBankTransferCandidate> = {},
): MercadoPagoBankTransferCandidate {
  return {
    id: "177895301225",
    status: "approved",
    operationType: "money_transfer",
    paymentMethodId: "account_money",
    transactionAmount: 900,
    currencyId: "ARS",
    dateCreated: "2026-09-13T18:17:43.000-04:00",
    dateApproved: "2026-09-13T18:17:43.000-04:00",
    identificationType: "CUIL",
    identificationNumber: VALID_CUIL_20_30111222,
    bankTransferId: null,
    ...overrides,
  }
}

test("getTransferMatchWindow reutiliza la política real de vencimiento de 48 h (no inventa una nueva)", () => {
  const createdAt = new Date("2026-09-13T12:00:00.000Z")
  const window = getTransferMatchWindow(createdAt)

  assert.equal(
    window.beginDate.getTime(),
    createdAt.getTime() - TRANSFER_MATCH_LOOKBACK_MINUTES * 60 * 1000,
  )
  assert.equal(
    window.endDate.getTime(),
    createdAt.getTime() + TRANSFER_PAYMENT_EXPIRATION_HOURS * 60 * 60 * 1000,
  )
})

// Escenario 1: monto + nombre/apellido (informativo) + DNI correctos -> auto-confirma.
test("escenario 1: monto y DNI derivado coinciden exactamente -> verified", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [candidate({ identificationNumber: VALID_CUIL_20_30111222 })],
  })

  assert.equal(result.kind, "verified")
  if (result.kind === "verified") {
    assert.equal(result.candidate.id, "177895301225")
    assert.equal(result.dniDerivation.dni, "30111222")
  }
})

test("declaredDni con puntos/espacios normaliza igual que el derivado", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30.111.222",
    candidates: [candidate({ identificationNumber: VALID_CUIL_20_30111222 })],
  })

  assert.equal(result.kind, "verified")
})

// Escenario: monto informado incorrecto (no coincide con el esperado del pedido).
test("monto informado por el cliente distinto del esperado -> manual_review sin consultar MP", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 850,
    declaredDni: "30111222",
    candidates: [candidate()],
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "declared_amount_mismatch" })
})

// Escenario: DNI informado por el cliente inválido.
test("DNI informado con formato inválido -> manual_review, nunca intenta derivar nada", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "abc",
    candidates: [candidate()],
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "declared_dni_invalid" })
})

// Escenario: DNI incorrecto respecto del real derivado de Mercado Pago.
test("DNI informado no coincide con el derivado de Mercado Pago -> manual_review", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "99999999",
    candidates: [candidate({ identificationNumber: VALID_CUIL_20_30111222 })],
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "dni_mismatch" })
})

// Escenario: dos transferencias con el mismo monto (ambiguo) -> nunca auto-confirma.
test("dos candidatos con el mismo monto exacto -> manual_review (ambiguo, nunca elige uno al azar)", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [
      candidate({ id: "1" }),
      candidate({ id: "2" }),
    ],
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "multiple_candidates" })
})

// Escenario: transferencia aún no visible en Mercado Pago.
test("sin candidatos en la ventana -> manual_review con motivo reintentable", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [],
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "no_candidates" })
  assert.equal(isRetryableManualReviewReason("no_candidates"), true)
})

// Escenario: existen transferencias en la ventana pero ninguna con el monto exacto.
test("candidatos existen pero ninguno con el monto exacto -> manual_review reintentable (resultado normal de verificar antes de transferir en una cuenta con movimiento)", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [candidate({ transactionAmount: 850 })],
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "amount_mismatch_mp" })
  assert.equal(isRetryableManualReviewReason("amount_mismatch_mp"), true)
})

// Escenario: Mercado Pago no devuelve identificación utilizable para ese pagador.
test("candidato sin identification utilizable -> manual_review (nunca inventa una validación por nombre)", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [candidate({ identificationType: null, identificationNumber: null })],
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "identification_unavailable" })
})

// Escenario: transferencia ya usada por otro pedido (excluida antes de matchear).
test("candidato ya usado por otro pedido se excluye antes de matchear -> equivalente a no_candidates", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [candidate({ id: "177895301225" })],
    excludePaymentIds: new Set(["177895301225"]),
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "no_candidates" })
})

// Tipo de transferencia con operation_type/payment_method_id no soportado: nunca llega como candidato
// (se filtra en lib/mercadopago/bank-transfer-search.ts), así que una lista vacía se comporta igual
// que "no encontrado" -- no hay bypass posible para tipos no admitidos.
test("un único candidato válido de tipo account_fund/cvu también matchea (segundo tipo comprobado)", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 20_000,
    declaredAmount: 20_000,
    declaredDni: "25999888",
    candidates: [
      candidate({
        id: "166885321366",
        operationType: "account_fund",
        paymentMethodId: "cvu",
        transactionAmount: 20_000,
        identificationType: "CUIT",
        identificationNumber: VALID_CUIT_23_25999888,
        bankTransferId: "125973342853",
      }),
    ],
  })

  assert.equal(result.kind, "verified")
})

test("isRetryableManualReviewReason sólo reintenta cuando la transferencia del titular todavía puede aparecer", () => {
  const nonRetryable = [
    "declared_amount_mismatch",
    "declared_dni_invalid",
    "multiple_candidates",
    "identification_unavailable",
    "payment_id_already_used",
    "stock_conflict",
    "search_not_exhaustive",
    "expected_amount_changed",
  ] as const

  for (const reason of nonRetryable) {
    assert.equal(isRetryableManualReviewReason(reason), false)
  }
  for (const reason of ["no_candidates", "amount_mismatch_mp", "dni_mismatch", "mercadopago_unavailable"] as const) {
    assert.equal(isRetryableManualReviewReason(reason), true)
  }
})

test("mismo monto de OTRO pagador + transferencia del titular declarado -> verifica la del titular (la unicidad es sobre monto + DNI)", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [
      candidate({ id: "other", identificationNumber: VALID_CUIT_23_25999888 }),
      candidate({ id: "mine", identificationNumber: VALID_CUIL_20_30111222 }),
    ],
  })

  assert.equal(result.kind, "verified")
  assert.equal(result.kind === "verified" && result.candidate.id, "mine")
})

test("transferencia del mismo monto ya usada por otro pedido + transferencia nueva del titular -> verifica la nueva, nunca la usada", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [candidate({ id: "used" }), candidate({ id: "new" })],
    excludePaymentIds: new Set(["used"]),
  })

  assert.equal(result.kind === "verified" && result.candidate.id, "new")
})

test("mismo monto, ninguna del DNI declarado y una sin documento -> identification_unavailable (podría ser la del cliente: revisión humana)", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [
      candidate({ id: "other", identificationNumber: VALID_CUIT_23_25999888 }),
      candidate({ id: "anon", identificationType: null, identificationNumber: null }),
    ],
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "identification_unavailable" })
})

test("DNI declarado coincide pero el monto no -> nunca verifica", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [candidate({ transactionAmount: 900.01 })],
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "amount_mismatch_mp" })
})

// Reglas pedidas por el negocio, contra el matcher real. Mercado Pago no
// informa el nombre del titular en transferencias (payer.first_name/last_name
// y bank_info.payer.long_name vienen vacíos, verificado en una transferencia
// real): la identidad se verifica por el DNI que codifica su CUIL.
test("negocio: DNI correcto + monto exacto -> verified; monto distinto o DNI distinto -> nunca", () => {
  const declaredDni = "30111222"
  assert.equal(
    matchBankTransferPayment({ expectedAmount: 900, declaredAmount: 900, declaredDni, candidates: [candidate()] }).kind,
    "verified",
  )
  // Monto transferido distinto al del pedido (DNI correcto).
  const otherAmount = matchBankTransferPayment({ expectedAmount: 900, declaredAmount: 900, declaredDni, candidates: [candidate({ transactionAmount: 899.99 })] })
  assert.deepEqual(otherAmount, { kind: "manual_review", reason: "amount_mismatch_mp" })
  // Monto declarado distinto (aunque la transferencia exista).
  const declaredOther = matchBankTransferPayment({ expectedAmount: 900, declaredAmount: 901, declaredDni, candidates: [candidate()] })
  assert.deepEqual(declaredOther, { kind: "manual_review", reason: "declared_amount_mismatch" })
  // DNI distinto del titular real de la transferencia.
  const otherDni = matchBankTransferPayment({ expectedAmount: 900, declaredAmount: 900, declaredDni: "30111223", candidates: [candidate()] })
  assert.deepEqual(otherDni, { kind: "manual_review", reason: "dni_mismatch" })
  // El mismo DNI declarado como CUIL/CUIT también coincide.
  assert.equal(
    matchBankTransferPayment({ expectedAmount: 900, declaredAmount: 900, declaredDni: VALID_CUIL_20_30111222, candidates: [candidate()] }).kind,
    "verified",
  )
})
