import assert from "node:assert/strict"
import test from "node:test"

import {
  ACTIVE_ORDER_CLAIM_STATUSES,
  getClaimFileValidationError,
  getOrderClaimTransitionError,
  isClaimFileSignatureMismatch,
  ORDER_CLAIM_FILE_MAX_BYTES,
  ORDER_CLAIM_IMAGE_MAX_BYTES,
  ORDER_CLAIM_STATUSES,
  ORDER_CLAIM_TRANSITIONS,
  ORDER_CLAIM_VIDEO_MAX_BYTES,
  POST_DELIVERY_CLAIM_REASONS,
  TERMINAL_ORDER_CLAIM_STATUSES,
} from "./order-claims.ts"

test("getOrderClaimTransitionError: primera revisión (recibido/en_revision/falta_informacion) admite las transiciones reales", () => {
  for (const from of ["recibido", "en_revision", "falta_informacion"]) {
    assert.equal(getOrderClaimTransitionError(from, "aprobado"), null, `${from} -> aprobado`)
    assert.equal(getOrderClaimTransitionError(from, "rechazado"), null, `${from} -> rechazado`)
    assert.equal(getOrderClaimTransitionError(from, "cerrado"), null, `${from} -> cerrado`)
  }
  // Sólo approveSolution con resolución reintegro_total salta directo acá.
  assert.equal(getOrderClaimTransitionError("recibido", "reintegro_pendiente"), null)
})

test("getOrderClaimTransitionError: aprobado sólo avanza a cupon_pendiente, cambio_pendiente, rechazado o cerrado", () => {
  assert.equal(getOrderClaimTransitionError("aprobado", "cupon_pendiente"), null)
  assert.equal(getOrderClaimTransitionError("aprobado", "cambio_pendiente"), null)
  assert.equal(getOrderClaimTransitionError("aprobado", "rechazado"), null)
  assert.equal(getOrderClaimTransitionError("aprobado", "cerrado"), null)
  // markAcceptedSolutionDone nunca manda "aprobado" directo a
  // reintegro_pendiente (sólo approveSolution lo hace, antes de "aprobado").
  assert.match(getOrderClaimTransitionError("aprobado", "reintegro_pendiente") ?? "", /No es posible/)
  assert.match(getOrderClaimTransitionError("aprobado", "en_revision") ?? "", /No es posible/)
})

test("getOrderClaimTransitionError: los estados de resolución pendiente (reintegro/cambio/cupón/reemplazo) sólo terminan", () => {
  for (const from of ["reintegro_pendiente", "cambio_pendiente", "cupon_pendiente", "reemplazo_enviado"]) {
    assert.equal(getOrderClaimTransitionError(from, "cerrado"), null, `${from} -> cerrado`)
    assert.equal(getOrderClaimTransitionError(from, "rechazado"), null, `${from} -> rechazado`)
    assert.match(getOrderClaimTransitionError(from, "recibido") ?? "", /No es posible/, `${from} -> recibido debe rechazarse`)
    assert.match(getOrderClaimTransitionError(from, "aprobado") ?? "", /No es posible/, `${from} -> aprobado debe rechazarse`)
  }
})

test("getOrderClaimTransitionError: un reclamo cerrado o rechazado no puede saltar a otro estado", () => {
  assert.match(getOrderClaimTransitionError("cerrado", "en_revision") ?? "", /finalizado/)
  assert.match(getOrderClaimTransitionError("cerrado", "recibido") ?? "", /finalizado/)
  assert.match(getOrderClaimTransitionError("rechazado", "aprobado") ?? "", /finalizado/)
  assert.match(getOrderClaimTransitionError("rechazado", "cerrado") ?? "", /finalizado/)
})

test("getOrderClaimTransitionError: reenviar el mismo estado (incluso terminal) es un no-op permitido (idempotencia)", () => {
  for (const status of ORDER_CLAIM_STATUSES) {
    assert.equal(getOrderClaimTransitionError(status, status), null, `${status} -> ${status}`)
  }
})

test("ORDER_CLAIM_TRANSITIONS: todo estado terminal tiene la lista vacía y todo estado activo tiene al menos un destino", () => {
  for (const status of TERMINAL_ORDER_CLAIM_STATUSES) {
    assert.deepEqual(ORDER_CLAIM_TRANSITIONS[status], [])
  }
  for (const status of ACTIVE_ORDER_CLAIM_STATUSES) {
    assert.ok(ORDER_CLAIM_TRANSITIONS[status].length > 0, `${status} debería tener transiciones válidas`)
  }
})

/**
 * Simula el mismo patrón compare-and-swap que ahora implementa
 * app/api/admin/order-claims/[claimId]/route.ts (path genérico y cada
 * acción específica): el UPDATE se condiciona al `status` leído momentos
 * antes de decidir la transición. Mismo enfoque que
 * lib/orders/refund-claim-concurrency.test.ts para `ordenes.financial_status`,
 * aplicado acá a order_claims.status.
 */
function conditionalClaimStatusUpdate(
  row: { id: number; status: string },
  expectedStatus: string,
  nextStatus: string,
) {
  if (row.status !== expectedStatus) return null

  row.status = nextStatus
  return { ...row }
}

