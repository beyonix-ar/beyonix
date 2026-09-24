import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Nota: el archivo de ruta vive bajo app/api/transferencia/[orderId]/verificar/
// -- deliberadamente NO se coloca un route.test.ts colocado ahí mismo porque
// el runner de tests de Node (--test) interpreta "[orderId]" como un glob de
// clase de caracteres y termina ejecutando 0 tests en silencio. Por eso este
// contrato se testea leyendo el archivo desde acá, igual que otros tests de
// "SQL/route contract" del proyecto (ver lib/mercadopago/order-payment.test.ts).
const routeSource = readFileSync(
  new URL(
    "../../app/api/transferencia/[orderId]/verificar/route.ts",
    import.meta.url,
  ),
  "utf8",
)
const serviceSource = readFileSync(
  new URL("./transfer-verification-service.ts", import.meta.url),
  "utf8",
)

test("el endpoint exige pertenencia del pedido (sesión propia o guest token), igual que payment-proofs", () => {
  assert.match(routeSource, /order\.usuario_id !== user\?\.id/)
  assert.match(routeSource, /verifyGuestOrderAccessToken\(guestToken, pedidoId\)/)
})

test("el endpoint sólo admite pedidos por transferencia bancaria", () => {
  assert.match(routeSource, /order\.payment_method_id !== "transferencia"/)
})

test("el endpoint nunca usa el monto informado por el cliente como fuente de verdad -- sólo lo pasa como dato declarado", () => {
  assert.doesNotMatch(routeSource, /payload\.total/)
  assert.doesNotMatch(routeSource, /payload\.external_amount_due/)
  // Datos ya validados y normalizados (lib/payments/transfer-declaration.ts).
  assert.match(routeSource, /declared:\s*\{\s*firstName,\s*lastName,\s*dni: document,\s*amount\s*\}/)
})

test("el monto esperado real siempre se calcula desde la orden en base de datos, nunca desde el request", () => {
  assert.match(
    serviceSource,
    /Number\(order\.external_amount_due \?\? order\.total \?\? Number\.NaN\)/,
  )
})

test("el endpoint nunca expone la lista de candidatos de Mercado Pago al navegador", () => {
  assert.doesNotMatch(routeSource, /candidates/i)
  assert.doesNotMatch(routeSource, /searchIncomingBankTransfers/)
})

test("un rechazo esperado (rate limit, verificación en curso) nunca se devuelve como si fuera un error genérico sin distinguir", () => {
  assert.match(routeSource, /status:\s*429/)
  assert.match(routeSource, /case "checking_in_progress":/)
})

test("la conciliación automática nunca reutiliza el webhook de Checkout Pro de Mercado Pago", () => {
  assert.doesNotMatch(routeSource, /mercadopago\/webhook/)
  assert.doesNotMatch(serviceSource, /external_reference/)
})

// Test de contrato (falla si el endpoint vuelve a exponer campos sensibles):
// el cliente sólo puede recibir status/verified/manualReviewRequired/
// proofUploadAvailable/message -- nunca la fila de la orden completa ni
// metadata interna de conciliación con Mercado Pago (transfer_match_snapshot,
// identification original/derivada, transfer_matched_payment_id). Esos
// datos sólo se ven desde endpoints admin protegidos.
test("el endpoint nunca reenvía la orden completa ni campos sensibles de conciliación -- respuesta explícitamente allowlisteada", () => {
  assert.doesNotMatch(routeSource, /NextResponse\.json\(\s*\{\s*[^}]*\border:/)
  assert.doesNotMatch(routeSource, /result\.order/)
  assert.doesNotMatch(routeSource, /transfer_match_snapshot/)
  assert.doesNotMatch(routeSource, /transfer_matched_payment_id/)
  assert.doesNotMatch(routeSource, /identificationNumber/)
  assert.doesNotMatch(routeSource, /identificationType/)
  assert.doesNotMatch(routeSource, /dniDerivado/)
  assert.doesNotMatch(routeSource, /transfer_payer_dni/)

  assert.match(routeSource, /function safeVerificationResponse/)
  assert.match(routeSource, /status:\s*result\.status/)
  assert.match(routeSource, /manualReviewRequired:/)
  assert.match(routeSource, /proofUploadAvailable/)
})

test("un fallo técnico (rate limit, verificación en curso, error inesperado) siempre ofrece el comprobante como salida segura -- nunca deja al cliente bloqueado", () => {
  const errorBranches = routeSource.slice(routeSource.indexOf('case "rate_limited"'))
  const occurrences = errorBranches.match(/proofUploadAvailable:\s*true/g) ?? []
  assert.ok(
    occurrences.length >= 3,
    "rate_limited, checking_in_progress, rejected/default y el catch(500) deben ofrecer proofUploadAvailable",
  )
})
