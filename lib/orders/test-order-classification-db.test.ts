import assert from "node:assert/strict"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { ADMIN, CLIENT, OWNER, SETUP, authorizeForTest } from "./fixtures/test-order-classification-db.mjs"

// Clasificación de compras de prueba sobre las migraciones REALES (archivo +
// clasificación) y las funciones REALES de recepción de devoluciones.
// Reproduce BX-1019 / BX-1020: variante 22, compra de 8, dos ventas web de 1.
// La concurrencia real (dos conexiones) está en
// test-order-classification-concurrency.test.mjs.

const REASON = "Compra de prueba del checkout hecha por el propietario; conserva el producto."

async function setupDb() {
  const db = new PGlite()
  for (const sql of SETUP) await db.exec(sql)
  await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)")
  return db
}

const stockOf = async (db: PGlite, variant: number) =>
  Number((await db.query<{ stock: number }>("select stock from producto_variantes where id = $1", [variant])).rows[0].stock)
const blockersOf = async (db: PGlite, id: number) =>
  (await db.query<{ b: string[] }>("select order_test_classification_blockers($1) b", [id])).rows[0].b
const planOf = async (db: PGlite, id: number) =>
  (await db.query<{ p: Array<Record<string, unknown>> }>("select order_test_restock_plan($1) p", [id])).rows[0].p
const classify = async (db: PGlite, id: number, options: { actor?: string; reason?: string; confirmation?: string; restock?: boolean | null } = {}) =>
  (await db.query<{ r: Record<string, unknown> }>("select classify_test_order_admin($1, $2, $3, $4, $5) r", [
    id,
    options.actor ?? OWNER,
    options.reason ?? REASON,
    options.confirmation ?? `BX-${1000 + id}`,
    options.restock === undefined ? true : options.restock,
  ])).rows[0].r
const count = async (db: PGlite, sql: string) => Number((await db.query<{ n: number }>(`select count(*)::int n ${sql}`)).rows[0].n)
const receive = (db: PGlite, orderId: number, itemId: number, sellable: number, key: string) =>
  db.query("select (record_order_item_return_reception($1, $2, $3, 0, 0, $4, $5)).id", [orderId, itemId, sellable, key, OWNER])

test("estado inicial = auditoría real: 8 − 1 − 1 = 6, sólo BX-1019/1020 autorizados y nada compensado", async () => {
  const db = await setupDb()
  try {
    assert.equal(await stockOf(db, 22), 6)
    assert.deepEqual(await blockersOf(db, 19), [], "el reclamo cerrado ya no bloquea")
    assert.deepEqual(await blockersOf(db, 20), [])
    assert.deepEqual((await db.query<{ order_id: number }>("select order_id::int from test_order_authorizations order by 1")).rows.map((row) => row.order_id), [19, 20])
    const plan = await planOf(db, 19)
    assert.deepEqual(plan.map((row) => [row.orderItemId, row.consumed, row.returned, row.compensated, row.pending, row.supported]), [[26, 1, 0, 0, 1, true]])
  } finally {
    await db.close()
  }
})

test("permisos: sólo service_role + super_admin; motivo, confirmación y elección de stock", async () => {
  const db = await setupDb()
  try {
    await assert.rejects(classify(db, 19, { actor: ADMIN }), /ORDER_TEST_FORBIDDEN/)
    await assert.rejects(classify(db, 19, { actor: CLIENT }), /ORDER_TEST_FORBIDDEN/)
    await assert.rejects(classify(db, 19, { reason: "corto" }), /ORDER_TEST_REASON_REQUIRED/)
    await assert.rejects(classify(db, 19, { confirmation: "BX-1020" }), /ORDER_TEST_CONFIRMATION_MISMATCH/)
    await assert.rejects(classify(db, 19, { restock: null }), /ORDER_TEST_RESTOCK_CHOICE_REQUIRED/)
    await assert.rejects(classify(db, 999), /ORDER_NOT_FOUND/)

    const privileges = (await db.query<Record<string, boolean>>(`select
      has_function_privilege('authenticated', 'classify_test_order_admin(bigint,uuid,text,text,boolean)', 'EXECUTE') a,
      has_function_privilege('anon', 'classify_test_order_admin(bigint,uuid,text,text,boolean)', 'EXECUTE') b,
      has_function_privilege('authenticated', 'order_test_restock_plan(bigint)', 'EXECUTE') c,
      has_function_privilege('authenticated', 'archive_order_admin(bigint,uuid,text,boolean)', 'EXECUTE') d,
      has_function_privilege('service_role', 'classify_test_order_admin(bigint,uuid,text,text,boolean)', 'EXECUTE') e,
      has_table_privilege('service_role', 'test_order_authorizations', 'INSERT') f,
      has_table_privilege('authenticated', 'test_order_authorizations', 'SELECT') g`)).rows[0]
    assert.deepEqual(privileges, { a: false, b: false, c: false, d: false, e: true, f: false, g: false })

    await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false)")
    await assert.rejects(classify(db, 19), /FORBIDDEN/)
    assert.equal(await stockOf(db, 22), 6, "ningún rechazo cambia el stock")
    assert.equal(await count(db, "from order_audit_events where action = 'order_classified_as_test'"), 0)
  } finally {
    await db.close()
  }
})

