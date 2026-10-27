import assert from "node:assert/strict"
import test from "node:test"
import type { PGlite } from "@electric-sql/pglite"

import { createAnalyticsDb, SESSION_A, SESSION_B } from "./analytics-db.test-helper.ts"

// Mínimo privilegio de Analítica sobre las migraciones reales, con defaults
// equivalentes a los de Supabase (todo objeto nuevo nace con permisos
// completos para anon, authenticated y service_role; service_role con
// BYPASSRLS): un GRANT parcial no alcanza, hay que revocar de verdad.

const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"] as const
type Privilege = (typeof PRIVILEGES)[number]

/** Permisos directos esperados de service_role (anon y authenticated: ninguno). */
const SERVICE_ROLE: Record<string, readonly Privilege[]> = {
  analytics_events: ["SELECT"],
  analytics_product_snapshots: ["SELECT"],
  analytics_order_sessions: ["SELECT", "INSERT"],
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

async function granted(db: PGlite, role: string, table: string) {
  const checks = PRIVILEGES.map((privilege) => `has_table_privilege('${role}', 'public.${table}', '${privilege}') as "${privilege}"`)
  const row = (await db.query<Record<Privilege, boolean>>(`select ${checks.join(", ")}`)).rows[0]
  return PRIVILEGES.filter((privilege) => row[privilege])
}

async function asServiceRole<T>(db: PGlite, run: () => Promise<T>) {
  await db.exec("set role service_role")
  try {
    return await run()
  } finally {
    await db.exec("reset role")
  }
}

const denied = (db: PGlite, sql: string, label: string) => assert.rejects(db.exec(sql), /permission denied/i, label)

test("ACL: service_role sólo lee eventos y snapshots, lee e inserta sesiones de órdenes; anon y authenticated nada", async () => {
  const db = await createAnalyticsDb()
  try {
    for (const [table, expected] of Object.entries(SERVICE_ROLE)) {
      assert.deepEqual(await granted(db, "service_role", table), expected, `service_role en ${table}`)
      for (const role of ["anon", "authenticated"]) assert.deepEqual(await granted(db, role, table), [], `${role} en ${table}`)
    }
    // analytics_purchases queda como la dejó 20261027190000 (sólo lectura de datos).
    const purchases = await granted(db, "service_role", "analytics_purchases")
    assert.ok(purchases.includes("SELECT"))
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const) {
      assert.ok(!purchases.includes(privilege), `analytics_purchases: sin ${privilege}`)
    }
    for (const role of ["anon", "authenticated"]) assert.deepEqual(await granted(db, role, "analytics_purchases"), [], `${role} en analytics_purchases`)
  } finally { await db.close() }
})

test("analytics_events: service_role lee pero no escribe directo; las RPC de tracking siguen registrando", async () => {
  const db = await createAnalyticsDb()
  try {
    await db.exec(`insert into public.analytics_events (event_type, session_id, product_id) values ('product_view', '${SESSION_B}', 2)`)
    await asServiceRole(db, async () => {
      assert.equal((await db.query("select * from public.analytics_events")).rows.length, 1, "SELECT permitido")
      await denied(db, `insert into public.analytics_events (event_type, session_id, product_id) values ('product_view', '${SESSION_A}', 1)`, "INSERT directo")
      await denied(db, "update public.analytics_events set product_id = 3", "UPDATE directo")
      await denied(db, "delete from public.analytics_events", "DELETE directo")
      await denied(db, "truncate public.analytics_events", "TRUNCATE")

      const record = async (sql: string) => (await db.query<{ status: string }>(`select ${sql} as status`)).rows[0].status
      assert.equal(await record(`public.record_product_view('${SESSION_A}'::uuid, 1)`), "recorded")
      assert.equal(await record(`public.record_add_to_cart('${SESSION_A}'::uuid, '${uuid(1)}'::uuid, 1, 21)`), "recorded")
      assert.equal(await record(`public.record_search('${SESSION_A}'::uuid, '${uuid(2)}'::uuid, 'auricular')`), "recorded")
      assert.equal(await record(`public.record_checkout_started('${SESSION_A}'::uuid)`), "recorded")
      assert.deepEqual(
        (await db.query<{ event_type: string }>(`select event_type from public.analytics_events where session_id = '${SESSION_A}' order by event_type`)).rows.map((row) => row.event_type),
        ["add_to_cart", "checkout_started", "product_view", "search"],
      )
    })
  } finally { await db.close() }
})

