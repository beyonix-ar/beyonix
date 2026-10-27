import assert from "node:assert/strict"
import test from "node:test"
import type { PGlite } from "@electric-sql/pglite"

import { isDashboardPaidSale } from "../business/dashboard-financials.ts"
import { createAnalyticsDb, SESSION_A, SESSION_B, USER } from "./analytics-db.test-helper.ts"
import { previousAnalyticsRange } from "./period-comparison.ts"

// Analítica comercial sobre las migraciones reales (PGlite): add_to_cart,
// search, checkout_started, purchase_completed (trigger de ordenes), funnel,
// abandono, conversión por producto, búsquedas y permisos.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const session = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`

async function status(db: PGlite, sql: string) {
  return (await db.query<{ status: string }>(`select ${sql} as status`)).rows[0].status
}

const addToCart = (db: PGlite, sessionId: string, eventId: number, product: number, variant: number | null = null) =>
  status(db, `public.record_add_to_cart('${sessionId}'::uuid, '${uuid(eventId)}'::uuid, ${product}, ${variant ?? "null"})`)

const search = (db: PGlite, sessionId: string, eventId: number, query: string) =>
  status(db, `public.record_search('${sessionId}'::uuid, '${uuid(eventId)}'::uuid, '${query.replace(/'/g, "''")}')`)

const checkout = (db: PGlite, sessionId: string) => status(db, `public.record_checkout_started('${sessionId}'::uuid)`)

const countEvents = async (db: PGlite, where: string) =>
  (await db.query<{ total: number }>(`select count(*)::int as total from public.analytics_events where ${where}`)).rows[0].total

const purchases = async (db: PGlite) => (await db.query<{ order_id: number; revenue: number; user_id: string | null; confirmed_at: string }>(
  "select order_id::int, revenue::float as revenue, user_id::text, confirmed_at::text from public.analytics_purchases order by order_id",
)).rows

/** Evento con fecha controlada (los tests de período no pasan por los límites). */
const event = (db: PGlite, type: string, sessionId: string, at: string, product: number | null = null) => db.exec(
  `insert into public.analytics_events (event_type, session_id, product_id, occurred_at) values ('${type}', '${sessionId}', ${product ?? "null"}, ${at.startsWith("now") ? at : `'${at}'::timestamptz`})`,
)

async function order(db: PGlite, id: number, fields: Record<string, string | number | null> = {}, sessionId?: string) {
  const values = { usuario_id: null, total: 1000, original_total: null, estado: "pendiente", payment_status: "pending", financial_status: "pending_payment", ...fields }
  const columns = Object.keys(values)
  const literal = (value: string | number | null) => (value === null ? "null" : typeof value === "number" ? String(value) : `'${value}'`)
  await db.exec(`insert into public.ordenes (id, ${columns.join(", ")}) values (${id}, ${columns.map((key) => literal(values[key as keyof typeof values])).join(", ")})`)
  if (sessionId) await db.exec(`insert into public.analytics_order_sessions (order_id, session_id) values (${id}, '${sessionId}')`)
}