test("P1 compras legítimas: el rol interno del comprador no alcanza; sólo autorización previa y exacta", async () => {
  const db = await setupDb()
  try {
    assert.deepEqual(await blockersOf(db, 21), ["not_authorized_test_order", "buyer_not_internal"], "compra de cliente")
    assert.deepEqual(await blockersOf(db, 25), ["not_authorized_test_order"], "compra real de una cuenta interna, cerrada")
    await assert.rejects(classify(db, 25), /ORDER_TEST_BLOCKED:not_authorized_test_order/)

    // La autorización fija comprador, total, pago e ítems: cualquier diferencia bloquea.
    for (const change of [
      "update ordenes set total = 21 where id = 19",
      "update ordenes set payment_id = 'OTRO' where id = 19",
      "update orden_items set cantidad = 2 where id = 26",
      `update ordenes set usuario_id = '${CLIENT}' where id = 19`,
    ]) {
      await db.exec("begin")
      await db.exec(change)
      assert.ok((await blockersOf(db, 19)).includes("test_authorization_mismatch"), change)
      await assert.rejects(classify(db, 19), /test_authorization_mismatch/, change)
      await db.exec("rollback")
    }
    assert.equal(await count(db, "from ordenes where test_order_at is not null"), 0)
  } finally {
    await db.close()
  }
})

test("P2 pago actual: exige pago aprobado y confirmado por el importe autorizado", async () => {
  const db = await setupDb()
  try {
    assert.deepEqual((await db.query<{ order_id: number; amount: string }>(
      "select order_id::int, expected_payment_amount::text amount from test_order_authorizations order by 1",
    )).rows, [{ order_id: 19, amount: "20.00" }, { order_id: 20, amount: "100.00" }])

    const cases: Array<[string, string]> = [
      // Estado del pago cambiado después de la autorización.
      ["update ordenes set financial_status = 'refund_pending' where id = 19", "payment_not_confirmed"],
      ["update ordenes set financial_status = 'refunded' where id = 19", "payment_not_confirmed"],
      ["update ordenes set financial_status = 'cancellation_requested' where id = 19", "payment_not_confirmed"],
      ["update ordenes set payment_status = 'approved_amount_mismatch' where id = 19", "payment_not_confirmed"],
      // Pago no confirmado.
      ["update ordenes set payment_status = 'pending', financial_status = 'pending_payment', payment_confirmed_at = null where id = 19", "payment_not_confirmed"],
      ["update ordenes set payment_confirmed_at = null where id = 19", "payment_not_confirmed"],
      // Importe confirmado distinto del autorizado (el total sigue igual).
      ["update ordenes set payment_confirmed_amount = 19.99 where id = 19", "payment_amount_mismatch"],
      ["update ordenes set payment_confirmed_amount = 200 where id = 19", "payment_amount_mismatch"],
      ["update ordenes set payment_confirmed_amount = null where id = 19", "payment_amount_mismatch"],
    ]
    for (const [change, code] of cases) {
      await db.exec("begin")
      await db.exec(change)
      assert.ok((await blockersOf(db, 19)).includes(code), change)
      await assert.rejects(classify(db, 19), new RegExp(`ORDER_TEST_BLOCKED:.*${code}`), change)
      await db.exec("rollback")
    }

    const payment = await db.query("select id::int id, payment_status, financial_status, payment_confirmed_amount::text from ordenes where id in (19, 20) order by id")
    assert.deepEqual(payment.rows, [
      { id: 19, payment_status: "approved", financial_status: "payment_confirmed", payment_confirmed_amount: "20" },
      { id: 20, payment_status: "approved", financial_status: "payment_confirmed", payment_confirmed_amount: "100" },
    ], "ningún rechazo modifica el pago")
    assert.equal(await count(db, "from ordenes where test_order_at is not null"), 0)
    assert.equal(await stockOf(db, 22), 6)
  } finally {
    await db.close()
  }
})

