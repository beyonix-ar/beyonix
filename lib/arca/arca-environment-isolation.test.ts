import assert from "node:assert/strict"
import test from "node:test"

import { isFiscalArcaVoucher, parseArcaEnvironment } from "./environment.ts"
import { processArcaInvoice } from "./invoice-automation.ts"
import {
  FakeArca,
  applyEnvironmentIsolation,
  confirmOrder,
  insertOrder,
  loadOrder,
  rpcClient,
  setupInvoicingDb,
} from "./fixtures/arca-invoicing-db.ts"

// Aislamiento homologación / producción (migración REAL 20260927120000 sobre
// PGlite). Cada FakeArca es UN ambiente con su propia numeración, como ARCA.

const POINT = 3
const now = () => new Date("2026-09-27T15:00:00-03:00")
type Db = Awaited<ReturnType<typeof setupInvoicingDb>>

async function claimed(db: Db, id: number) {
  await db.query("select * from claim_arca_invoice($1, interval '10 minutes', true)", [id])
}

async function paidOrder(db: Db, total = 1000) {
  const id = await insertOrder(db, { total })
  await confirmOrder(db, id)
  return id
}

test("mismo punto/tipo/número permitido una vez en cada ambiente; duplicado en el mismo ambiente rechazado", async () => {
  const db = await setupInvoicingDb()
  try {
    const homologation = await paidOrder(db)
    const production = await paidOrder(db)
    const duplicate = await paidOrder(db)
    await claimed(db, homologation)
    await db.query("select * from record_arca_invoice_request($1, 3, 11, 73, 1000, '20260927', 'homologation')", [homologation])
    await db.query("select * from complete_arca_invoice($1, 3, 11, 73, 'CAE-H73', '2026-10-10', now(), false, 'homologation')", [homologation])

    await claimed(db, production)
    await db.query("select * from record_arca_invoice_request($1, 3, 11, 73, 1000, '20260927', 'production')", [production])
    const prod = (await db.query<Record<string, unknown>>(
      "select * from complete_arca_invoice($1, 3, 11, 73, 'CAE-P73', '2026-10-10', now(), false, 'production')", [production])).rows[0]
    assert.equal(prod.invoice_status, "authorized")
    assert.equal(prod.invoice_arca_environment, "production")
    assert.equal((await loadOrder(db, homologation)).invoice_arca_environment, "homologation")

    // Tercer pedido con el mismo número en homologación: rechazado.
    await claimed(db, duplicate)
    await assert.rejects(
      db.query("select * from record_arca_invoice_request($1, 3, 11, 73, 1000, '20260927', 'homologation')", [duplicate]),
      /INVOICE_NUMBER_ALREADY_REQUESTED/,
    )
    // Y el índice de comprobantes autorizados también distingue ambiente.
    await assert.rejects(
      db.query(
        "update ordenes set invoice_cae='X', invoice_number=73, invoice_point=3, invoice_arca_environment='production' where id=$1",
        [duplicate],
      ),
      /ordenes_invoice_authorized_voucher_unique/,
    )
  } finally {
    await db.close()
  }
})

test("ambiente obligatorio: sin ambiente o con otro ambiente no se registra ni se completa", async () => {
  const db = await setupInvoicingDb()
  try {
    const id = await paidOrder(db)
    await claimed(db, id)
    for (const environment of [null, "", "PROD", "qa"]) {
      await assert.rejects(
        db.query("select * from record_arca_invoice_request($1, 3, 11, 5, 1000, '20260927', $2)", [id, environment]),
        /INVALID_INVOICE_REQUEST/,
        String(environment),
      )
    }
    await db.query("select * from record_arca_invoice_request($1, 3, 11, 5, 1000, '20260927', 'homologation')", [id])
    // El mismo número en otro ambiente para el MISMO pedido: pendiente de conciliar.
    await assert.rejects(
      db.query("select * from record_arca_invoice_request($1, 3, 11, 5, 1000, '20260927', 'production')", [id]),
      /INVOICE_REQUEST_PENDING_RECONCILIATION/,
    )
    await assert.rejects(
      db.query("select * from complete_arca_invoice($1, 3, 11, 5, 'CAE', '2026-10-10', now(), false, 'production')", [id]),
      /INVOICE_AUTHORIZATION_DOES_NOT_MATCH_REQUEST/,
    )
    await db.query("select * from complete_arca_invoice($1, 3, 11, 5, 'CAE', '2026-10-10', now(), false, 'homologation')", [id])
    // Idempotente en su ambiente; en el otro, jamás pisa la factura.
    await db.query("select * from complete_arca_invoice($1, 3, 11, 5, 'CAE', '2026-10-10', now(), false, 'homologation')", [id])
    await assert.rejects(
      db.query("select * from complete_arca_invoice($1, 3, 11, 5, 'CAE', '2026-10-10', now(), false, 'production')", [id]),
      /INVOICE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER/,
    )
    // Un comprobante sin ambiente no se puede guardar por fuera de las RPCs.
    const other = await paidOrder(db)
    await assert.rejects(
      db.query("update ordenes set invoice_cae='X', invoice_number=9, invoice_point=3 where id=$1", [other]),
      /ordenes_invoice_arca_environment_required/,
    )
  } finally {
    await db.close()
  }
})