test("add_to_cart: cada acción real cuenta; doble request técnico no; producto y variante validados", async () => {
  const db = await createAnalyticsDb()
  try {
    assert.equal(await addToCart(db, SESSION_A, 1, 1, 21), "recorded", "producto + variante del producto")
    assert.equal(await addToCart(db, SESSION_A, 1, 1, 21), "duplicate", "mismo client_event_id (reintento/doble request)")
    assert.equal(await addToCart(db, SESSION_A, 2, 1, 21), "recorded", "segunda acción real del mismo producto: cuenta")
    assert.equal(await addToCart(db, SESSION_A, 3, 3), "recorded", "producto sin variante elegida")
    assert.equal(await addToCart(db, SESSION_A, 4, 1, 31), "invalid_product", "variante de otro producto")
    assert.equal(await addToCart(db, SESSION_A, 5, 4), "invalid_product", "producto pausado")
    assert.equal(await addToCart(db, SESSION_A, 6, 999), "invalid_product", "producto inexistente")
    assert.equal(await addToCart(db, SESSION_A, 7, 0), "invalid")
    const rows = (await db.query<{ product_id: number; variant_id: number | null; session_id: string }>(
      "select product_id::int, variant_id::int, session_id::text from public.analytics_events where event_type = 'add_to_cart' order by occurred_at, product_id",
    )).rows
    assert.deepEqual(rows, [
      { product_id: 1, variant_id: 21, session_id: SESSION_A },
      { product_id: 1, variant_id: 21, session_id: SESSION_A },
      { product_id: 3, variant_id: null, session_id: SESSION_A },
    ])
    assert.equal((await db.query("select 1 from public.analytics_product_snapshots where product_id = 3")).rows.length, 1, "mantiene el snapshot del producto")
  } finally { await db.close() }
})

test("add_to_cart: carreras del mismo client_event_id dejan un solo evento; límite de 60 por hora y sesión", async () => {
  const db = await createAnalyticsDb()
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => addToCart(db, SESSION_A, 1, 1)))
    assert.equal(results.filter((result) => result === "recorded").length, 1)
    assert.equal(await countEvents(db, "event_type = 'add_to_cart'"), 1)

    await db.exec(`insert into public.analytics_events (event_type, session_id, product_id, occurred_at)
      select 'add_to_cart', '${SESSION_B}', 1, now() - interval '10 minutes' from generate_series(1, 60)`)
    assert.equal(await addToCart(db, SESSION_B, 100, 1), "rate_limited")
    assert.equal(await addToCart(db, session(9), 101, 1), "recorded", "otra sesión no se ve afectada")
  } finally { await db.close() }
})

test("product_view: su límite por origen sólo cuenta vistas (los nuevos eventos no consumen el cupo)", async () => {
  const db = await createAnalyticsDb()
  try {
    const key = "abcdefabcdefabcdefabcdefabcdef12"
    await db.exec(`insert into public.analytics_events (event_type, session_id, product_id, client_key)
      select 'add_to_cart', gen_random_uuid(), 1, '${key}' from generate_series(1, 650)`)
    assert.equal(await status(db, `public.record_product_view('${SESSION_A}'::uuid, 1, null, null, null, '${key}')`), "recorded")
  } finally { await db.close() }
})

test("search: cuenta resultados en el servidor con la regla del catálogo; valida forma, duplicados y límite", async () => {
  const db = await createAnalyticsDb()
  try {
    assert.equal(await search(db, SESSION_A, 1, "auricular"), "recorded")
    assert.equal(await search(db, SESSION_A, 1, "auricular"), "duplicate")
    assert.equal(await search(db, SESSION_A, 2, "mouse gamer"), "recorded")
    assert.equal(await search(db, SESSION_A, 3, "pausado"), "recorded", "producto inactivo: no es resultado")
    assert.equal(await search(db, SESSION_A, 4, "Auricular"), "invalid", "debe llegar normalizada (minúsculas)")
    assert.equal(await search(db, SESSION_A, 5, "a".repeat(81)), "invalid", "máximo 80 caracteres")
    assert.equal(await search(db, SESSION_A, 6, ""), "invalid")
    const rows = (await db.query<{ search_query: string; search_results: number }>(
      "select search_query, search_results from public.analytics_events where event_type = 'search' order by occurred_at",
    )).rows
    assert.deepEqual(rows, [
      { search_query: "auricular", search_results: 1 },
      { search_query: "mouse gamer", search_results: 0 },
      { search_query: "pausado", search_results: 0 },
    ])
    await assert.rejects(db.exec(`insert into public.analytics_events (event_type, session_id, product_id, search_query, search_results)
      values ('search', '${SESSION_A}', 1, 'x', 0)`), /product_check/, "una búsqueda no lleva producto")

    await db.exec(`insert into public.analytics_events (event_type, session_id, search_query, search_results, occurred_at)
      select 'search', '${SESSION_B}', 'x', 0, now() - interval '5 minutes' from generate_series(1, 60)`)
    assert.equal(await search(db, SESSION_B, 50, "mate"), "rate_limited")
  } finally { await db.close() }
})

