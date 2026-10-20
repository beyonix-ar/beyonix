import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./admin-claim-manager.tsx", import.meta.url), "utf8")

test("MercadoPagoRefundAction se usa exclusivamente para pedidos pagados por Mercado Pago", () => {
  assert.match(
    source,
    /canManageRefund && pedido\.payment_method_id === "mercadopago"[\s\S]{0,80}<MercadoPagoRefundAction pedido=\{pedido\} onUpdated=\{onInventoryUpdated\} \/>/,
  )
})

test("el flujo de comprobante manual (subir archivo + mark_refund_done) queda excluido para pedidos de Mercado Pago", () => {
  // Comprobante y cierre manual: dos acciones contextuales, ambas sólo fuera de Mercado Pago.
  const manualBlocks = [...source.matchAll(/canManageRefund && pedido\.payment_method_id !== "mercadopago"[\s\S]*?\n {16}\)\}/g)].map((match) => match[0])
  assert.equal(manualBlocks.length, 2)
  assert.match(manualBlocks[0], /uploadRefundProof/)
  assert.match(manualBlocks[1], /markRefundDone/)
})

test("transferencia (y cualquier medio no-MP) conserva el flujo manual sin cambios funcionales", () => {
  assert.match(source, /uploadRefundProof/)
  assert.match(source, /getPendingRefundNotes/)
})