test("pedido autorizado pero activo: bloqueado como en el archivo", async () => {
  const db = await setupDb()
  try {
    await db.exec(authorizeForTest(24))
    assert.deepEqual(await blockersOf(db, 24), ["active_order"])
    await db.exec("insert into local_delivery_return_reservations (order_id, status) values (19, 'active')")
    assert.ok((await blockersOf(db, 19)).includes("local_delivery_return_pending"))
  } finally {
    await db.close()
  }
})

test("BX-1019 y BX-1020: clasifica, archiva, reingresa +1 cada uno (6 → 8) y conserva pago y factura", async () => {
  const db = await setupDb()
  try {
    const financial = "select total, payment_status, financial_status, paid_at, payment_confirmed_amount, invoice_status, invoice_cae, estado, payment_id from ordenes where id = $1"
    const before19 = (await db.query(financial, [19])).rows[0]
    const result = await classify(db, 19, { confirmation: " bx-1019 " })
    assert.equal(result.alreadyClassified, false)
    assert.deepEqual(result.restocked, [{ orderItemId: 26, productId: 22, variantId: 22, quantity: 1, previousStock: 6, newStock: 7 }])
    assert.equal(await stockOf(db, 22), 7)
    assert.deepEqual((await db.query(financial, [19])).rows[0], before19, "pago, factura y estado intactos")

    const order = (await db.query<Record<string, unknown>>("select test_order_by, test_order_reason, archived_at, archived_by, archive_reason, customer_hidden_at from ordenes where id = 19")).rows[0]
    assert.ok(order.archived_at)
    assert.deepEqual({ ...order, archived_at: null }, {
      test_order_by: OWNER, test_order_reason: REASON, archived_at: null, archived_by: OWNER,
      archive_reason: `Pedido de prueba: ${REASON}`, customer_hidden_at: null,
    })
    const actions = (await db.query<{ action: string; metadata: Record<string, unknown> }>("select action, metadata from order_audit_events where order_id = 19 order by id")).rows
    assert.deepEqual(actions.map((row) => row.action), ["order_archived", "order_classified_as_test"])
    assert.deepEqual(actions[0].metadata, { reason: `Pedido de prueba: ${REASON}`, hideFromCustomer: false })
    const log = (await db.query<Record<string, unknown>>("select movement_type, quantity, origin, actor_user_id, document_reference, metadata from inventory_operation_log")).rows
    assert.deepEqual(log, [{ movement_type: "adjustment", quantity: 1, origin: "test_order_restock", actor_user_id: OWNER, document_reference: "order:19", metadata: { orderId: 19, orderItemId: 26, previousStock: 6, newStock: 7, delta: 1 } }])

    await classify(db, 20)
    assert.equal(await stockOf(db, 22), 8, "máximo +2 en total")
    assert.equal(await count(db, "from inventory_stock_adjustments"), 2)
    assert.equal(await stockOf(db, 30), 7, "otra variante intacta (10 − 4 vendidas + 1 devuelta)")
    await assert.rejects(db.exec("delete from ordenes where id = 19"), /ORDER_DELETE_BLOCKED/)
  } finally {
    await db.close()
  }
})

test("idempotencia y carrera que pasó el chequeo: nunca un segundo reingreso", async () => {
  const db = await setupDb()
  try {
    await classify(db, 19)
    const again = await classify(db, 19, { confirmation: "cualquiera", reason: "Otro motivo distinto del original" })
    assert.equal(again.alreadyClassified, true)
    assert.equal(again.test_order_reason, REASON)
    assert.deepEqual(again.restocked, [])
    assert.equal(await count(db, "from order_audit_events where order_id = 19"), 2)

    // Segunda transacción que leyó el pedido sin clasificar (marcas limpiadas
    // por la vía protegida): el plan ya ve la unidad compensada.
    await db.exec(`
      select set_config('beyonix.order_test_classification', 'on', false);
      select set_config('beyonix.order_archive', 'on', false);
      update ordenes set test_order_at = null, test_order_by = null, test_order_reason = null,
        archived_at = null, archived_by = null, archive_reason = null where id = 19;
      select set_config('beyonix.order_test_classification', '', false);
      select set_config('beyonix.order_archive', '', false);
    `)
    assert.deepEqual((await classify(db, 19)).restocked, [])
    assert.equal(await stockOf(db, 22), 7)
    await assert.rejects(
      db.exec(`insert into inventory_stock_adjustments (product_id, variant_id, quantity_delta, reason, idempotency_key)
        values (22, 22, 1, 'duplicado', 'test-order-restock:item:26')`),
      /duplicate key|unique/i,
    )
  } finally {
    await db.close()
  }
})