test("checkout_started: uno por sesión (recargar, reintentar y carreras no duplican)", async () => {
  const db = await createAnalyticsDb()
  try {
    const results = await Promise.all([checkout(db, SESSION_A), checkout(db, SESSION_A), checkout(db, SESSION_A)])
    assert.deepEqual(results.sort(), ["duplicate", "duplicate", "recorded"])
    assert.equal(await checkout(db, SESSION_A), "duplicate", "recarga")
    assert.equal(await checkout(db, SESSION_B), "recorded", "otra sesión")
    assert.equal(await countEvents(db, "event_type = 'checkout_started'"), 2)
    await assert.rejects(db.exec(`insert into public.analytics_events (event_type, session_id) values ('checkout_started', '${SESSION_A}')`), /checkout_session_key/)
  } finally { await db.close() }
})

test("purchase_completed: MP, transferencia, manual y saldo; una sola por orden; pendiente/cancelada/no-venta no cuentan", async () => {
  const db = await createAnalyticsDb()
  try {
    // Mercado Pago: el webhook aprueba (y se repite).
    await order(db, 1, { usuario_id: USER, total: 1500, original_total: 1800 }, SESSION_A)
    assert.deepEqual(await purchases(db), [], "pendiente: sin compra")
    await db.exec("update public.ordenes set payment_status = 'approved', paid_at = '2026-10-20 15:00-03', payment_confirmed_at = '2026-10-20 15:01-03', financial_status = 'payment_confirmed', estado = 'pagado' where id = 1")
    await db.exec("update public.ordenes set payment_status = 'approved', paid_at = '2026-10-20 15:00-03' where id = 1")
    await db.exec("update public.ordenes set estado = 'enviado' where id = 1")
    // Transferencia confirmada (automática o manual) y confirmación manual del Admin.
    await order(db, 2, { total: 900 })
    await db.exec("update public.ordenes set financial_status = 'payment_confirmed', payment_confirmed_at = '2026-10-21 10:00-03' where id = 2")
    await db.exec("update public.ordenes set financial_status = 'payment_confirmed', payment_confirmed_at = '2026-10-21 10:00-03' where id = 2")
    await order(db, 3, { total: 700 })
    await db.exec("update public.ordenes set payment_confirmed_amount = 700, payment_confirmed_at = '2026-10-22 09:00-03' where id = 3")
    // Pagada con saldo a favor: nace confirmada.
    await order(db, 4, { total: 300, estado: "pagado", paid_at: "2026-10-22 11:00-03", financial_status: "payment_confirmed" })
    // Nunca venta: cancelada sin pago, rechazada, aprobada después de cancelar, conflicto de stock.
    await order(db, 5, { estado: "cancelado", financial_status: "cancelled" })
    await order(db, 6, { payment_status: "rejected" })
    await order(db, 7, { estado: "cancelado", financial_status: "cancelled" })
    await db.exec("update public.ordenes set payment_status = 'approved_after_cancellation', paid_at = now() where id = 7")
    await order(db, 8, {})
    await db.exec("update public.ordenes set payment_status = 'approved_stock_conflict', paid_at = now() where id = 8")
    // Venta cobrada y después reintegrada: sigue siendo una compra (como en el Dashboard).
    await db.exec("update public.ordenes set financial_status = 'refunded', estado = 'cancelado' where id = 2")

    assert.deepEqual((await purchases(db)).map((row) => [row.order_id, row.revenue, row.user_id]), [
      [1, 1800, USER], [2, 900, null], [3, 700, null], [4, 300, null],
    ], "una compra por orden confirmada; revenue = total bruto (original_total o total)")
    const confirmedAt = (await db.query<{ same: boolean }>("select confirmed_at = '2026-10-20 15:01-03'::timestamptz as same from public.analytics_purchases where order_id = 1")).rows[0]
    assert.equal(confirmedAt.same, true, "fecha de confirmación del pago")
  } finally { await db.close() }
})

