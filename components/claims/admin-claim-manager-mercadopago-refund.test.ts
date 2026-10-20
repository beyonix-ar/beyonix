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
  assert.match(source, /canManageRefund && pedido\.payment_method_id !== "mercadopago" && getPendingRefundNotes\(pedido\.order_credit_notes\)\.length > 0 &&\s*renderRefundProofUpload\(\)\}/)
  assert.match(source, /canManageRefund && pedido\.payment_method_id !== "mercadopago" && closeReadiness\?\.action === "mark_refund_done"[\s\S]{0,600}run: markRefundDone/)
  // Un solo bloque de comprobante (también para las unidades a reintegrar de un reclamo mixto).
  assert.match(source, /const renderRefundProofUpload = \(\) => \([\s\S]{0,1600}run: uploadRefundProof/)
  // Reclamo mixto: mismo criterio, Mercado Pago nunca pasa por el comprobante manual.
  assert.match(source, /: pedido\.payment_method_id === "mercadopago"\s*\? <MercadoPagoRefundAction pedido=\{pedido\} onUpdated=\{onInventoryUpdated\} \/>\s*: renderRefundProofUpload\(\)\)\}/)
})

test("transferencia (y cualquier medio no-MP) conserva el flujo manual sin cambios funcionales", () => {
  assert.match(source, /uploadRefundProof/)
  assert.match(source, /getPendingRefundNotes/)
})
