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
  const verification = SOURCE.slice(
    SOURCE.indexOf("function useTransferVerification("),
    SOURCE.indexOf("function TransferVerificationFailedModal("),
  )
  // El comprobante se ofrece salvo que el servidor lo niegue explícitamente
  // (pago ya confirmado o pedido que no es por transferencia).
  assert.match(verification, /proofUploadAvailable: data\?\.proofUploadAvailable !== false/)
  // Excepción de red / parseo: modal con el comprobante disponible, sin
  // pasar a revisión manual por su cuenta.
  const catchBlock = verification.slice(verification.indexOf("} catch"))
  assert.match(catchBlock, /fail\("error", "No pudimos conectarnos para verificar tu transferencia\."\)/)
})

test("un resultado pendiente respeta la espera del servidor antes de volver a verificar", () => {
  assert.match(SOURCE, /setCooldownSeconds\(Number\.isFinite\(wait\) \? Math\.max\(0, Math\.ceil\(wait\)\) : 0\)/)
  assert.match(SOURCE, /disabled=\{verifying \|\| cooldownSeconds > 0\}/)
  assert.match(SOURCE, /Podés volver a verificar en \$\{cooldownSeconds\} s/)
})

test("valida con los 4 datos obligatorios ya declarados (titular del paso 1 + importe del servidor), sin un segundo formulario", () => {
  assert.match(SOURCE, /const declaration = validateTransferDeclaration\(\{\s*nombre: holder\?\.firstName,\s*apellido: holder\?\.lastName,\s*dni: holder\?\.document,\s*monto: transferAmountDue\(order\),/)
  assert.match(SOURCE, /nombre: declaration\.value\.firstName/)
  assert.match(SOURCE, /apellido: declaration\.value\.lastName/)
  assert.match(SOURCE, /dni: declaration\.value\.document/)
  assert.match(SOURCE, /monto: declaration\.value\.amount/)
  assert.doesNotMatch(SOURCE, /\(opcional\)/)
  // El paso que volvía a pedir nombre, apellido, DNI/CUIT y monto ya no existe.
  assert.doesNotMatch(SOURCE, /function TransferVerificationStep\(|transfer-verify-|Validá tu transferencia|Monto exacto transferido/)
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