test("purchase_completed: la regla SQL es exactamente isDashboardPaidSale (Dashboard)", async () => {
  const db = await createAnalyticsDb()
  try {
    const estados = [null, "pendiente", "pagado", "approved", "enviado", "entregado", "cancelado", "en_devolucion"]
    const paymentStatuses = [null, "pending", "approved", "confirmado", "rejected", "approved_after_cancellation", "auto_verified_stock_conflict", "refunded"]
    const financialStatuses = [null, "pending_payment", "payment_submitted", "payment_confirmed", "refund_pending", "refunded", "cancelled"]
    for (const estado of estados) {
      for (const paymentStatus of paymentStatuses) {
        for (const financialStatus of financialStatuses) {
          for (const [paidAt, confirmedAmount] of [[null, null], ["2026-10-20T10:00:00Z", null], [null, 500], [null, 0]] as const) {
            const expected = isDashboardPaidSale({ estado, payment_status: paymentStatus, financial_status: financialStatus, paid_at: paidAt, payment_confirmed_amount: confirmedAmount })
            const sql = `select public.analytics_is_confirmed_sale(${[estado, paymentStatus, financialStatus].map((value) => (value === null ? "null" : `'${value}'`)).join(", ")}, ${paidAt ? `'${paidAt}'::timestamptz` : "null"}, ${confirmedAmount ?? "null"}) as sale`
            const actual = (await db.query<{ sale: boolean }>(sql)).rows[0].sale
            assert.equal(actual, expected, JSON.stringify({ estado, paymentStatus, financialStatus, paidAt, confirmedAmount }))
          }
        }
      }
    }
  } finally { await db.close() }
})

test("purchase_completed: un error de Analítica nunca bloquea la confirmación del pago", async () => {
  const db = await createAnalyticsDb()
  try {
    await order(db, 1, {})
    await db.exec("alter table public.analytics_purchases rename to analytics_purchases_off")
    await db.exec("update public.ordenes set financial_status = 'payment_confirmed', payment_confirmed_at = now() where id = 1")
    assert.equal((await db.query<{ financial_status: string }>("select financial_status from public.ordenes where id = 1")).rows[0].financial_status, "payment_confirmed")
  } finally { await db.close() }
})

type FunnelRow = Record<string, number | string>

async function funnel(db: PGlite, from: string, to: string) {
  const previous = previousAnalyticsRange({ from, to })
  const rows = (await db.query<FunnelRow>(
    `select period, viewed_sessions::int, cart_sessions::int, checkout_sessions::int, funnel_cart::int, funnel_checkout::int,
       funnel_purchase::int, purchases::int, attributed_purchases::int, revenue::float as revenue, attributed_revenue::float as attributed_revenue,
       evaluated_carts::int, abandoned_carts::int, abandoned_checkouts::int, carts_in_progress::int
     from public.admin_commerce_funnel('${from}', '${to}', '${previous.from}', '${previous.to}')`,
  )).rows
  return Object.fromEntries(rows.map((row) => [row.period, row]))
}

