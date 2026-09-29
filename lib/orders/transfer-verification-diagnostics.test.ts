import assert from "node:assert/strict"
import test from "node:test"

import { describeTransferConfirmationFailure, maskIdentifier } from "./transfer-verification-diagnostics.ts"
import {
  AWAITING_TRANSFER_REASONS,
  getTransferVerificationCustomerOutcome,
  TRANSFER_VERIFICATION_OUTCOME_MESSAGES,
  type TransferManualReviewReason,
} from "./transfer-verification-reasons.ts"

test("todavía no apareció ≠ apareció pero no coincide ≠ encontrada y falta confirmar", () => {
  for (const reason of AWAITING_TRANSFER_REASONS) {
    assert.equal(getTransferVerificationCustomerOutcome("awaiting_transfer", reason), "not_found", reason)
  }
  for (const reason of ["dni_mismatch", "identification_unavailable", "declared_dni_invalid", "declared_amount_mismatch"] as TransferManualReviewReason[]) {
    assert.equal(getTransferVerificationCustomerOutcome("manual_review", reason), "not_matching", reason)
  }
  assert.equal(getTransferVerificationCustomerOutcome("manual_review", "confirmation_error"), "confirming")
  assert.equal(getTransferVerificationCustomerOutcome("manual_review", "stock_conflict"), "stock_conflict")
  assert.equal(getTransferVerificationCustomerOutcome("manual_review", "multiple_candidates"), "manual_review")
  assert.equal(getTransferVerificationCustomerOutcome("verified", null), "verified")

  assert.equal(TRANSFER_VERIFICATION_OUTCOME_MESSAGES.not_found, "Tu transferencia todavía no aparece. Puede tardar unos minutos en reflejarse.")
  assert.equal(TRANSFER_VERIFICATION_OUTCOME_MESSAGES.not_matching, "No pudimos hacer coincidir la transferencia con los datos ingresados.")
  assert.notEqual(TRANSFER_VERIFICATION_OUTCOME_MESSAGES.not_found, TRANSFER_VERIFICATION_OUTCOME_MESSAGES.not_matching)
  // Encontrada pero sin confirmar: nunca "no encontramos tu transferencia".
  assert.doesNotMatch(TRANSFER_VERIFICATION_OUTCOME_MESSAGES.confirming, /no (encontramos|aparece)/i)
})

test("observabilidad segura: DNI/CUIT, CVU y payment.id siempre enmascarados", () => {
  assert.equal(maskIdentifier("20372812924"), "********924")
  assert.equal(maskIdentifier("0000003100012345678901"), "*******************901")
  assert.equal(maskIdentifier(null), null)
  assert.equal(maskIdentifier("abc"), "abc")

  const described = describeTransferConfirmationFailure({
    message: "LEASE_EXPIRED: el intento 20372812924 venció",
    code: "P0001",
    hint: "revisar 177895301225",
  })
  assert.deepEqual(described, {
    code: "LEASE_EXPIRED",
    sqlstate: "P0001",
    message: "LEASE_EXPIRED: el intento ********924 venció",
    hint: "revisar *********225",
    emptyResponse: false,
  })
  assert.equal(describeTransferConfirmationFailure(null).emptyResponse, true, "respuesta vacía de la RPC, sin error")
})

test("catalog_state_invalid: el cliente ve el mensaje genérico, no reintentable y sin el motivo interno", async () => {
  const { isRetryableManualReviewReason, describeManualReviewReason } = await import("./transfer-verification-reasons.ts")
  assert.equal(getTransferVerificationCustomerOutcome("manual_review", "catalog_state_invalid"), "manual_review")
  assert.equal(isRetryableManualReviewReason("catalog_state_invalid"), false, "reintentar no arregla el catálogo")
  assert.match(describeManualReviewReason("catalog_state_invalid"), /requisitos comerciales/)
  assert.doesNotMatch(TRANSFER_VERIFICATION_OUTCOME_MESSAGES.manual_review, /variante|stock|SKU/i)
})
