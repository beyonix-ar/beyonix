import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { createAnalyticsDb, SESSION_A, SESSION_B } from "./analytics-db.test-helper.ts"

// Analítica comercial sin compras de prueba (20261124121000) sobre las
// migraciones reales: la compra de prueba sigue registrada en
// analytics_purchases (historial intacto) pero no suma compras, ingresos ni
// conversión.

const EXCLUSION = readFileSync("supabase/migrations/20261124121000_analytics_exclude_test_orders.sql", "utf8")

test("funnel y conversión excluyen las compras de prueba; analytics_purchases las conserva", async () => {
  const db = await createAnalyticsDb()
  try {
    await db.exec("alter table public.ordenes add column test_order_at timestamptz")
    await db.exec(EXCLUSION)
    await db.exec(`
      insert into public.analytics_events (event_type, session_id, product_id, occurred_at) values
        ('product_view', '${SESSION_A}', 1, '2026-11-20 12:00-03'),
        ('product_view', '${SESSION_B}', 1, '2026-11-20 12:05-03');
      insert into public.ordenes (id, total, estado, payment_status, financial_status, paid_at, payment_confirmed_at) values
        (19, 20, 'pendiente', 'pending', 'pending_payment', null, null),
        (40, 1000, 'pendiente', 'pending', 'pending_payment', null, null);
      insert into public.orden_items (id, orden_id, producto_id, cantidad, precio) values (26, 19, 1, 1, 20), (60, 40, 1, 1, 1000);
      insert into public.analytics_order_sessions (order_id, session_id) values (19, '${SESSION_A}'), (40, '${SESSION_B}');
      update public.ordenes set estado = 'pagado', payment_status = 'approved', financial_status = 'payment_confirmed',
        paid_at = '2026-11-20 12:10-03', payment_confirmed_at = '2026-11-20 12:10-03';
    `)
    const funnel = async () => (await db.query<{ purchases: number; revenue: number; funnel_purchase: number }>(
      "select purchases::int, revenue::float as revenue, funnel_purchase::int from public.admin_commerce_funnel('2026-11-20', '2026-11-20', '2026-11-19', '2026-11-19') where period = 'current'",
    )).rows[0]
    const conversion = async () => (await db.query<{ purchased_sessions: number }>(
      "select purchased_sessions::int from public.admin_product_conversion('2026-11-20', '2026-11-20') where product_id = 1",
    )).rows[0].purchased_sessions

    assert.deepEqual(await funnel(), { purchases: 2, revenue: 1020, funnel_purchase: 2 })
    assert.equal(await conversion(), 2)

    await db.exec("update public.ordenes set test_order_at = now() where id = 19")
    assert.deepEqual(await funnel(), { purchases: 1, revenue: 1000, funnel_purchase: 1 }, "BX-1019 fuera de compras e ingresos")
    assert.equal(await conversion(), 1, "BX-1019 fuera de la conversión por producto")
    assert.equal((await db.query("select 1 from public.analytics_purchases where order_id = 19")).rows.length, 1, "el registro original se conserva")

    const privileges = (await db.query<Record<string, boolean>>(`select
      has_function_privilege('authenticated', 'analytics_commercial_purchases()', 'EXECUTE') a,
      has_function_privilege('anon', 'analytics_commercial_purchases()', 'EXECUTE') b,
      has_function_privilege('service_role', 'admin_product_conversion(date,date)', 'EXECUTE') c,
      has_function_privilege('authenticated', 'admin_product_conversion(date,date)', 'EXECUTE') d`)).rows[0]
    assert.deepEqual(privileges, { a: false, b: false, c: true, d: false })
  } finally {
    await db.close()
  }
})