async function seedCommerce(db: PGlite) {
  const [s1, s2, s3, s4, s5, s6, s9] = [1, 2, 3, 4, 5, 6, 9].map(session)
  // S1: vista → carrito → checkout → compra confirmada (orden 101 con el producto 1).
  await event(db, "product_view", s1, "2026-10-21 10:00-03", 1)
  await event(db, "add_to_cart", s1, "2026-10-21 10:05-03", 1)
  await event(db, "checkout_started", s1, "2026-10-21 10:10-03")
  await order(db, 101, { total: 5000 }, s1)
  await db.exec("insert into public.orden_items (id, orden_id, producto_id) values (1, 101, 1)")
  await db.exec("update public.ordenes set payment_status = 'approved', paid_at = '2026-10-21 10:20-03', payment_confirmed_at = '2026-10-21 10:20-03' where id = 101")
  // S2: vista y 3 agregados del mismo producto, sin checkout → carrito abandonado.
  await event(db, "product_view", s2, "2026-10-22 12:00-03", 1)
  for (const minute of ["01", "02", "03"]) await event(db, "add_to_cart", s2, `2026-10-22 12:${minute}-03`, 1)
  // S3: vista, carrito y checkout con orden pendiente → checkout abandonado.
  await event(db, "product_view", s3, "2026-10-23 18:00-03", 2)
  await event(db, "add_to_cart", s3, "2026-10-23 18:02-03", 2)
  await event(db, "checkout_started", s3, "2026-10-23 18:05-03")
  await order(db, 102, {}, s3)
  // S4: sólo mira. S5: mira y va al checkout con un carrito de antes (sin add_to_cart).
  await event(db, "product_view", s4, "2026-10-24 09:00-03", 1)
  await event(db, "product_view", s5, "2026-10-25 20:00-03", 2)
  await event(db, "checkout_started", s5, "2026-10-25 20:01-03")
  // S6: agrega desde el listado sin abrir el producto.
  await event(db, "add_to_cart", s6, "2026-10-24 16:00-03", 3)
  // Orden 103 sin sesión (Admin): compra completada, no atribuible.
  await order(db, 103, { total: 2000, financial_status: "payment_confirmed", payment_confirmed_at: "2026-10-26 11:00-03" })
  // Período anterior (14–20 oct): una sesión que mira y agrega.
  await event(db, "product_view", s9, "2026-10-15 10:00-03", 1)
  await event(db, "add_to_cart", s9, "2026-10-15 10:01-03", 1)
}

test("funnel: sesiones únicas por etapa, progresión lógica, compras y abandono del período y del anterior", async () => {
  const db = await createAnalyticsDb()
  try {
    await seedCommerce(db)
    const report = await funnel(db, "2026-10-21", "2026-10-27")
    assert.deepEqual(report.current, {
      period: "current",
      viewed_sessions: 5, cart_sessions: 5, checkout_sessions: 3,
      funnel_cart: 4, funnel_checkout: 3, funnel_purchase: 1,
      purchases: 2, attributed_purchases: 1, revenue: 7000, attributed_revenue: 5000,
      evaluated_carts: 5, abandoned_carts: 2, abandoned_checkouts: 2, carts_in_progress: 0,
    }, "S2 con 3 agregados es 1 sesión; S5 (checkout sin add_to_cart) cuenta como carrito; S6 no entra al funnel; la orden sin sesión cuenta como compra pero no atribuible")
    assert.deepEqual(report.previous, {
      period: "previous",
      viewed_sessions: 1, cart_sessions: 1, checkout_sessions: 0,
      funnel_cart: 1, funnel_checkout: 0, funnel_purchase: 0,
      purchases: 0, attributed_purchases: 0, revenue: 0, attributed_revenue: 0,
      evaluated_carts: 1, abandoned_carts: 1, abandoned_checkouts: 0, carts_in_progress: 0,
    })

    const viewedTotal = (await db.query<{ total: number }>("select count(distinct session_id)::int as total from public.analytics_events where event_type = 'product_view' and occurred_at >= '2026-10-21 00:00-03' and occurred_at < '2026-10-28 00:00-03'")).rows[0].total
    assert.equal(viewedTotal, 5, "la etapa 1 es exactamente Sesiones con visualizaciones")
    const sessionStats = (await db.query<{ unique_sessions: number }>("select unique_sessions::int from public.admin_product_view_session_stats('2026-10-21', '2026-10-27')")).rows[0]
    assert.equal(sessionStats.unique_sessions, 5)

    // Una sola fecha (Hoy = 21/10): sólo S1. Sin datos: todo en 0 y nunca filas faltantes.
    assert.deepEqual([(await funnel(db, "2026-10-21", "2026-10-21")).current.funnel_purchase, (await funnel(db, "2026-10-21", "2026-10-21")).current.viewed_sessions], [1, 1])
    const empty = await funnel(db, "2026-11-10", "2026-11-12")
    assert.equal(empty.current.viewed_sessions, 0)
    assert.equal(empty.current.funnel_purchase, 0)
    assert.equal(Object.keys(empty).length, 2, "siempre período actual y anterior")
  } finally { await db.close() }
})

