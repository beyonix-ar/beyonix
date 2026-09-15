import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// El archivo de ruta vive bajo app/api/payment-proofs/ (sin segmento
// dinámico en este caso, pero se sigue el mismo patrón que
// transfer-verification-route-contract.test.ts para mantener el contrato
// desacoplado de dónde vive Next.js el route handler).
const routeSource = readFileSync(
  new URL("../../app/api/payment-proofs/route.ts", import.meta.url),
  "utf8",
)

// Test de contrato (falla si el endpoint vuelve a exponer la fila completa
// de `ordenes`): Codex detectó en la segunda auditoría que POST
// /api/payment-proofs devolvía `{ order: updatedOrder }` con la fila
// COMPLETA después del UPDATE, exponiendo transfer_match_snapshot,
// transfer_matched_payment_id y el DNI derivado de Mercado Pago al cliente
// que sólo subió un comprobante. La respuesta JSON en sí nunca debe
// reenviar `updatedOrder` sin pasar por la allowlist.
test("POST /api/payment-proofs nunca devuelve la fila completa de la orden tal cual viene de Supabase", () => {
  assert.doesNotMatch(routeSource, /order:\s*updatedOrder\b/)
})

test("la respuesta usa una allowlist explícita, nunca reenvía la fila tal cual viene de Supabase", () => {
  assert.match(routeSource, /function toClientSafeOrder/)
  assert.match(routeSource, /order:\s*toClientSafeOrder\(updatedOrder/)

  const allowlistMatch = routeSource.match(
    /const CLIENT_SAFE_ORDER_FIELDS = \[([\s\S]*?)\] as const/,
  )
  assert.ok(allowlistMatch, "debe existir una constante CLIENT_SAFE_ORDER_FIELDS")

  const fields = allowlistMatch![1]
    .split(",")
    .map((field) => field.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)

  assert.deepEqual(
    fields.sort(),
    [
      "estado",
      "financial_status",
      "id",
      "payment_method_id",
      "payment_proof_file_name",
      "payment_proof_uploaded_at",
      "payment_proof_url",
      "payment_status",
    ].sort(),
    "la allowlist sólo debe contener campos mínimos y seguros -- nunca datos de conciliación con Mercado Pago",
  )
})

test("el estado auto_verified_stock_conflict admite subir comprobante -- coherente con la UI, que ya lo muestra", () => {
  assert.match(routeSource, /canUploadTransferProof/)
  assert.match(routeSource, /TRANSFER_PROOF_UPLOAD_ELIGIBLE_PAYMENT_STATUSES/)
  assert.doesNotMatch(
    routeSource,
    /REPLACEABLE_PAYMENT_STATUSES/,
    "la lista hardcodeada vieja debe reemplazarse por el criterio central compartido",
  )
})
