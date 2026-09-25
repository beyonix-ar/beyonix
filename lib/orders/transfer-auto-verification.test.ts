import assert from "node:assert/strict"
import test from "node:test"

import {
  TRANSFER_MATCH_LOOKBACK_MINUTES,
  getTransferMatchWindow,
  isRetryableManualReviewReason,
  matchBankTransferPayment,
} from "./transfer-auto-verification.ts"
import { TRANSFER_PAYMENT_EXPIRATION_HOURS } from "./transfer-expiration.ts"
import type { MercadoPagoBankTransferCandidate } from "../mercadopago/bank-transfer-search.ts"

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
test("candidatos existen pero ninguno con el monto exacto -> manual_review no reintentable", () => {
  const result = matchBankTransferPayment({
    expectedAmount: 900,
    declaredAmount: 900,
    declaredDni: "30111222",
    candidates: [candidate({ transactionAmount: 850 })],
  })

  assert.deepEqual(result, { kind: "manual_review", reason: "amount_mismatch_mp" })
  assert.equal(isRetryableManualReviewReason("amount_mismatch_mp"), false)
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

test("isRetryableManualReviewReason sólo reintenta cuando el motivo es transitorio", () => {
  const nonRetryable = [
    "declared_amount_mismatch",
    "declared_dni_invalid",
    "amount_mismatch_mp",
    "multiple_candidates",
    "identification_unavailable",
    "dni_mismatch",
    "payment_id_already_used",
    "stock_conflict",
  ] as const

  for (const reason of nonRetryable) {
    assert.equal(isRetryableManualReviewReason(reason), false)
  }
  assert.equal(isRetryableManualReviewReason("no_candidates"), true)
  assert.equal(isRetryableManualReviewReason("mercadopago_unavailable"), true)
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