test("abandono: ventana de 24 h; un carrito reciente está en curso y una compra posterior lo saca de abandonados", async () => {
  const db = await createAnalyticsDb()
  try {
    const today = (await db.query<{ day: string }>("select (now() at time zone 'America/Argentina/Buenos_Aires')::date::text as day")).rows[0].day
    const yesterday = (await db.query<{ day: string }>("select ((now() at time zone 'America/Argentina/Buenos_Aires')::date - 2)::text as day")).rows[0].day
    const [recent, old] = [session(10), session(11)]
    await event(db, "add_to_cart", recent, "now() - interval '1 hour'", 1)
    await event(db, "add_to_cart", old, "now() - interval '25 hours'", 1)

    let current = (await funnel(db, yesterday, today)).current
    assert.deepEqual([current.carts_in_progress, current.evaluated_carts, current.abandoned_carts], [1, 1, 1], "el reciente está en curso; el de hace 25 h, abandonado")

    await order(db, 201, {}, recent)
    await db.exec("update public.ordenes set financial_status = 'payment_confirmed', payment_confirmed_at = now() where id = 201")
    await order(db, 202, {}, old)
    await db.exec("update public.ordenes set financial_status = 'payment_confirmed', payment_confirmed_at = now() where id = 202")
    current = (await funnel(db, yesterday, today)).current
    assert.deepEqual([current.carts_in_progress, current.evaluated_carts, current.abandoned_carts, current.abandoned_checkouts], [0, 2, 0, 0], "comprar después deja de ser abandono")
  } finally { await db.close() }
})

test("conversión por producto: cohorte de sesiones que lo vieron; agregados repetidos y compras por sesión", async () => {
  const db = await createAnalyticsDb()
  try {
    await seedCommerce(db)
    const rows = (await db.query<{ product_id: number; product_name: string; viewed_sessions: number; added_sessions: number; purchased_sessions: number }>(
      "select product_id::int, product_name, viewed_sessions::int, added_sessions::int, purchased_sessions::int from public.admin_product_conversion('2026-10-21', '2026-10-27')",
    )).rows
    assert.deepEqual(rows, [
      { product_id: 1, product_name: "Auricular Malibu", viewed_sessions: 3, added_sessions: 2, purchased_sessions: 1 },
      { product_id: 2, product_name: "Soporte Notebook HUB", viewed_sessions: 2, added_sessions: 1, purchased_sessions: 0 },
    ], "S2 agregó 3 veces: 1 sesión; el producto 3 (sólo agregado desde el listado) no tiene cohorte de vistas")
    assert.deepEqual((await db.query("select * from public.admin_product_conversion('2026-11-10', '2026-11-12')")).rows, [])
  } finally { await db.close() }
})

