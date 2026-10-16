import assert from "node:assert/strict"
import test from "node:test"

import { dispatchError, dispatchStage, orderCode, parseOrderCode, readyForGeneralBundle } from "./dispatch.ts"
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

test("Bulto general: mensajes de verificación BX-PREP e identificación física", () => {
  assert.equal(dispatchError({ message: "DISPATCH_ORDERS_UNVERIFIED", details: "8" }), "BX-1008: Faltan verificar pedidos del Bulto general.")
  assert.equal(dispatchError({ message: "DISPATCH_PREP_OTHER_BATCH", details: "DSP-20261016-002" }), "Este pedido pertenece al Bulto general DSP-20261016-002.")
  assert.equal(dispatchError({ message: "DISPATCH_VERIFY_NOT_EXPECTED", details: "99" }), "BX-1099: Este pedido no está en este Bulto general.")
  assert.match(dispatchError({ message: "DISPATCH_VERIFY_PARCEL_CODE" }), /paquete de envío \(BX-PKG\).*BX-PREP/)
  assert.match(dispatchError({ message: "DISPATCH_IDENTIFICATION_PENDING", details: "31" }), /^BX-1031: Falta la identificación física/)
  assert.match(dispatchError({ message: "DISPATCH_PREP_STALE", details: "31" }), /BX-PREP anterior/)
})

test("etapas: pedido preparado → identificación BX-PREP → medidas del paquete → listo para Bulto general", () => {
  const pkg = (patch: object) => ({ status: "prepared" as const, parcel_count: 1, identification_method: null, ...patch })
  assert.equal(dispatchStage({ package: pkg({ parcel_count: null }) }), "identify", "primero la identificación")
  assert.equal(dispatchStage({ package: pkg({}) }), "identify", "histórico con paquetes pero sin identificar")
  assert.equal(dispatchStage({ package: pkg({ parcel_count: null, identification_method: "printed" }) }), "measures")
  assert.equal(dispatchStage({ package: pkg({ identification_method: "manual" }) }), "parcels_ready")
  assert.equal(readyForGeneralBundle(pkg({})), false, "sin identificación no está listo")
  assert.equal(readyForGeneralBundle(pkg({ identification_method: "printed" })), true)
  assert.equal(readyForGeneralBundle(pkg({ identification_method: "printed", parcel_count: null })), false)
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