test("concurrencia Admin: dos admins resolviendo el mismo reclamo -- como mucho uno gana el update", () => {
  const claim = { id: 1, status: "en_revision" }
  // Admin A y Admin B abrieron el reclamo y ambos leyeron "en_revision"
  // antes de decidir su acción.
  const staleRead = claim.status

  const resultA = conditionalClaimStatusUpdate(claim, staleRead, "aprobado")
  const resultB = conditionalClaimStatusUpdate(claim, staleRead, "rechazado")

  assert.ok(resultA !== null, "Admin A (el primero en escribir) gana el update")
  assert.equal(
    resultB,
    null,
    "Admin B pierde el update (0 filas afectadas) en vez de pisar la resolución de A",
  )
  assert.equal(claim.status, "aprobado")
})

test("concurrencia Admin: una acción basada en un snapshot viejo se rechaza aunque la transición en sí sea válida", () => {
  // El reclamo ya fue cerrado por otro admin entre que B lo abrió y decidió actuar.
  const claim = { id: 1, status: "cerrado" }
  const staleRead = "en_revision"

  const result = conditionalClaimStatusUpdate(claim, staleRead, "aprobado")

  assert.equal(result, null)
  assert.equal(claim.status, "cerrado")
})

test("getClaimFileValidationError: rechaza archivos vacíos", () => {
  const emptyFile = new File([], "vacio.png", { type: "image/png" })
  assert.match(getClaimFileValidationError(emptyFile), /vacío/)
})

test("getClaimFileValidationError: rechaza tipos no soportados", () => {
  const scriptFile = new File(["contenido"], "script.exe", { type: "application/x-msdownload" })
  assert.match(getClaimFileValidationError(scriptFile), /imagen, un video, un PDF/)
})

test("getClaimFileValidationError: respeta los límites de tamaño reales por tipo", () => {
  const oversizedImage = new File([new Uint8Array(ORDER_CLAIM_IMAGE_MAX_BYTES + 1)], "foto.png", { type: "image/png" })
  assert.match(getClaimFileValidationError(oversizedImage), /8 MB/)

  const okImage = new File([new Uint8Array(1024)], "foto.png", { type: "image/png" })
  assert.equal(getClaimFileValidationError(okImage), "")

  const oversizedVideo = new File([new Uint8Array(ORDER_CLAIM_VIDEO_MAX_BYTES + 1)], "video.mp4", { type: "video/mp4" })
  assert.match(getClaimFileValidationError(oversizedVideo), /40 MB/)

  const oversizedDoc = new File([new Uint8Array(ORDER_CLAIM_FILE_MAX_BYTES + 1)], "doc.pdf", { type: "application/pdf" })
  assert.match(getClaimFileValidationError(oversizedDoc), /10 MB/)
})

test("isClaimFileSignatureMismatch: acepta bytes reales de PNG y PDF declarados con su MIME real", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  assert.equal(isClaimFileSignatureMismatch(pngBytes, "image/png"), false)

  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
  assert.equal(isClaimFileSignatureMismatch(pdfBytes, "application/pdf"), false)
})

test("isClaimFileSignatureMismatch: detecta contenido que no coincide con el MIME declarado (spoofing)", () => {
  // Bytes de un archivo de texto plano ("<html>...") declarado como si fuera PNG.
  const fakeBytes = new TextEncoder().encode("<html><script>alert(1)</script>")
  assert.equal(isClaimFileSignatureMismatch(fakeBytes, "image/png"), true)
  assert.equal(isClaimFileSignatureMismatch(fakeBytes, "application/pdf"), true)
})

test("isClaimFileSignatureMismatch: rechaza firmas falsas de video y formatos no verificables", () => {
  const anyBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(isClaimFileSignatureMismatch(anyBytes, "video/mp4"), true)
  assert.equal(isClaimFileSignatureMismatch(anyBytes, "application/msword"), true)
  assert.equal(isClaimFileSignatureMismatch(anyBytes, "text/plain"), true)
})

test("evidencia: SVG, extensiones falsas, nombres manipulados y ejecutables fallan cerrados", () => {
  for (const [name,type] of [["x.svg","image/svg+xml"],["x.exe","image/jpeg"],["../x.jpg","image/jpeg"],["x.jpg\u0000.exe","image/jpeg"],["x.docx","application/vnd.openxmlformats-officedocument.wordprocessingml.document"]]) {
    assert.ok(getClaimFileValidationError(new File(["<script>alert(1)</script>"],name,{type})))
  }
  for (const type of ["image/jpeg","image/png","image/gif","image/webp","application/pdf","video/mp4","video/webm","video/quicktime"]) {
    assert.equal(isClaimFileSignatureMismatch(new TextEncoder().encode("MZ<html><script>alert(1)</script>"),type),true)
  }
})

test("isClaimFileSignatureMismatch: WEBP exige la marca RIFF....WEBP en offset real", () => {
  const realWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  assert.equal(isClaimFileSignatureMismatch(realWebp, "image/webp"), false)

  const fakeWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(isClaimFileSignatureMismatch(fakeWebp, "image/webp"), true)
})

test("POST_DELIVERY_CLAIM_REASONS: incluye exactamente los motivos que valida el servidor (fuente única)", () => {
  assert.deepEqual(
    [...POST_DELIVERY_CLAIM_REASONS].sort(),
    ["cantidad_menor", "danado", "falla", "faltante", "incorrecto", "otro"].sort(),
  )
})