test("devolución recibida antes de clasificar: el plan la descuenta y no reingresa de nuevo", async () => {
  const db = await setupDb()
  try {
    await receive(db, 19, 26, 1, "recepcion-previa")
    assert.equal(await stockOf(db, 22), 7, "la recepción real reingresó la unidad")
    const result = await classify(db, 19)
    assert.deepEqual(result.restocked, [])
    assert.equal(await stockOf(db, 22), 7)
  } finally {
    await db.close()
  }
})

test("después de clasificar, ninguna recepción (directa o por reclamo) reingresa la misma unidad", async () => {
  const db = await setupDb()
  try {
    await classify(db, 19)
    await assert.rejects(receive(db, 19, 26, 1, "recepcion-tardia"), /ORDER_TEST_STOCK_ALREADY_RESTORED/)
    await assert.rejects(
      db.query("select process_claim_return_inventory(1, 19, 26, 1, 0, 'Recepción del reclamo', $1, 'reclamo-tardio')", [OWNER]),
      /ORDER_TEST_STOCK_ALREADY_RESTORED/,
    )
    assert.equal(await stockOf(db, 22), 7)
    assert.equal(await count(db, "from inventory_return_movements where order_item_id = 26"), 0)
  } finally {
    await db.close()
  }
})

test("P2 devoluciones por UPDATE: cantidades y vínculos protegidos; notas permitidas", async () => {
  const db = await setupDb()
  try {
    // BX-1040: 2 unidades, 1 ya devuelta; la clasificación reingresa la otra.
    await db.exec(`
      insert into ordenes (id, usuario_id, estado, payment_status, financial_status, payment_confirmed_at, payment_confirmed_amount, total, invoice_status, invoice_cae, payment_id)
        values (40, '${OWNER}', 'entregado', 'approved', 'payment_confirmed', now(), 200, 200, 'authorized', 'CAE-40', 'MP-40');
      insert into orden_items (id, orden_id, producto_id, variante_id, cantidad) values (40, 40, 30, 30, 2);
      select refresh_inventory_stock(30);
    `)
    await receive(db, 40, 40, 1, "primera-unidad")
    await db.exec(authorizeForTest(40))
    const before = await stockOf(db, 30)
    const restocked = (await classify(db, 40)).restocked as Array<{ quantity: number }>
    assert.deepEqual(restocked.map((row) => row.quantity), [1])
    assert.equal(await stockOf(db, 30), before + 1)

    await assert.rejects(db.exec("update inventory_return_movements set sellable_quantity = 2, received_quantity = 2, quantity = 2 where order_item_id = 40"), /ORDER_TEST_STOCK_ALREADY_RESTORED/)
    await assert.rejects(db.exec("update inventory_return_movements set order_item_id = 40, order_id = 40 where source_key = 'order-item:31:seed'"), /ORDER_TEST_STOCK_ALREADY_RESTORED/, "re-vincular otra devolución al ítem")
    await assert.rejects(db.exec("update inventory_return_movements set order_item_id = 31, order_id = 23 where order_item_id = 40"), /ORDER_TEST_STOCK_ALREADY_RESTORED/, "desvincular la del ítem")
    await db.exec("update inventory_return_movements set review_notes = 'Revisado: caja abierta' where order_item_id = 40")
    await db.exec("update inventory_return_movements set sellable_quantity = sellable_quantity where order_item_id = 40")
    assert.equal(await stockOf(db, 30), before + 1)
  } finally {
    await db.close()
  }
})