test("analytics_product_snapshots: service_role lee pero no escribe directo; tracking y borrado de producto siguen manteniendo el snapshot", async () => {
  const db = await createAnalyticsDb()
  try {
    await asServiceRole(db, async () => {
      await db.query(`select public.record_product_view('${SESSION_A}'::uuid, 2)`)
      await db.query(`select public.record_add_to_cart('${SESSION_A}'::uuid, '${uuid(3)}'::uuid, 3)`)
      assert.deepEqual(
        (await db.query<{ product_id: number }>("select product_id::int from public.analytics_product_snapshots order by product_id")).rows,
        [{ product_id: 2 }, { product_id: 3 }],
        "snapshot desde tracking (SELECT permitido)",
      )
      await denied(db, "insert into public.analytics_product_snapshots (product_id, product_name, product_slug) values (9, 'x', 'x')", "INSERT directo")
      await denied(db, "update public.analytics_product_snapshots set product_name = 'x'", "UPDATE directo")
      await denied(db, "delete from public.analytics_product_snapshots", "DELETE directo")
      await denied(db, "truncate public.analytics_product_snapshots", "TRUNCATE")
    })
    // El borrado de un producto lo hace el catálogo (no service_role sobre esta tabla): el trigger guarda la última foto.
    await db.exec("update public.productos set nombre = 'Soporte HUB Pro' where id = 2")
    await db.exec("delete from public.productos where id = 2")
    assert.equal((await db.query<{ product_name: string }>("select product_name from public.analytics_product_snapshots where product_id = 2")).rows[0].product_name, "Soporte HUB Pro")
  } finally { await db.close() }
})

test("analytics_order_sessions: service_role lee e inserta; no modifica ni borra; la primera atribución gana", async () => {
  const db = await createAnalyticsDb()
  try {
    await db.exec("insert into public.ordenes (id, total) values (1, 100)")
    await asServiceRole(db, async () => {
      await db.exec(`insert into public.analytics_order_sessions (order_id, session_id) values (1, '${SESSION_A}') on conflict (order_id) do nothing`)
      await db.exec(`insert into public.analytics_order_sessions (order_id, session_id) values (1, '${SESSION_B}') on conflict (order_id) do nothing`)
      assert.deepEqual((await db.query<{ session_id: string }>("select session_id::text from public.analytics_order_sessions")).rows, [{ session_id: SESSION_A }])
      await denied(db, `update public.analytics_order_sessions set session_id = '${SESSION_B}'`, "UPDATE")
      await denied(db, "delete from public.analytics_order_sessions", "DELETE")
      await denied(db, "truncate public.analytics_order_sessions", "TRUNCATE")
    })
  } finally { await db.close() }
})

test("analytics_purchases: igual que antes; sólo el trigger de la orden escribe", async () => {
  const db = await createAnalyticsDb()
  try {
    await db.exec("insert into public.ordenes (id, total) values (1, 100)")
    await db.exec("update public.ordenes set financial_status = 'payment_confirmed', payment_confirmed_at = now() where id = 1")
    await asServiceRole(db, async () => {
      assert.equal((await db.query("select * from public.analytics_purchases")).rows.length, 1, "el trigger registró la compra; SELECT permitido")
      await denied(db, "insert into public.analytics_purchases (order_id, revenue, confirmed_at) values (2, 1, now())", "INSERT")
      await denied(db, "update public.analytics_purchases set revenue = 0", "UPDATE")
      await denied(db, "delete from public.analytics_purchases", "DELETE")
    })
  } finally { await db.close() }
})

