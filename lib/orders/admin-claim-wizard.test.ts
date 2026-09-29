import assert from "node:assert/strict"
import test from "node:test"
import { getAdminClaimWizard, getCancelledClaimOccurredSteps } from "./admin-claim-wizard"

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

test("un reclamo finalizado normalmente marca los pasos previos como completados", () => {
  const wizard = getAdminClaimWizard({ status: "cerrado", resolution: "cambio_producto", receivedUnits: 1, replacedUnits: 1 })
  assert.deepEqual(wizard.steps.map((step) => [step.label, step.status]),
    [["Revisión", "done"], ["Recepción", "done"], ["Reemplazo", "done"], ["Entrega", "done"], ["Finalización", "open"]])
})

test("la recepción parcial no se marca completada aunque el flujo avance", () => {
  const wizard = getAdminClaimWizard({ status: "aprobado", resolution: "cambio_producto", receivedUnits: 1, replacedUnits: 0, receptionComplete: false })
  assert.equal(wizard.steps.find((step) => step.key === "reception")?.status, "open")
})

test("cancelado después de recibir: conserva lo ocurrido, lo demás no se realizó y el cierre dice Cancelado", () => {
  const wizard = getAdminClaimWizard({
    status: "cerrado", resolution: "cambio_producto", receivedUnits: 1, replacedUnits: 0, cancelled: true,
    occurred: getCancelledClaimOccurredSteps({ resolution: "cambio_producto", receivedUnits: 1 }),
  })
  assert.equal(wizard.current, "finish")
  assert.deepEqual(wizard.steps.map((step) => [step.label, step.status]),
    [["Revisión", "done"], ["Recepción", "done"], ["Reemplazo", "skipped"], ["Entrega", "skipped"], ["Cancelado", "cancelled"]])
  assert.equal(wizard.steps.some((step) => step.label === "Finalización"), false, "nunca parece una finalización normal")
})

test("cancelado antes de decidir: la revisión no figura como completada", () => {
  const wizard = getAdminClaimWizard({
    status: "cerrado", resolution: null, receivedUnits: 0, replacedUnits: 0, cancelled: true,
    occurred: getCancelledClaimOccurredSteps({ resolution: null, receivedUnits: 0 }),
  })
  assert.deepEqual(wizard.steps.map((step) => [step.label, step.status]), [["Revisión", "skipped"], ["Cancelado", "cancelled"]])
})

test("cancelado con logística: método y operación sólo figuran si ocurrieron realmente", () => {
  const occurred = getCancelledClaimOccurredSteps({
    resolution: "cambio_producto", logisticsPlan: "retiro_y_reenvio", receivedUnits: 0,
    shipments: [{ creation_status: "created", status: "entregada" }],
    units: [{ role: "original", location: "baja" }, { role: "original", location: "conservada_cliente" }, { role: "reemplazo", location: "reincorporada_stock" }],
  })
  assert.deepEqual(occurred, { review: true, method: true, logistics: true, reception: true, replacement: false })
  const pendingOnly = getCancelledClaimOccurredSteps({
    resolution: "cambio_producto", logisticsPlan: "cambio_directo", receivedUnits: 0,
    shipments: [{ creation_status: "not_started", status: "cancelada" }],
    units: [{ role: "original", location: "conservada_cliente" }],
  })
  assert.deepEqual(pendingOnly, { review: true, method: true, logistics: false, reception: false, replacement: false })
  const wizard = getAdminClaimWizard({
    status: "cerrado", resolution: "cambio_producto", receivedUnits: 0, replacedUnits: 0, cancelled: true, occurred: pendingOnly,
    logistics: { plan: "cambio_directo", step: "logistics" },
  })
  assert.deepEqual(wizard.steps.map((step) => [step.label, step.status]),
    [["Revisión", "done"], ["Método", "done"], ["Cambio en sucursal", "skipped"], ["Recepción", "skipped"], ["Cancelado", "cancelled"]])
})

test("un rechazo no se presenta como cancelación", () => {
  const wizard = getAdminClaimWizard({ status: "rechazado", resolution: "rechazado", receivedUnits: 0, replacedUnits: 0, cancelled: true })
  assert.equal(wizard.steps.at(-1)?.label, "Finalización")
  assert.equal(wizard.steps.some((step) => step.status === "cancelled"), false)
})
