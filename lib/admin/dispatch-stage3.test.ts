import assert from "node:assert/strict"
import test from "node:test"

import { dispatchError, orderCode, parseOrderCode, resolveScanLine, type DispatchLine } from "./dispatch.ts"
import { renderDispatchBarcode } from "./dispatch-barcode.ts"

const lines: DispatchLine[] = [
  { order_item_id: 1, expected_sku: "TRIPODE-NEGRO", expected_barcode: "779001", expected_quantity: 2, scanned_quantity: 1, product_id: 7, variant_id: 10, conditioned_stock_id: null },
  { order_item_id: 2, expected_sku: "TRIPODE-BLANCO", expected_barcode: "779002", expected_quantity: 1, scanned_quantity: 0, product_id: 7, variant_id: 11, conditioned_stock_id: null },
]

test("escaneo desde un solo campo distingue SKU, barcode, variante y exceso", () => {
  assert.equal(resolveScanLine(lines, "tripode-negro")?.order_item_id, 1)
  assert.equal(resolveScanLine(lines, "779002")?.order_item_id, 2)
  assert.equal(resolveScanLine(lines, "779003"), null)
  assert.equal(resolveScanLine(lines, "TRIPODE") , null)
  assert.equal(resolveScanLine([{ ...lines[0], scanned_quantity: 2 }], "779001")?.order_item_id, 1)
  assert.match(dispatchError({ message: "DISPATCH_QUANTITY_EXCEEDED" }), /cantidad requerida/)
  assert.match(dispatchError({ message: "DISPATCH_ORDER_BLOCKED" }), /requiere revisión/)
})

test("un SKU repetido se asigna a la primera línea incompleta", () => {
  const sameCode = [{ ...lines[0], scanned_quantity: 2 }, { ...lines[1], expected_sku: "TRIPODE-NEGRO" }]
  assert.equal(resolveScanLine(sameCode, "tripode-negro")?.order_item_id, 2)
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
