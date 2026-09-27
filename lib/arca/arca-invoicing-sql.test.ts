import assert from "node:assert/strict"
import test from "node:test"

import {
  confirmOrder,
  insertOrder,
  loadOrder,
  setupInvoicingDb,
} from "./fixtures/arca-invoicing-db.ts"

// Migración 20260927100000 sobre PostgreSQL real (PGlite): trigger único de
// facturación, máquina de estados fiscal, idempotencia y permisos.

test("trigger: sólo una venta confirmada, con stock consumido y sin conflicto entra en la cola", async () => {
  const db = await setupInvoicingDb()
  try {
    // Confirmadas por cada medio: MP, transferencia y saldo a favor.
    for (const [method, status] of [["mercadopago", "approved"], ["transferencia", "confirmado"], ["customer_credit", "confirmado"]]) {
      const id = await insertOrder(db, { payment_method_id: method })
      assert.equal((await loadOrder(db, id)).invoice_status, null, "crear el pedido no factura")
      await confirmOrder(db, id, status)
      const order = await loadOrder(db, id)
      assert.equal(order.invoice_status, "pending", method)
      assert.ok(order.invoice_queued_at && order.invoice_next_attempt_at)
    }

    // Nunca facturables.
    const never: Array<[string, Record<string, unknown>]> = [
      ["pago pendiente / preference creada", { estado: "pendiente", payment_status: "preference_created", financial_status: "pending_payment" }],
      ["MP approved sin confirmación BEYONIX", { estado: "pendiente", payment_status: "approved", financial_status: "pending_payment" }],
      ["transferencia detectada con conflicto de stock", { estado: "pendiente", payment_status: "auto_verified_stock_conflict", financial_status: "pending_payment" }],
      ["MP con conflicto de stock", { estado: "pendiente", payment_status: "approved_stock_conflict", financial_status: "pending_payment" }],
      ["pago después de cancelar", { estado: "cancelado", payment_status: "approved_after_cancellation", financial_status: "refund_pending" }],
      ["reintegro pendiente", { estado: "pagado", payment_status: "approved", financial_status: "refund_pending" }],
      ["cancelado", { estado: "cancelado", payment_status: "approved", financial_status: "cancelled" }],
      ["monto no coincide", { estado: "pendiente", payment_status: "approved_amount_mismatch", financial_status: "pending_payment" }],
      ["en revisión manual", { estado: "pendiente", payment_status: "en_revision", financial_status: "payment_submitted" }],
    ]
    for (const [label, values] of never) {
      const id = await insertOrder(db)
      await db.query(
        "update ordenes set estado=$2, payment_status=$3, financial_status=$4 where id=$1",
        [id, values.estado, values.payment_status, values.financial_status],
      )
      assert.equal((await loadOrder(db, id)).invoice_status, null, label)
    }

    const changePending = await insertOrder(db)
    await db.query("update ordenes set order_change_status='change_requested' where id=$1", [changePending])
    await confirmOrder(db, changePending)
    assert.equal((await loadOrder(db, changePending)).invoice_status, null, "cambio pendiente")

    const zero = await insertOrder(db, { total: 0 })
    await confirmOrder(db, zero)
    assert.equal((await loadOrder(db, zero)).invoice_status, null, "total 0")
  } finally {
    await db.close()
  }
})

test("trigger: webhook/confirmación repetidos no duplican; cancelar antes de facturar lo saca de la cola", async () => {
  const db = await setupInvoicingDb()
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    const first = await loadOrder(db, id)
    await confirmOrder(db, id)
    await db.query("update ordenes set estado='preparado' where id=$1", [id])
    const again = await loadOrder(db, id)
    assert.equal(again.invoice_status, "pending")
    assert.equal(String(again.invoice_queued_at), String(first.invoice_queued_at), "sigue siendo el mismo encolado")

    await db.query("update ordenes set estado='cancelado', financial_status='refund_pending', cancelled_at=now() where id=$1", [id])
    assert.equal((await loadOrder(db, id)).invoice_status, null, "cancelado sin CAE: sale de la cola")
  } finally {
    await db.close()
  }
})

