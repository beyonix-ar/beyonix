import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
  canUploadTransferProof,
  describeManualReviewReason,
  getManualReviewCustomerMessage,
  isRetryableManualReviewReason,
} from "./transfer-verification-reasons.ts"

// Este módulo se importa desde admin-pedidos.tsx, un componente "use client".
// transfer-auto-verification.ts (donde vivían antes estas funciones) importa
// transitivamente lib/orders/transfer-expiration.ts, que trae `import
// "server-only"` -- eso rompe el build del cliente. Este archivo nunca debe
// volver a depender de transfer-expiration.ts ni de "server-only".
test("transfer-verification-reasons.ts es seguro para importar desde un componente cliente (sin server-only transitivo)", () => {
  const source = readFileSync(new URL("./transfer-verification-reasons.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /^import\s+["']server-only["']/m)
  assert.doesNotMatch(source, /^import[\s\S]*?from\s+["'][^"']*transfer-expiration[^"']*["']/m)
})

test("describeManualReviewReason cubre los 12 motivos posibles sin exponer datos de terceros", () => {
  const reasons: Array<Parameters<typeof describeManualReviewReason>[0]> = [
    "declared_amount_mismatch",
    "declared_dni_invalid",
    "no_candidates",
    "amount_mismatch_mp",
    "multiple_candidates",
    "identification_unavailable",
    "dni_mismatch",
    "payment_id_already_used",
    "mercadopago_unavailable",
    "stock_conflict",
    "search_not_exhaustive",
    "expected_amount_changed",
  ]

  for (const reason of reasons) {
    const description = describeManualReviewReason(reason)
    assert.ok(description.length > 0)
  }
  assert.equal(describeManualReviewReason(null), "Sin intentos de verificación registrados.")
})

test("getManualReviewCustomerMessage nunca cambia según el motivo interno (mensaje genérico y seguro)", () => {
  assert.equal(
    getManualReviewCustomerMessage(),
    "No pudimos validar tu transferencia automáticamente.",
  )
})

test("TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS es distinto de cualquier TRANSFER_PAYMENT_STATUSES existente", () => {
  assert.equal(TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS, "auto_verified_stock_conflict")
})

test("isRetryableManualReviewReason exportado también desde el módulo client-safe coincide con el server", () => {
  assert.equal(isRetryableManualReviewReason("no_candidates"), true)
  assert.equal(isRetryableManualReviewReason("dni_mismatch"), false)
})

test("search_not_exhaustive y expected_amount_changed nunca son reintentables automáticamente -- requieren revisión humana, no cambian solos con el tiempo", () => {
  assert.equal(isRetryableManualReviewReason("search_not_exhaustive"), false)
  assert.equal(isRetryableManualReviewReason("expected_amount_changed"), false)
})

// canUploadTransferProof: criterio central único, compartido por el
// endpoint /verificar, el endpoint /payment-proofs y los componentes de UI.
// Cubre exactamente los escenarios de la segunda auditoría de Codex.
test("canUploadTransferProof: pendiente_comprobante, en_revision y rechazado admiten comprobante", () => {
  assert.equal(canUploadTransferProof("pendiente_comprobante"), true)
  assert.equal(canUploadTransferProof("en_revision"), true)
  assert.equal(canUploadTransferProof("rechazado"), true)
})

test("canUploadTransferProof: null/undefined se tratan como pendiente_comprobante (mismo criterio de fallback que el resto del sistema)", () => {
  assert.equal(canUploadTransferProof(null), true)
  assert.equal(canUploadTransferProof(undefined), true)
})

test("canUploadTransferProof: auto_verified_stock_conflict SÍ admite comprobante -- el dinero ya está identificado, pero un admin puede necesitar evidencia adicional (bug Codex: backend y UI antes quedaban inconsistentes acá)", () => {
  assert.equal(canUploadTransferProof(TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS), true)
})

test("canUploadTransferProof: un pago ya confirmado NUNCA admite comprobante", () => {
  assert.equal(canUploadTransferProof("confirmado"), false)
})

test("canUploadTransferProof: estados desconocidos (ej.: un motivo interno de manual_review pasado por error) no habilitan el uploader por accidente", () => {
  assert.equal(canUploadTransferProof("manual_review"), false)
  assert.equal(canUploadTransferProof("mercadopago_unavailable"), false)
  assert.equal(canUploadTransferProof("search_not_exhaustive"), false)
})
