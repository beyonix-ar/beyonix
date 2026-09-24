import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const SOURCE = readFileSync("components/checkout/transfer-flow.tsx", "utf8")

test("reutiliza el uploader de comprobante existente -- no reimplementa una segunda subida", () => {
  assert.match(SOURCE, /import \{ CustomerPaymentProof \} from "@\/components\/customer-payment-proof"/)
  assert.match(SOURCE, /import \{ PaymentProofUploader \} from "@\/components\/payment-proof-uploader"/)
  // Nunca reimplementa el bucket/validación de comprobantes -- eso vive
  // exclusivamente en lib/payments/transfer.ts y app/api/payment-proofs.
  assert.doesNotMatch(SOURCE, /PAYMENT_PROOF_BUCKET/)
  assert.doesNotMatch(SOURCE, /getPaymentProofValidationError/)
  assert.doesNotMatch(SOURCE, /\.storage\.from\(/)
})

test("un fallo técnico (rate limit, verificación en curso, error inesperado del backend, excepción de red) siempre habilita el comprobante como salida segura -- nunca deja al cliente sin ninguna opción", () => {
  const handleSubmit = SOURCE.slice(
    SOURCE.indexOf("const handleSubmit"),
    SOURCE.indexOf("if (phase === \"confirming\")"),
  )

  // Camino !response.ok (400/429/409/500): sólo pasa a revisión manual si el
  // backend lo marcó disponible -- nunca incondicionalmente (eso rompería el
  // contrato de "pago ya confirmado -> no corresponde comprobante").
  assert.match(
    handleSubmit,
    /if \(!response\.ok\) \{[\s\S]*?if \(data\.proofUploadAvailable\) \{[\s\S]*?onManualReview\(\)/,
  )
  // Camino catch (excepción de red / parseo): siempre pasa a revisión
  // manual, no hay forma de que el backend haya podido decir lo contrario.
  const catchBlock = handleSubmit.slice(handleSubmit.indexOf("} catch"))
  assert.match(catchBlock, /onManualReview\(\)/)
})

test("el formulario envía los 4 datos obligatorios del titular ya validados (nombre, apellido, DNI/CUIT y monto)", () => {
  assert.match(SOURCE, /const declaration = validateTransferDeclaration\(\{/)
  assert.match(SOURCE, /nombre: declaration\.value\.firstName/)
  assert.match(SOURCE, /apellido: declaration\.value\.lastName/)
  assert.match(SOURCE, /dni: declaration\.value\.document/)
  // Texto crudo: el servidor lo lee con el parser es-AR ("1.500,50").
  assert.match(SOURCE, /monto: amount,/)
  assert.doesNotMatch(SOURCE, /\(opcional\)/)
})

test("si el pedido ya tiene comprobante subido o el pago ya fue resuelto, el flujo muestra el paso de revisión (no el formulario de verificación)", () => {
  const flowStart = SOURCE.indexOf("function TransferStepFlow")
  const flow = SOURCE.slice(flowStart)

  assert.match(flow, /const hasProof = Boolean\(order\.payment_proof_url \|\| order\.payment_proof_uploaded_at\)/)
  assert.match(flow, /const alreadyResolved = !TRANSFER_ELIGIBLE_PAYMENT_STATUSES\.includes\(/)
  assert.match(flow, /const effectiveStep = hasProof \|\| alreadyResolved \? "review" : step/)
})

test("el paso de revisión manual, una vez que ya existe comprobante, reutiliza el uploader existente completo (no un uploader paralelo)", () => {
  const stepStart = SOURCE.indexOf("function TransferManualReviewStep")
  const stepEnd = SOURCE.indexOf("function TransferVerificationSuccess")
  const step = SOURCE.slice(stepStart, stepEnd)

  assert.match(
    step,
    /<CustomerPaymentProof order=\{order\} onUploaded=\{onUpdated\} showHeading=\{false\} expandUploader \/>/,
  )
})