test("búsquedas: total, sesiones que buscaron, top y sin resultados", async () => {
  const db = await createAnalyticsDb()
  try {
    let id = 1
    for (const [sessionId, query] of [[SESSION_A, "auricular"], [SESSION_A, "auricular"], [SESSION_B, "auricular"], [SESSION_B, "mouse gamer"], [SESSION_A, "mouse gamer"], [SESSION_B, "pava"]]) {
      assert.equal(await search(db, sessionId, id++, query), "recorded")
    }
    const today = (await db.query<{ day: string }>("select (now() at time zone 'America/Argentina/Buenos_Aires')::date::text as day")).rows[0].day
    const rows = (await db.query<{ kind: string; term: string | null; searches: number; sessions: number }>(
      `select kind, term, searches::int, sessions::int from public.admin_search_stats('${today}', '${today}')`,
    )).rows
    assert.deepEqual(rows, [
      { kind: "total", term: null, searches: 6, sessions: 2 },
      { kind: "top", term: "auricular", searches: 3, sessions: 2 },
      { kind: "top", term: "mouse gamer", searches: 2, sessions: 2 },
      { kind: "top", term: "pava", searches: 1, sessions: 1 },
      { kind: "zero", term: "mouse gamer", searches: 2, sessions: 2 },
    ])
    assert.deepEqual((await db.query("select kind, searches::int from public.admin_search_stats('2026-01-01', '2026-01-02')")).rows, [{ kind: "total", searches: 0 }])
  } finally { await db.close() }
})

test("permisos: anon y authenticated no leen ni escriben eventos, compras ni sesiones de órdenes; nadie inserta compras a mano", async () => {
  const db = await createAnalyticsDb()
  try {
    await order(db, 1, {})
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`)
      for (const sql of [
        "select * from public.analytics_purchases",
        "select * from public.analytics_order_sessions",
        `insert into public.analytics_purchases (order_id, revenue, confirmed_at) values (1, 1, now())`,
        `insert into public.analytics_order_sessions (order_id, session_id) values (1, '${SESSION_A}')`,
        `select public.record_add_to_cart('${SESSION_A}'::uuid, '${uuid(1)}'::uuid, 1)`,
        `select public.record_search('${SESSION_A}'::uuid, '${uuid(2)}'::uuid, 'x')`,
        `select public.record_checkout_started('${SESSION_A}'::uuid)`,
        "select * from public.admin_commerce_funnel('2026-10-21', '2026-10-27', '2026-10-14', '2026-10-20')",
        "select * from public.admin_product_conversion('2026-10-21', '2026-10-27')",
        "select * from public.admin_search_stats('2026-10-21', '2026-10-27')",
        "select * from public.analytics_commerce_period('2026-10-21', '2026-10-27')",
      ]) {
        await assert.rejects(db.query(sql), /permission denied/i, `${role}: ${sql.slice(0, 60)}`)
      }
      await db.exec("reset role")
    }
    await db.exec("set role service_role")
    await assert.rejects(db.exec("insert into public.analytics_purchases (order_id, revenue, confirmed_at) values (1, 1, now())"), /permission denied/i, "ni el servidor: sólo el trigger de la orden")
    await assert.rejects(db.exec("update public.analytics_purchases set revenue = 0"), /permission denied/i)
    await db.exec(`insert into public.analytics_order_sessions (order_id, session_id) values (1, '${SESSION_A}')`)
    await assert.rejects(db.exec(`update public.analytics_order_sessions set session_id = '${SESSION_B}'`), /permission denied/i, "la sesión de una orden no se reasigna")
    await db.exec("reset role")
    await db.exec("update public.ordenes set financial_status = 'payment_confirmed', payment_confirmed_at = now() where id = 1")
    await db.exec("set role service_role")
    assert.equal((await db.query("select order_id from public.analytics_purchases")).rows.length, 1, "el trigger sí registra la compra")
    assert.equal(await status(db, `public.record_checkout_started('${SESSION_A}'::uuid)`), "recorded")
    assert.equal((await db.query("select * from public.admin_commerce_funnel('2026-10-21', '2026-10-27', '2026-10-14', '2026-10-20')")).rows.length, 2)
    await db.exec("reset role")
  } finally { await db.close() }
})
