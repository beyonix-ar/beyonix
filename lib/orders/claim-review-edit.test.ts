import assert from "node:assert/strict"
import test from "node:test"

import { getClaimReviewEditability } from "./claim-review-edit.ts"

// Paso "Revisión": volver atrás permite CORREGIR la decisión sólo si no hubo
// efectos reales; con efectos se muestran y se bloquea. La base vuelve a
// validar cada cambio (mutate_admin_order_claim, reopen_rejected_order_claim).

const review = (overrides: Partial<Parameters<typeof getClaimReviewEditability>[0]> = {}) =>
  getClaimReviewEditability({ status: "aprobado", resolution: "cambio_producto", failureType: "falla", isAdmin: true, effects: [], ...overrides })

test("sin decidir: se decide normalmente", () => {
  for (const status of ["recibido", "en_revision", "falta_informacion"]) {
    assert.deepEqual([review({ status, resolution: null }).mode, review({ status, resolution: null }).current], ["decide", null])
  }
})

test("Corresponde sin efectos reales: editable, con la decisión actual marcada; puede pasar a No corresponde o cambiar la solución", () => {
  const edit = review()
  assert.deepEqual([edit.mode, edit.current, edit.canChangeSolution], ["edit", "approve", true])
  assert.deepEqual(edit.unavailableResolutions, ["reintegro_total"], "desde aprobado no se salta a reintegro pendiente")
  // Solución económica ya en curso: sólo se puede pasar a No corresponde (misma regla que la base).
  const economic = review({ status: "reintegro_pendiente", resolution: "reintegro_total" })
  assert.deepEqual([economic.mode, economic.canChangeSolution], ["edit", false])
  assert.equal(review({ resolution: "saldo_a_favor" }).canChangeSolution, false)
})

test("No corresponde sin efectos: se puede reabrir (con motivo); con efectos o sin permiso, no", () => {
  assert.deepEqual([review({ status: "rechazado", resolution: "rechazado" }).mode, review({ status: "rechazado", resolution: "rechazado" }).current], ["reopen", "reject"])
  assert.equal(review({ status: "rechazado", resolution: "rechazado", effects: ["Operación generada: Retiro por sucursal"] }).mode, "locked")
  assert.equal(review({ status: "rechazado", resolution: "rechazado", isAdmin: false }).mode, "readonly")
  assert.equal(review({ status: "rechazado", resolution: "rechazado", failureType: "cancelar_compra" }).mode, "readonly")
})

test("con efectos reales: bloqueado mostrando cuáles (sin duplicados ni vacíos)", () => {
  const locked = review({ effects: ["Stock reservado para el reemplazo: 1 unidad", false, null, "Stock reservado para el reemplazo: 1 unidad", "Recepción registrada"] })
  assert.deepEqual([locked.mode, locked.current], ["locked", "approve"])
  assert.deepEqual(locked.effects, ["Stock reservado para el reemplazo: 1 unidad", "Recepción registrada"])
  assert.equal(locked.canChangeSolution, false)
})

test("finalizado: sólo lectura", () => {
  assert.equal(review({ status: "cerrado" }).mode, "readonly")
})
