import assert from "node:assert/strict"
import test from "node:test"

import { shareUnchanged } from "./structural-sharing.ts"

const pedido = () => ({
  id: 500,
  estado: "entregado",
  orden_items: [
    { id: 71, cantidad: 1, productos: { id: 1, nombre: "Auricular Ñandú", stock: 4 } },
    { id: 72, cantidad: 3, productos: { id: 2, nombre: "Parlante Güemes", stock: 10 } },
  ],
  order_claims: [
    {
      id: 900,
      updated_at: "2026-09-20T10:00:00Z",
      affected_items: [{ order_item_id: 71, quantity: 1 }],
      order_claim_files: [{ id: 1, signedUrl: "https://firmada/a" }],
      order_claim_messages: [{ id: 1, message: "Hola" }],
    },
  ],
})

test("refetch idéntico: devuelve exactamente la referencia anterior", () => {
  const previous = pedido()
  assert.equal(shareUnchanged(previous, pedido()), previous)
  const list = [previous]
  assert.equal(shareUnchanged(list, [pedido()]), list)
})

test("URL firmada nueva: sólo cambia ese subárbol; affected_items y mensajes conservan identidad", () => {
  const previous = pedido()
  const next = pedido()
  next.order_claims[0].order_claim_files[0].signedUrl = "https://firmada/b"
  const shared = shareUnchanged(previous, next)
  assert.notEqual(shared, previous)
  assert.notEqual(shared.order_claims[0], previous.order_claims[0])
  assert.equal(shared.order_claims[0].affected_items, previous.order_claims[0].affected_items)
  assert.equal(shared.order_claims[0].order_claim_messages, previous.order_claims[0].order_claim_messages)
  assert.equal(shared.orden_items, previous.orden_items)
  assert.equal(shared.order_claims[0].order_claim_files[0].signedUrl, "https://firmada/b")
})

test("cambio de stock: sólo cambia el ítem afectado", () => {
  const previous = pedido()
  const next = pedido()
  next.orden_items[0].productos.stock = 9
  const shared = shareUnchanged(previous, next)
  assert.notEqual(shared.orden_items, previous.orden_items)
  assert.notEqual(shared.orden_items[0], previous.orden_items[0])
  assert.equal(shared.orden_items[1], previous.orden_items[1])
  assert.equal(shared.orden_items[0].productos.stock, 9)
  assert.equal(shared.order_claims, previous.order_claims)
})

test("entidades con id se emparejan por id aunque cambie el orden o se agregue una fila", () => {
  const previous = pedido()
  const next = pedido()
  next.orden_items.reverse()
  next.orden_items.push({ id: 73, cantidad: 1, productos: { id: 3, nombre: "Cable", stock: 1 } })
  const shared = shareUnchanged(previous, next)
  assert.deepEqual(shared.orden_items.map((item) => item.id), [72, 71, 73])
  assert.equal(shared.orden_items[0], previous.orden_items[1])
  assert.equal(shared.orden_items[1], previous.orden_items[0])
})

test("claves agregadas o quitadas y valores null producen un objeto nuevo con el contenido de next", () => {
  const previous: Record<string, unknown> = { id: 1, estado: "pagado", tracking: null }
  const added = shareUnchanged(previous, { id: 1, estado: "pagado", tracking: null, nota: "x" })
  assert.notEqual(added, previous)
  assert.deepEqual(added, { id: 1, estado: "pagado", tracking: null, nota: "x" })
  const removed = shareUnchanged(previous, { id: 1, estado: "pagado" })
  assert.deepEqual(removed, { id: 1, estado: "pagado" })
  assert.equal(shareUnchanged(null, previous), previous)
})

test("ids duplicados o ausentes: se comparan por posición sin perder contenido", () => {
  const previous = [{ id: 1, v: "a" }, { id: 1, v: "b" }]
  const next = [{ id: 1, v: "a" }, { id: 1, v: "c" }]
  const shared = shareUnchanged(previous, next)
  assert.equal(shared[0], previous[0])
  assert.deepEqual(shared, next)
})