test("claim: un solo pedido 'processing' a la vez; lease vencido se retoma; manual informa el motivo", async () => {
  const db = await setupInvoicingDb()
  try {
    const a = await insertOrder(db)
    const b = await insertOrder(db)
    await confirmOrder(db, a)
    await confirmOrder(db, b)

    const claimed = (await db.query<{ id: number }>("select * from claim_arca_invoice(null)")).rows
    assert.equal(claimed.length, 1)
    const busy = (await db.query("select * from claim_arca_invoice(null)")).rows
    assert.equal(busy.length, 0, "otro worker no toma nada mientras hay uno facturando")
    await assert.rejects(db.query("select * from claim_arca_invoice($1, interval '10 minutes', true)", [b]), /INVOICE_PROCESSING_IN_PROGRESS/)
    await assert.rejects(
      db.query("select * from claim_arca_invoice($1, interval '10 minutes', true)", [claimed[0].id]),
      /INVOICE_ALREADY_PROCESSING/,
    )

    // Servidor reiniciado: el lease vence y el pedido se retoma.
    await db.query("update ordenes set invoice_processing_started_at = now() - interval '11 minutes' where id=$1", [claimed[0].id])
    const resumed = (await db.query<{ id: number; invoice_attempts: number }>("select * from claim_arca_invoice(null)")).rows
    assert.equal(Number(resumed[0].id), Number(claimed[0].id))
    assert.equal(Number(resumed[0].invoice_attempts), 2)

    const notInvoiceable = await insertOrder(db)
    await assert.rejects(
      db.query("select * from claim_arca_invoice($1, interval '10 minutes', true)", [notInvoiceable]),
      /INVOICE_PROCESSING_IN_PROGRESS|ORDER_NOT_INVOICEABLE/,
    )
  } finally {
    await db.close()
  }
})

test("número pedido: único entre pedidos; CAE idempotente y nunca pisa otra factura", async () => {
  const db = await setupInvoicingDb()
  try {
    const a = await insertOrder(db)
    const b = await insertOrder(db)
    await confirmOrder(db, a)
    await confirmOrder(db, b)
    await db.query("select * from claim_arca_invoice($1, interval '10 minutes', true)", [a])
    await db.query("select * from record_arca_invoice_request($1, 3, 11, 41, 1000, '20260927', 'homologation')", [a])
    // Mismo número otra vez para el mismo pedido: idempotente.
    await db.query("select * from record_arca_invoice_request($1, 3, 11, 41, 1000, '20260927', 'homologation')", [a])
    await assert.rejects(
      db.query("select * from record_arca_invoice_request($1, 3, 11, 42, 1000, '20260927', 'homologation')", [a]),
      /INVOICE_REQUEST_PENDING_RECONCILIATION/,
    )

    await db.query("update ordenes set invoice_processing_started_at = now() - interval '11 minutes' where id=$1", [a])
    await db.query("select * from fail_arca_invoice_attempt($1, 'simulado', null, false)", [a])
    await db.query("select * from claim_arca_invoice($1, interval '10 minutes', true)", [b])
    await assert.rejects(
      db.query("select * from record_arca_invoice_request($1, 3, 11, 41, 1000, '20260927', 'homologation')", [b]),
      /INVOICE_NUMBER_ALREADY_REQUESTED/,
      "dos pedidos nunca comparten número",
    )

    await db.query("select * from record_arca_invoice_request($1, 3, 11, 42, 1000, '20260927', 'homologation')", [b])
    await assert.rejects(
      db.query("select * from complete_arca_invoice($1, 3, 11, 43, 'CAE', '2026-10-10', now(), false, 'homologation')", [b]),
      /INVOICE_AUTHORIZATION_DOES_NOT_MATCH_REQUEST/,
    )
    const done = (await db.query<Record<string, unknown>>(
      "select * from complete_arca_invoice($1, 3, 11, 42, 'CAE-42', '2026-10-10', now(), false, 'homologation')", [b])).rows[0]
    assert.equal(done.invoice_status, "authorized")
    assert.equal(Number(done.invoice_number), 42)
    // Repetir el mismo CAE: devuelve la factura; otro CAE: rechazado.
    await db.query("select * from complete_arca_invoice($1, 3, 11, 42, 'CAE-42', '2026-10-10', now(), false, 'homologation')", [b])
    await assert.rejects(
      db.query("select * from complete_arca_invoice($1, 3, 11, 42, 'OTRO', '2026-10-10', now(), false, 'homologation')", [b]),
      /INVOICE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER/,
    )
    const audits = (await db.query<{ n: number }>(
      "select count(*)::int as n from order_audit_events where order_id=$1 and action='arca_invoice_authorized'", [b])).rows[0].n
    assert.equal(audits, 1)
  } finally {
    await db.close()
  }
})