test("reportes Admin: con service_role siguen leyendo todo después del hardening (y no escriben)", async () => {
  const db = await createAnalyticsDb()
  try {
    await db.exec(`insert into public.analytics_events (event_type, session_id, product_id) values ('product_view', '${SESSION_A}', 1), ('add_to_cart', '${SESSION_A}', 1)`)
    await db.exec(`insert into public.analytics_events (event_type, session_id, search_query, search_results) values ('search', '${SESSION_A}', 'mate', 0)`)
    const today = (await db.query<{ day: string }>("select (now() at time zone 'America/Argentina/Buenos_Aires')::date::text as day")).rows[0].day
    const counts = await asServiceRole(db, async () => {
      const reports = [
        `admin_product_view_stats('${today}', '${today}')`,
        `admin_product_view_peak_hour('${today}', '${today}')`,
        `admin_product_view_peak_weekday('${today}', '${today}')`,
        `admin_product_views_by_weekday('${today}', '${today}')`,
        `admin_product_views_by_hour('${today}', '${today}')`,
        `admin_product_view_session_stats('${today}', '${today}')`,
        `admin_product_view_period_comparison('${today}', '${today}', '${today}'::date - 1, '${today}'::date - 1)`,
        `admin_commerce_funnel('${today}', '${today}', '${today}'::date - 1, '${today}'::date - 1)`,
        `admin_product_conversion('${today}', '${today}')`,
        `admin_search_stats('${today}', '${today}')`,
      ]
      const result: number[] = []
      for (const report of reports) result.push((await db.query(`select * from public.${report}`)).rows.length)
      return result
    })
    // Búsquedas: total + top + sin resultados ("mate" no tuvo resultados).
    assert.deepEqual(counts, [1, 1, 1, 1, 1, 1, 1, 2, 1, 3], "cada reporte devuelve su agregado")
    assert.equal((await db.query<{ total: number }>("select count(*)::int as total from public.analytics_events")).rows[0].total, 3, "leer no escribe")
  } finally { await db.close() }
})

test("funciones: anon y authenticated no ejecutan RPC de registro ni reportes; los helpers internos tampoco", async () => {
  const db = await createAnalyticsDb()
  try {
    const { rows } = await db.query<{ proname: string; anon: boolean; auth: boolean }>(
      `select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth
       from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and (p.proname like 'record_%' or p.proname like 'admin_%' or p.proname like 'analytics_%' or p.proname = 'merge_catalog_products')
       order by 1`,
    )
    assert.ok(rows.length >= 20, `funciones auditadas: ${rows.length}`)
    assert.deepEqual(rows.filter((row) => row.anon || row.auth).map((row) => row.proname), [], "ninguna ejecutable por anon/authenticated")
  } finally { await db.close() }
})

test("merge_catalog_products: search_path endurecido a public, pg_temp; el resto de las funciones de Analítica ya lo tenía", async () => {
  const db = await createAnalyticsDb()
  try {
    const { rows } = await db.query<{ proname: string; config: string | null; definer: boolean }>(
      `select p.proname, array_to_string(p.proconfig, ';') as config, p.prosecdef as definer
       from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and (p.proname like 'record_%' or p.proname like 'admin_%' or (p.proname like 'analytics_%' and p.proname <> 'analytics_is_confirmed_sale') or p.proname = 'merge_catalog_products')`,
    )
    const weak = rows.filter((row) => row.config !== "search_path=public, pg_temp")
    assert.deepEqual(weak.map((row) => `${row.proname}: ${row.config}`), [])
    assert.ok(rows.filter((row) => row.proname !== "analytics_is_confirmed_sale").every((row) => row.definer), "todas SECURITY DEFINER")
  } finally { await db.close() }
})
