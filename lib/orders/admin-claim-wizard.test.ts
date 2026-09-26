import assert from "node:assert/strict"
import test from "node:test"
import { getAdminClaimWizard } from "./admin-claim-wizard"

const view = (status: string, resolution: string | null, receivedUnits = 0, replacedUnits: number | null = 0) =>
  getAdminClaimWizard({ status, resolution, receivedUnits, replacedUnits })

test("un reclamo nuevo abre Revisión y muestra próximos pasos bloqueados", () => {
  const wizard = view("recibido", null)
  assert.equal(wizard.current, "review")
  assert.deepEqual(wizard.steps.map((step) => step.key), ["review", "next", "finish"])
})

test("un cambio aprobado exige recepción antes del reemplazo", () => {
  const wizard = view("aprobado", "cambio_producto")
  assert.equal(wizard.current, "reception")
  assert.deepEqual(wizard.steps.map((step) => step.key), ["review", "reception", "replacement", "execution", "finish"])
})

test("la recepción parcial permite preparar reemplazo; el paso recibido sigue accesible", () => {
  const wizard = view("aprobado", "cambio_producto", 1)
  assert.equal(wizard.current, "replacement")
  assert.equal(wizard.currentIndex, 2)
})

test("el reemplazo registrado conduce a entrega", () => {
  assert.equal(view("aprobado", "cambio_producto", 1, 1).current, "execution")
})

test("unidad faltante omite recepción", () => {
  const wizard = view("aprobado", "envio_unidad_faltante")
  assert.equal(wizard.current, "replacement")
  assert.equal(wizard.steps.some((step) => step.key === "reception"), false)
})

test("reembolso y nota de crédito sólo muestran su aplicación", () => {
  assert.deepEqual(view("reintegro_pendiente", "reintegro_total").steps.map((step) => step.label),
    ["Revisión", "Reintegro", "Finalización"])
  assert.equal(view("aprobado", "cupon_descuento").current, "execution")
})

test("rechazo y cierre terminan en Finalización", () => {
  assert.equal(view("rechazado", "rechazado").current, "finish")
  assert.equal(view("cerrado", "cambio_producto", 1, 1).current, "finish")
  assert.equal(view("reemplazo_enviado", "envio_unidad_faltante", 0, 1).current, "finish")
})