test("sin reingreso, con archivo previo y guardas del pedido", async () => {
  const db = await setupDb()
  try {
    await db.exec(authorizeForTest(25))
    const initial30 = await stockOf(db, 30)
    const withoutRestock = await classify(db, 25, { restock: false })
    assert.deepEqual(withoutRestock.restocked, [])
    assert.equal(await stockOf(db, 30), initial30)

    await db.exec(authorizeForTest(23))
    await db.query("select archive_order_admin(23, $1, 'Archivado manualmente antes', false)", [OWNER])
    const result = await classify(db, 23)
    assert.deepEqual(result.restocked, [], "la devolución ya la reingresó")
    assert.equal(result.archive_reason, "Archivado manualmente antes", "no pisa el archivo previo")

    await assert.rejects(db.exec(`update ordenes set test_order_at = now(), test_order_by = '${OWNER}', test_order_reason = 'atajo directo sin RPC' where id = 21`), /ORDER_TEST_COLUMNS_PROTECTED/)
    await assert.rejects(db.exec(`insert into ordenes (id, test_order_at, test_order_by, test_order_reason) values (99, now(), '${OWNER}', 'insert directo sin RPC')`), /ORDER_TEST_COLUMNS_PROTECTED/)
    await classify(db, 19)
    await assert.rejects(db.exec("update ordenes set estado = 'cancelado' where id = 19"), /ORDER_TEST_STOCK_ALREADY_RESTORED/)
    await db.exec("update ordenes set tracking_number = 'interno' where id = 19")
    await db.exec("update ordenes set estado = 'cancelado' where id = 25")
  } finally {
    await db.close()
  }
})

test("P1 archivo: ocultar al cliente sólo para pruebas clasificadas; P2 una prueba no se restaura", async () => {
  const db = await setupDb()
  try {
    await assert.rejects(db.query("select archive_order_admin(21, $1, 'Compra real de un cliente', true)", [OWNER]), /ORDER_ARCHIVE_HIDE_REQUIRES_TEST/)
    assert.equal(await count(db, "from ordenes where archived_at is not null or customer_hidden_at is not null"), 0, "el rechazo no deja nada")
    await db.query("select archive_order_admin(21, $1, 'Archivo ordinario', false)", [OWNER])
    assert.equal((await db.query<{ h: string | null }>("select customer_hidden_at h from ordenes where id = 21")).rows[0].h, null)
    await db.query("select unarchive_order_admin(21, $1, 'Se archivó por error')", [OWNER])
    assert.equal(await count(db, "from ordenes where id = 21 and archived_at is null"), 1, "un pedido común se sigue restaurando")

    await classify(db, 19)
    await assert.rejects(db.query("select unarchive_order_admin(19, $1, 'Volver al listado')", [OWNER]), /ORDER_TEST_ARCHIVE_LOCKED/)
    assert.equal(await count(db, "from ordenes where id = 19 and archived_at is not null"), 1)
    await assert.rejects(db.exec("update ordenes set customer_hidden_at = now() where id = 21"), /ORDER_ARCHIVE_COLUMNS_PROTECTED/)
  } finally {
    await db.close()
  }
})

test("una falla a mitad de la clasificación revierte todo (clasificación, archivo, stock y auditoría)", async () => {
  const db = await setupDb()
  try {
    await db.exec(`
      create function fail_classification_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'order_classified_as_test' then raise exception 'FALLA_SIMULADA'; end if;
        return new;
      end $$;
      create trigger fail_classification_audit before insert on order_audit_events
        for each row execute function fail_classification_audit();
    `)
    await assert.rejects(classify(db, 19), /FALLA_SIMULADA/)
    assert.equal(await stockOf(db, 22), 6)
    assert.equal(await count(db, "from inventory_stock_adjustments"), 0)
    assert.equal(await count(db, "from inventory_operation_log"), 0)
    assert.equal(await count(db, "from ordenes where test_order_at is not null or archived_at is not null"), 0)
    assert.equal(await count(db, "from order_audit_events"), 0)
  } finally {
    await db.close()
  }
})

test("ajuste administrativo de stock sigue funcionando con el nuevo orden de locks", async () => {
  const db = await setupDb()
  try {
    await classify(db, 19)
    const adjusted = (await db.query<{ stock: number }>("select (adjust_variant_stock_idempotent(22, 10, 'Recuento físico', $1, 'recuento-2026-11-24')).stock", [OWNER])).rows[0]
    assert.equal(Number(adjusted.stock), 10)
    assert.equal(await stockOf(db, 22), 10)
    await db.query("select adjust_variant_stock_idempotent(22, 10, 'Recuento físico', $1, 'recuento-2026-11-24')", [OWNER])
    assert.equal(await count(db, "from inventory_stock_adjustments where idempotency_key = 'recuento-2026-11-24'"), 1)
  } finally {
    await db.close()
  }
})
