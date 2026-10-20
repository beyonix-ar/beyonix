import assert from "node:assert/strict"
import test from "node:test"
import { describeOrderManagementEvent, isOrderManagementEvent } from "./order-management-events.ts"

const formatAmount = (amount: number) => `$ ${amount}`

test("recepción de inventario: resumen legible, sin claves internas ni JSON", () => {
  const view = describeOrderManagementEvent({
    action: "return_inventory_processed",
    metadata: { productId: 1, remaining: 0, sourceKey: "order-item:9:return:x", variantId: 1, orderItemId: 9, soldQuantity: 1,
      sellableQuantity: 1, cumulativeReturned: 1, discountedQuantity: 0, nonSellableQuantity: 0 },
  }, { formatAmount, itemName: (id) => (id === 9 ? "Trípode Ñandú" : null) })
  assert.deepEqual(view, {
    title: "Inventario actualizado",
    facts: ["Producto: Trípode Ñandú", "1 unidad procesada", "Reingreso vendible: 1", "No vendible: 0", "Restante por procesar: 0"],
  })
  assert.doesNotMatch([view.title, ...view.facts].join(" "), /sourceKey|orderItemId|return_inventory_processed|[{}"]/)
})

test("con descuento y varias unidades; otros eventos muestran importe, destino y motivo", () => {
  const view = describeOrderManagementEvent({ action: "return_inventory_processed",
    metadata: { sellableQuantity: 1, discountedQuantity: 1, nonSellableQuantity: 1, remaining: 2 } }, { formatAmount })
  assert.deepEqual(view.facts, ["3 unidades procesadas", "Reingreso vendible: 1", "Reingreso con descuento: 1", "No vendible: 1", "Restante por procesar: 2"])
  assert.deepEqual(describeOrderManagementEvent({ action: "credit_note_authorized",
    metadata: { amount: 4500, destination: "customer_balance", reason: "Producto con falla", internalId: "abc" } }, { formatAmount }),
  { title: "Nota de crédito autorizada", facts: ["Importe: $ 4500", "Destino: saldo a favor del cliente", "Motivo: Producto con falla"] })
  assert.deepEqual(describeOrderManagementEvent({ action: "order_refunded", metadata: null }, { formatAmount }), { title: "Reintegro completado", facts: [] })
  assert.equal(isOrderManagementEvent("claim_shipment_delivered"), false)
  assert.equal(isOrderManagementEvent("customer_balance_settlement"), true)
})