test("factura: el servicio persiste el ambiente real del gateway; ambos ambientes numeran por separado", async () => {
  const db = await setupInvoicingDb()
  try {
    const homologation = new FakeArca(POINT, "homologation")
    const production = new FakeArca(POINT, "production")
    const client = rpcClient(db)
    const a = await paidOrder(db)
    const b = await paidOrder(db)
    const first = await processArcaInvoice(client, { gateway: homologation, pointOfSale: POINT, orderId: a, manual: true, now })
    const second = await processArcaInvoice(client, { gateway: production, pointOfSale: POINT, orderId: b, manual: true, now })
    assert.equal(first.status === "authorized" && first.invoice.environment, "homologation")
    assert.equal(second.status === "authorized" && second.invoice.environment, "production")
    const [rowA, rowB] = [await loadOrder(db, a), await loadOrder(db, b)]
    assert.deepEqual([Number(rowA.invoice_number), rowA.invoice_arca_environment], [1, "homologation"])
    assert.deepEqual([Number(rowB.invoice_number), rowB.invoice_arca_environment], [1, "production"])
    assert.equal(homologation.requests + production.requests, 2)
  } finally {
    await db.close()
  }
})

test("conciliación: un número pedido en homologación nunca se concilia contra producción", async () => {
  const db = await setupInvoicingDb()
  try {
    const homologation = new FakeArca(POINT, "homologation")
    const production = new FakeArca(POINT, "production")
    const client = rpcClient(db)
    const id = await paidOrder(db, 1000)
    // Homologación recibe el pedido y la respuesta se pierde.
    homologation.next.push("lost_after_authorize")
    const lost = await processArcaInvoice(client, { gateway: homologation, pointOfSale: POINT, orderId: id, manual: true, now })
    assert.equal(lost.status, "failed")
    assert.equal(Number((await loadOrder(db, id)).invoice_requested_number), 1)

    // Producción tiene un comprobante 1 idéntico (importe y fecha).
    production.vouchers.set(1, { total: 1000, cae: "CAE-PROD-1", caeDue: "20261010", date: "20260927" })
    const consults: number[] = []
    const originalConsult = production.consult.bind(production)
    production.consult = async (...args) => {
      consults.push(args[1])
      return originalConsult(...args)
    }
    const crossed = await processArcaInvoice(client, { gateway: production, pointOfSale: POINT, orderId: id, manual: true, now })
    assert.equal(crossed.status === "failed" && crossed.willRetry, false, "revisión manual, sin reintento")
    const row = await loadOrder(db, id)
    assert.equal(row.invoice_cae, null, "no adopta el comprobante de producción")
    assert.equal(Number(row.invoice_requested_number), 1, "no libera el número pedido en homologación")
    assert.equal(row.invoice_arca_environment, "homologation")
    assert.match(String(row.invoice_error), /no se concilia entre ambientes/)
    assert.deepEqual(consults, [], "ni siquiera consulta producción")
    assert.equal(production.requests, 0)

    // De vuelta en homologación: adopta el suyo, sin pedir otro CAE.
    const reconciled = await processArcaInvoice(client, { gateway: homologation, pointOfSale: POINT, orderId: id, manual: true, now })
    assert.equal(reconciled.status === "authorized" && reconciled.invoice.reconciled, true)
    assert.equal(homologation.requests, 1)
  } finally {
    await db.close()
  }
})

test("liberar un número (rechazo definitivo) limpia su ambiente", async () => {
  const db = await setupInvoicingDb()
  try {
    const id = await paidOrder(db)
    await claimed(db, id)
    await db.query("select * from record_arca_invoice_request($1, 3, 11, 8, 1000, '20260927', 'production')", [id])
    const released = (await db.query<Record<string, unknown>>(
      "select * from fail_arca_invoice_attempt($1, 'rechazo 10016', interval '2 minutes', true)", [id])).rows[0]
    assert.equal(released.invoice_requested_number, null)
    assert.equal(released.invoice_arca_environment, null)
  } finally {
    await db.close()
  }
})

