import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const SOURCE = readFileSync("components/transfer-auto-verification-form.tsx", "utf8")

test("reutiliza el uploader de comprobante existente -- no reimplementa una segunda subida", () => {
  assert.match(SOURCE, /import \{ CustomerPaymentProof \} from "@\/components\/customer-payment-proof"/)
  // Nunca reimplementa el bucket/validación de comprobantes -- eso vive
  // exclusivamente en lib/payments/transfer.ts y app/api/payment-proofs.
  assert.doesNotMatch(SOURCE, /PAYMENT_PROOF_BUCKET/)
  assert.doesNotMatch(SOURCE, /getPaymentProofValidationError/)
  assert.doesNotMatch(SOURCE, /\.storage\.from\(/)
})

test("después de un fallo automático (manual_review) el comprobante sigue disponible -- el cliente nunca queda bloqueado", () => {
  const manualReviewBlock = SOURCE.slice(SOURCE.indexOf("manualReviewActive && ("))
  assert.ok(manualReviewBlock.length > 0, "falta el bloque condicionado a manualReviewActive")
  assert.match(manualReviewBlock, /No pudimos validar tu transferencia automáticamente\./)
  assert.match(manualReviewBlock, /Podés adjuntar el comprobante para que nuestro equipo lo revise\./)
  assert.match(manualReviewBlock, /<CustomerPaymentProof order=\{order\} onUploaded=\{onUpdated\} showHeading=\{false\} \/>/)
})

test("TransferPaymentSection: si el pedido ya tiene comprobante subido, muestra directamente el uploader existente (no el formulario de verificación)", () => {
  const sectionStart = SOURCE.indexOf("export function TransferPaymentSection")
  const sectionEnd = SOURCE.indexOf("\nfunction TransferAutoVerificationForm")
  const section = SOURCE.slice(sectionStart, sectionEnd)

  assert.match(section, /if \(hasProof \|\| alreadyResolved\) \{/)
  assert.match(section, /<CustomerPaymentProof order=\{order\} onUploaded=\{onUpdated\} showHeading=\{false\} expandUploader \/>/)
})

test("el formulario nunca envía el monto como único dato de confianza -- también viaja nombre/apellido/DNI declarados", () => {
  assert.match(SOURCE, /nombre: firstName/)
  assert.match(SOURCE, /apellido: lastName/)
  assert.match(SOURCE, /dni,/)
  assert.match(SOURCE, /monto: Number\(amount\)/)
})

test("un fallo técnico (rate limit, verificación en curso, error inesperado del backend, excepción de red) siempre habilita el comprobante como salida segura -- nunca deja al cliente sin ninguna opción", () => {
  const handleSubmit = SOURCE.slice(
    SOURCE.indexOf("const handleSubmit"),
    SOURCE.indexOf("return (", SOURCE.indexOf("const handleSubmit")),
  )

  // Camino !response.ok (429/409/500): sólo habilita el uploader si el
  // backend lo marcó disponible -- nunca incondicionalmente (eso rompería
  // el contrato de "pago ya confirmado -> no corresponde comprobante").
  assert.match(handleSubmit, /if \(!response\.ok\) \{[\s\S]*?if \(data\.proofUploadAvailable\) setManualReviewActive\(true\)/)
  // Camino catch (excepción de red / parseo): siempre habilita, no hay
  // forma de que el backend haya podido decir lo contrario.
  const catchBlock = handleSubmit.slice(handleSubmit.indexOf("} catch"))
  assert.match(catchBlock, /setManualReviewActive\(true\)/)
})