test("fallo: libera el número sólo ante rechazo definitivo; cancelado con CAE pedido sigue reconciliable y pide NC", async () => {
  const db = await setupInvoicingDb()
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    await db.query("select * from claim_arca_invoice($1, interval '10 minutes', true)", [id])
    await db.query("select * from record_arca_invoice_request($1, 3, 11, 7, 1000, '20260927', 'homologation')", [id])
    const kept = (await db.query<Record<string, unknown>>(
      "select * from fail_arca_invoice_attempt($1, 'timeout', interval '2 minutes', false)", [id])).rows[0]
    assert.equal(kept.invoice_status, "error")
    assert.equal(Number(kept.invoice_requested_number), 7, "resultado desconocido: se conserva para reconciliar")

    // El pedido se cancela con el CAE pedido: NO sale de la cola.
    await db.query("update ordenes set estado='cancelado', financial_status='refund_pending', cancelled_at=now() where id=$1", [id])
    const cancelled = await loadOrder(db, id)
    assert.equal(cancelled.invoice_status, "error")
    await db.query("update ordenes set invoice_next_attempt_at = now() - interval '1 second' where id=$1", [id])
    const reclaimed = (await db.query<{ id: number }>("select * from claim_arca_invoice(null)")).rows
    assert.equal(Number(reclaimed[0].id), id, "se reconcilia aunque ya no sea facturable")
    const authorized = (await db.query<Record<string, unknown>>(
      "select * from complete_arca_invoice($1, 3, 11, 7, 'CAE-7', '2026-10-10', now(), true, 'homologation')", [id])).rows[0]
    assert.equal(authorized.invoice_status, "authorized")
    assert.equal(authorized.credit_note_required, true, "factura de una venta cancelada -> nota de crédito")

    const other = await insertOrder(db)
    await confirmOrder(db, other)
    await db.query("select * from claim_arca_invoice($1, interval '10 minutes', true)", [other])
    await db.query("select * from record_arca_invoice_request($1, 3, 11, 8, 1000, '20260927', 'homologation')", [other])
    const released = (await db.query<Record<string, unknown>>(
      "select * from fail_arca_invoice_attempt($1, 'rechazo 10016', interval '2 minutes', true)", [other])).rows[0]
    assert.equal(released.invoice_requested_number, null, "rechazo definitivo: el número queda libre")
  } finally {
    await db.close()
  }
})

test("seguridad: todo es service_role; la RPC heredada deja de estar expuesta", async () => {
  const db = await setupInvoicingDb()
  try {
    const { rows } = await db.query<Record<string, boolean>>(`
      select
        has_function_privilege('anon', 'public.claim_arca_invoice(bigint, interval, boolean)', 'EXECUTE') as anon_claim,
        has_function_privilege('authenticated', 'public.claim_arca_invoice(bigint, interval, boolean)', 'EXECUTE') as auth_claim,
        has_function_privilege('authenticated', 'public.record_arca_invoice_request(bigint, integer, integer, bigint, numeric, text, text)', 'EXECUTE') as auth_record,
        has_function_privilege('authenticated', 'public.complete_arca_invoice(bigint, integer, integer, bigint, text, date, timestamptz, boolean, text)', 'EXECUTE') as auth_complete,
        has_function_privilege('authenticated', 'public.fail_arca_invoice_attempt(bigint, text, interval, boolean)', 'EXECUTE') as auth_fail,
        has_function_privilege('anon', 'public.begin_arca_invoice_processing(bigint)', 'EXECUTE') as anon_legacy,
        has_function_privilege('authenticated', 'public.begin_arca_invoice_processing(bigint)', 'EXECUTE') as auth_legacy,
        has_function_privilege('service_role', 'public.claim_arca_invoice(bigint, interval, boolean)', 'EXECUTE') as service_claim
    `)
    assert.deepEqual(rows[0], {
      anon_claim: false, auth_claim: false, auth_record: false, auth_complete: false,
      auth_fail: false, anon_legacy: false, auth_legacy: false, service_claim: true,
    })
    // Aun con EXECUTE, sin rol service_role la función se niega.
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(db.query("select * from claim_arca_invoice(null)"), /FORBIDDEN/)
  } finally {
    await db.close()
  }
})
