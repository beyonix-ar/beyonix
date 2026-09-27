import assert from "node:assert/strict"
import test from "node:test"

import {
  invoiceRetryDelayMinutes,
  processArcaInvoice,
  processArcaInvoiceQueue,
} from "./invoice-automation.ts"
import { getInvoiceFiscalStatusView } from "./invoice-status-view.ts"
import {
  FakeArca,
  confirmOrder,
  insertOrder,
  loadOrder,
  rpcClient,
  setupInvoicingDb,
} from "./fixtures/arca-invoicing-db.ts"

// Servicio de facturación (worker + botón Admin) contra la migración real y
// un ARCA simulado con numeración secuencial. Nunca dos facturas por venta.

const POINT = 3
const now = () => new Date("2026-09-27T15:00:00-03:00")
const options = (arca: FakeArca, extra: Record<string, unknown> = {}) => ({ gateway: arca, pointOfSale: POINT, now, ...extra })

test("C/E. confirmación repetida (webhook MP, transferencia confirmada dos veces) -> una sola factura", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT)
  try {
    const mp = await insertOrder(db, { payment_method_id: "mercadopago", total: 1500 })
    const transfer = await insertOrder(db, { payment_method_id: "transferencia", total: 900 })
    for (let index = 0; index < 3; index += 1) {
      await confirmOrder(db, mp, "approved")
      await confirmOrder(db, transfer, "confirmado")
    }
    const client = rpcClient(db)
    const summary = await processArcaInvoiceQueue(client, options(arca))
    assert.equal(summary.authorized, 2)
    // Cron repetido / refresh: no hay más nada que facturar.
    assert.equal((await processArcaInvoiceQueue(client, options(arca))).authorized, 0)
    assert.deepEqual(await processArcaInvoice(client, options(arca, { orderId: mp, manual: true })), { status: "already_authorized" })
    assert.equal(arca.vouchers.size, 2)
    const mpOrder = await loadOrder(db, mp)
    assert.equal(mpOrder.invoice_status, "authorized")
    assert.equal(Number(mpOrder.invoice_point), POINT)
    assert.equal(Number(mpOrder.invoice_voucher_type), 11)
    assert.ok(mpOrder.invoice_cae && mpOrder.invoice_cae_due)
    assert.equal(arca.vouchers.get(Number(mpOrder.invoice_number))?.total, 1500, "importe = total de la venta")
  } finally {
    await db.close()
  }
})

test("saldo a favor 100%: se factura igual que cualquier venta confirmada", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT)
  try {
    const id = await insertOrder(db, { payment_method_id: "customer_credit", payment_status: "pending_credit", total: 700 })
    await confirmOrder(db, id, "confirmado")
    const result = await processArcaInvoice(rpcClient(db), options(arca))
    assert.equal(result.status, "authorized")
    assert.equal((await loadOrder(db, id)).invoice_status, "authorized")
  } finally {
    await db.close()
  }
})

test("B. ARCA autoriza pero la respuesta se pierde -> el reintento reconcilia y NO pide otro número", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT)
  try {
    const id = await insertOrder(db, { total: 2300 })
    await confirmOrder(db, id)
    arca.next.push("lost_after_authorize")
    const client = rpcClient(db)
    const first = await processArcaInvoice(client, options(arca))
    assert.equal(first.status, "failed")
    const afterLoss = await loadOrder(db, id)
    assert.equal(afterLoss.invoice_status, "error")
    assert.equal(Number(afterLoss.invoice_requested_number), 1, "el número pedido queda para reconciliar")
    assert.equal(afterLoss.estado, "pagado", "el pedido sigue confirmado")
    assert.equal(arca.vouchers.size, 1, "ARCA sí lo autorizó")

    // Reintento manual inmediato (sin esperar el backoff).
    const retry = await processArcaInvoice(client, options(arca, { orderId: id, manual: true }))
    assert.equal(retry.status, "authorized")
    assert.equal(retry.status === "authorized" && retry.invoice.reconciled, true)
    assert.equal(arca.requests, 1, "nunca se volvió a pedir CAE")
    assert.equal(arca.vouchers.size, 1, "una sola factura en ARCA")
    const order = await loadOrder(db, id)
    assert.equal(Number(order.invoice_number), 1)
    assert.equal(order.invoice_cae, arca.vouchers.get(1)?.cae)
  } finally {
    await db.close()
  }
})

test("B'. ARCA autorizó y falló GUARDAR en la base (reinicio) -> lease vencido, reconciliación, una factura", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT)
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    const crashing = rpcClient(db, {
      beforeRpc(name) {
        if (name === "complete_arca_invoice" || name === "fail_arca_invoice_attempt") {
          throw new Error("connection terminated")
        }
      },
    })
    await assert.rejects(processArcaInvoice(crashing, options(arca)).then((result) => {
      if (result.status !== "failed") throw new Error("esperaba fallo")
      throw new Error("worker caído")
    }), /worker caído/)
    assert.equal((await loadOrder(db, id)).invoice_status, "processing", "quedó colgado como si el servidor se reiniciara")
    await db.query("update ordenes set invoice_processing_started_at = now() - interval '11 minutes' where id=$1", [id])

    const result = await processArcaInvoice(rpcClient(db), options(arca))
    assert.equal(result.status, "authorized")
    assert.equal(arca.requests, 1)
    assert.equal(arca.vouchers.size, 1)
  } finally {
    await db.close()
  }
})