test("datos existentes: comprobantes previos quedan como homologation, sin borrar ni tocar nada más", async () => {
  const db = await setupInvoicingDb({ environmentIsolation: false })
  try {
    // Como los pedidos 11 y 12: facturas 1-73 y 1-74 emitidas antes del cambio.
    const eleven = await paidOrder(db, 900)
    const twelve = await paidOrder(db, 900)
    const pending = await paidOrder(db, 500)
    await db.query(
      `update ordenes set invoice_status='authorized', invoice_point=1, invoice_number=73, invoice_cae='86390000000073',
         invoice_cae_due='2026-10-04' where id=$1`, [eleven])
    await db.query(
      `update ordenes set invoice_status='authorized', invoice_point=1, invoice_number=74, invoice_cae='86390927873264',
         invoice_cae_due='2026-10-05' where id=$1`, [twelve])
    const before = await Promise.all([eleven, twelve, pending].map((id) => loadOrder(db, id)))

    await applyEnvironmentIsolation(db)

    const after = await Promise.all([eleven, twelve, pending].map((id) => loadOrder(db, id)))
    assert.equal(after[0].invoice_arca_environment, "homologation")
    assert.equal(after[1].invoice_arca_environment, "homologation")
    assert.equal(after[2].invoice_arca_environment, null, "sin comprobante: sin ambiente")
    after.forEach((row, index) => {
      assert.deepEqual({ ...row, invoice_arca_environment: null }, { ...before[index], invoice_arca_environment: null },
        "ningún otro dato cambia")
    })

    // Producción puede usar 1-73 y 1-74 sin chocar con los de prueba.
    await db.query("select set_config('request.jwt.claim.role','service_role',false)")
    const production = await paidOrder(db, 900)
    await claimed(db, production)
    await db.query("select * from record_arca_invoice_request($1, 1, 11, 73, 900, '20260927', 'production')", [production])
  } finally {
    await db.close()
  }
})

test("permisos: firmas nuevas sólo service_role; las firmas sin ambiente ya no existen", async () => {
  const db = await setupInvoicingDb()
  try {
    const { rows } = await db.query<Record<string, unknown>>(`
      select
        to_regprocedure('public.record_arca_invoice_request(bigint, integer, integer, bigint, numeric, text)') is null as old_record_gone,
        to_regprocedure('public.complete_arca_invoice(bigint, integer, integer, bigint, text, date, timestamptz, boolean)') is null as old_complete_gone,
        has_function_privilege('anon', 'public.record_arca_invoice_request(bigint, integer, integer, bigint, numeric, text, text)', 'EXECUTE') as anon_record,
        has_function_privilege('authenticated', 'public.record_arca_invoice_request(bigint, integer, integer, bigint, numeric, text, text)', 'EXECUTE') as auth_record,
        has_function_privilege('authenticated', 'public.complete_arca_invoice(bigint, integer, integer, bigint, text, date, timestamptz, boolean, text)', 'EXECUTE') as auth_complete,
        has_function_privilege('authenticated', 'public.fail_arca_invoice_attempt(bigint, text, interval, boolean)', 'EXECUTE') as auth_fail,
        has_function_privilege('service_role', 'public.record_arca_invoice_request(bigint, integer, integer, bigint, numeric, text, text)', 'EXECUTE') as service_record
    `)
    assert.deepEqual(rows[0], {
      old_record_gone: true, old_complete_gone: true, anon_record: false, auth_record: false,
      auth_complete: false, auth_fail: false, service_record: true,
    })
    const id = await paidOrder(db)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(
      db.query("select * from record_arca_invoice_request($1, 3, 11, 1, 1000, '20260927', 'production')", [id]),
      /FORBIDDEN/,
    )
    await assert.rejects(
      db.query("select * from complete_arca_invoice($1, 3, 11, 1, 'X', '2026-10-10', now(), false, 'production')", [id]),
      /FORBIDDEN/,
    )
  } finally {
    await db.close()
  }
})

test("sólo 'production' es fiscal; sin ambiente se trata como prueba", () => {
  assert.equal(isFiscalArcaVoucher("production"), true)
  for (const value of ["homologation", null, undefined, "", "PRODUCTION", "qa"]) {
    assert.equal(isFiscalArcaVoucher(value), false, String(value))
  }
  assert.equal(parseArcaEnvironment("homologation"), "homologation")
  assert.equal(parseArcaEnvironment("prod"), null)
})
