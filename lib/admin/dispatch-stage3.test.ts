import assert from "node:assert/strict"
import test from "node:test"

import { dispatchError, orderCode, parseOrderCode } from "./dispatch.ts"
import { renderDispatchBarcode } from "./dispatch-barcode.ts"

// La resolución de la línea escaneada vive en scan_order_preparation_code
// (lib/orders/dispatch-db.test.ts); acá se validan los mensajes visibles.
test("mensajes de armado y lote", () => {
  assert.match(dispatchError({ message: "DISPATCH_QUANTITY_EXCEEDED" }), /Cantidad requerida ya completada/)
  assert.match(dispatchError({ message: "DISPATCH_WRONG_SKU_OR_VARIANT" }), /Este producto no pertenece al pedido/)
  assert.match(dispatchError({ message: "DISPATCH_CODE_UNKNOWN" }), /Código no reconocido/)
  assert.equal(dispatchError({ message: "DISPATCH_PARCELS_MISSING", details: "50" }), "BX-1050: Faltan escanear bultos del pedido.")
  assert.equal(dispatchError({ message: "DISPATCH_PARCEL_OTHER_BATCH", details: "DSP-20261007-002" }), "Este bulto pertenece al lote DSP-20261007-002.")
  assert.match(dispatchError({ message: "DISPATCH_ORDER_BLOCKED" }), /requiere revisión/)
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
