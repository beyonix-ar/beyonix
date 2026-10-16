import assert from "node:assert/strict"
import test from "node:test"

import { andreaniShipmentCreated, dispatchError, dispatchStage, orderCode, parseOrderCode, readyForGeneralBundle } from "./dispatch.ts"
import { renderDispatchBarcode } from "./dispatch-barcode.ts"

// La resolución de la línea escaneada vive en scan_order_preparation_code
// (lib/orders/dispatch-db.test.ts); acá se validan los mensajes visibles.
test("mensajes de armado y lote", () => {
  assert.match(dispatchError({ message: "DISPATCH_QUANTITY_EXCEEDED" }), /Cantidad requerida ya completada/)
  assert.match(dispatchError({ message: "DISPATCH_WRONG_SKU_OR_VARIANT" }), /Este producto no pertenece al pedido/)
  assert.match(dispatchError({ message: "DISPATCH_CODE_UNKNOWN" }), /Código no reconocido/)
  assert.equal(dispatchError({ message: "DISPATCH_PARCELS_MISSING", details: "50" }), "BX-1050: Faltan escanear paquetes del pedido.")
  assert.equal(dispatchError({ message: "DISPATCH_PARCEL_OTHER_BATCH", details: "DSP-20261007-002" }), "Este paquete pertenece al Bulto general DSP-20261007-002.")
  assert.match(dispatchError({ message: "DISPATCH_ORDER_BLOCKED" }), /requiere revisión/)
})

test("Bulto general: mensajes con la etiqueta Andreani como identificación", () => {
  assert.equal(dispatchError({ message: "DISPATCH_ORDERS_UNVERIFIED", details: "8" }), "BX-1008: Faltan verificar pedidos del Bulto general.")
  assert.equal(dispatchError({ message: "DISPATCH_PREP_OTHER_BATCH", details: "DSP-20261016-002" }), "Este pedido pertenece al Bulto general DSP-20261016-002.")
  assert.equal(dispatchError({ message: "DISPATCH_VERIFY_NOT_EXPECTED", details: "99" }), "BX-1099: Este pedido no está en este Bulto general.")
  assert.match(dispatchError({ message: "DISPATCH_VERIFY_PARCEL_CODE" }), /etiqueta interna \(BX-PKG\).*etiqueta Andreani/)
  assert.match(dispatchError({ message: "DISPATCH_IDENTIFICATION_PENDING", details: "31" }), /^BX-1031: Falta imprimir la etiqueta Andreani/)
  assert.match(dispatchError({ message: "DISPATCH_SHIPMENT_PENDING", details: "31" }), /^BX-1031: Primero generá el envío Andreani/)
  assert.match(dispatchError({ message: "DISPATCH_ANDREANI_CODE_AMBIGUOUS" }), /más de un pedido/)
  assert.match(dispatchError({ message: "DISPATCH_ADJUSTMENT_BELOW_PICKED" }), /Ya pickeaste/)
  assert.match(dispatchError({ message: "DISPATCH_ADJUSTMENT_EMPTY_ORDER" }), /cancelación/)
  assert.doesNotMatch(dispatchError({ message: "DISPATCH_ADJUSTMENT_INVALID" }), /BX-PREP/)
})

test("etapas: pickeo completo → envío Andreani → etiqueta → listo para Bulto general", () => {
  const pkg = (patch: object = {}) => ({ status: "prepared" as const, identification_method: null, ...patch })
  assert.equal(dispatchStage({ package: pkg(), shipmentCreated: false }), "shipment", "pedido completo: falta el envío")
  assert.equal(dispatchStage({ package: pkg(), shipmentCreated: true }), "label", "envío generado: falta imprimir la etiqueta")
  assert.equal(dispatchStage({ package: pkg({ identification_method: "andreani" }), shipmentCreated: true }), "ready")
  assert.equal(dispatchStage({ package: pkg({ identification_method: "printed" }), shipmentCreated: false }), "shipment", "BX-PREP histórico sin envío")
  assert.equal(readyForGeneralBundle(pkg({ identification_method: "andreani" }), false), false, "sin envío no está listo")
  assert.equal(readyForGeneralBundle(pkg(), true), false, "sin etiqueta no está listo")
  assert.equal(readyForGeneralBundle(pkg({ identification_method: "andreani" }), true), true)
  assert.equal(readyForGeneralBundle({ status: "preparing", identification_method: null }, true), false, "pickeo incompleto nunca está listo")
  assert.equal(andreaniShipmentCreated({ andreani_envio_id: " AND-1 ", andreani_creation_status: "created" }), true)
  assert.equal(andreaniShipmentCreated({ andreani_envio_id: "AND-1", andreani_creation_status: "reconciliation_required" }), false)
})
test("pedido BX y barcode Code 128 conservan identificadores exactos", () => {
  assert.equal(orderCode(31), "BX-1031")
  assert.equal(parseOrderCode("BX-1031"), 31)
  assert.equal(parseOrderCode("BX-999"), null)
  const code = "DSP-20261005-001"
  const svg = renderDispatchBarcode(code)
  assert.match(svg, /^<svg\b/)
  assert.match(svg, /<path\b/)
  assert.notEqual(svg, renderDispatchBarcode("DSP-20261005-002"))
  assert.throws(() => renderDispatchBarcode("OTRO-001"), /inválido/)
})