test("F. ARCA caída: el pedido sigue pagado, queda 'facturación pendiente' con reintento y se emite al volver", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT)
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    arca.down = true
    const client = rpcClient(db)
    const result = await processArcaInvoice(client, options(arca))
    assert.equal(result.status, "failed")
    assert.equal(result.status === "failed" && result.willRetry, true)
    const order = await loadOrder(db, id)
    assert.equal(order.estado, "pagado")
    assert.equal(order.financial_status, "payment_confirmed")
    assert.equal(order.payment_status, "approved")
    assert.equal(order.invoice_status, "error")
    assert.match(String(order.invoice_error), /HTTP 503/)
    assert.equal(order.invoice_requested_number, null, "falló antes de pedir CAE: no hay nada que reconciliar")
    const view = getInvoiceFiscalStatusView(order as never)
    assert.equal(view?.state, "error")
    assert.match(view?.title ?? "", /Pago confirmado · Facturación con error/)
    assert.match(view?.description ?? "", /Se reintenta automáticamente/)

    // Backoff: el cron no lo retoma antes de tiempo.
    assert.equal((await processArcaInvoiceQueue(client, options(arca))).results.length, 0)
    arca.down = false
    await db.query("update ordenes set invoice_next_attempt_at = now() - interval '1 second' where id=$1", [id])
    assert.equal((await processArcaInvoiceQueue(client, options(arca))).authorized, 1)
    assert.equal(arca.vouchers.size, 1)
  } finally {
    await db.close()
  }
})

test("rechazo definitivo de ARCA: libera el número y el reintento pide uno nuevo sin duplicar", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT)
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    arca.next.push("reject")
    const client = rpcClient(db)
    assert.equal((await processArcaInvoice(client, options(arca))).status, "failed")
    assert.equal((await loadOrder(db, id)).invoice_requested_number, null)
    assert.equal((await processArcaInvoice(client, options(arca, { orderId: id, manual: true }))).status, "authorized")
    assert.equal(arca.vouchers.size, 1)
  } finally {
    await db.close()
  }
})

test("reconciliación: el número pedido no llegó a autorizarse -> se pide de nuevo; existe con otros datos -> revisión manual", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT)
  try {
    const id = await insertOrder(db, { total: 1000 })
    await confirmOrder(db, id)
    arca.next.push("down")
    const client = rpcClient(db)
    await processArcaInvoice(client, options(arca))
    assert.equal(Number((await loadOrder(db, id)).invoice_requested_number), 1)
    const ok = await processArcaInvoice(client, options(arca, { orderId: id, manual: true }))
    assert.equal(ok.status, "authorized", "ARCA no lo tenía: se liberó y se emitió")
    assert.equal(arca.vouchers.size, 1)

    // Otro pedido cuyo número pedido existe en ARCA con OTRO importe.
    const other = await insertOrder(db, { total: 500 })
    await confirmOrder(db, other)
    arca.next.push("down")
    await processArcaInvoice(client, options(arca))
    arca.vouchers.set(2, { total: 999, cae: "X", caeDue: "20261010", date: "20260927" })
    const mismatch = await processArcaInvoice(client, options(arca, { orderId: other, manual: true }))
    assert.equal(mismatch.status, "failed")
    assert.equal(mismatch.status === "failed" && mismatch.willRetry, false)
    const order = await loadOrder(db, other)
    assert.equal(order.invoice_next_attempt_at, null, "sin reintento automático")
    assert.match(String(order.invoice_error), /Revisión manual/)
    assert.equal(order.invoice_cae, null, "nunca adopta un comprobante ajeno")

    // Mismo número e importe pero otra fecha: tampoco es esta venta.
    const sameTotal = await insertOrder(db, { total: 700 })
    await confirmOrder(db, sameTotal)
    arca.next.push("down")
    await processArcaInvoice(client, options(arca, { orderId: sameTotal, manual: true }))
    const requested = Number((await loadOrder(db, sameTotal)).invoice_requested_number)
    arca.vouchers.set(requested, { total: 700, cae: "Y", caeDue: "20261010", date: "20260926" })
    const dateMismatch = await processArcaInvoice(client, options(arca, { orderId: sameTotal, manual: true }))
    assert.equal(dateMismatch.status === "failed" && dateMismatch.willRetry, false)
    assert.equal((await loadOrder(db, sameTotal)).invoice_cae, null)
  } finally {
    await db.close()
  }
})

test("G. pedido con conflicto de stock, cancelado o pendiente -> cero facturas", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT)
  try {
    const conflict = await insertOrder(db, { payment_method_id: "transferencia" })
    await db.query("update ordenes set payment_status='auto_verified_stock_conflict' where id=$1", [conflict])
    const mpConflict = await insertOrder(db)
    await db.query("update ordenes set payment_status='approved_stock_conflict' where id=$1", [mpConflict])
    const pending = await insertOrder(db)
    const client = rpcClient(db)
    assert.deepEqual(await processArcaInvoiceQueue(client, options(arca)), { authorized: 0, failed: 0, results: [] })
    for (const id of [conflict, mpConflict, pending]) {
      assert.deepEqual(await processArcaInvoice(client, options(arca, { orderId: id, manual: true })), { status: "not_invoiceable" })
    }
    assert.equal(arca.requests, 0)
    assert.equal(arca.vouchers.size, 0)
  } finally {
    await db.close()
  }
})

test("backoff acotado", () => {
  assert.deepEqual([1, 2, 3, 6, 10].map(invoiceRetryDelayMinutes), [2, 4, 8, 60, 60])
})
