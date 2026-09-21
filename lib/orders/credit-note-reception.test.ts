import assert from "node:assert/strict"
import test from "node:test"

import {
  getAvailableToCreditQuantity,
  getReceptionApprovalGateError,
  getReceptionExceptionError,
} from "./credit-note-reception.ts"

// Auditoría 4/7, cierre de validación: casos N/O/P/Q pendientes del reporte
// anterior. credit-note/route.ts depende de ARCA y de una sesión admin real
// (no hay staging ni Docker en esta sesión para levantarlo entero), así que
// se valida con ejecución real la lógica pura que extrae exactamente esas
// reglas -- no una reimplementación ni un mock.

test("O. recepción física antes de refund/NC: con receptionApproved=true, la NC puede seguir (camino normal, sin necesitar excepción)", () => {
  assert.equal(getReceptionApprovalGateError(true, false), null)
})

test("N. refund/NC antes de la recepción física: sin excepción, se bloquea con 409", () => {
  const error = getReceptionApprovalGateError(false, false)
  assert.match(error ?? "", /bloqueada hasta recibir y aprobar/)
})

test("N. refund/NC antes de la recepción física CON excepción explícita: se permite pasar el gate (la excepción existe para esto)", () => {
  assert.equal(getReceptionApprovalGateError(false, true), null)
})

test("Q. reception_exception=true sin motivo: rechazado", () => {
  const error = getReceptionExceptionError(true, null)
  assert.match(error ?? "", /motivo de la excepción administrativa/)
})

test("Q. reception_exception=true con motivo demasiado corto (< 10 caracteres): rechazado", () => {
  const error = getReceptionExceptionError(true, "muy corto")
  assert.match(error ?? "", /mínimo 10 caracteres/)
})

test("Q. reception_exception=true con motivo válido: se acepta -- no hay bypass silencioso, siempre exige texto real", () => {
  assert.equal(
    getReceptionExceptionError(true, "Producto irrecuperable, cortesía autorizada por gerencia"),
    null,
  )
})

test("reception_exception=false: nunca exige motivo (la excepción no se está usando)", () => {
  assert.equal(getReceptionExceptionError(false, null), null)
})

test("P. NC no puede superar lo físicamente recibido: disponible = recibido - ya comprometido por otras NC", () => {
  // 3 unidades recibidas, 0 comprometidas todavía -- las 3 están disponibles.
  assert.equal(getAvailableToCreditQuantity(3, 0), 3)
  // 3 recibidas, 1 ya comprometida por otra NC processing/authorized -- quedan 2.
  assert.equal(getAvailableToCreditQuantity(3, 1), 2)
  // 3 recibidas, las 3 ya comprometidas -- no queda nada, un intento de
  // acreditar más debe rechazarse (item.quantity > 0 > disponible=0).
  assert.equal(getAvailableToCreditQuantity(3, 3), 0)
})

test("P. el disponible nunca es negativo aunque lo comprometido supere lo recibido (defensivo, no debería pasar)", () => {
  assert.equal(getAvailableToCreditQuantity(2, 5), 0)
})
