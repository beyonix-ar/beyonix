import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Migración real de Analítica (20261026100000) sobre PostgreSQL embebido:
// vista única por sesión/producto, límites de abuso, ranking por fechas de
// Argentina y permisos (anon/authenticated sin acceso).

const MIGRATION = readFileSync("supabase/migrations/20261026100000_analytics_events_product_views.sql", "utf8")

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

async function createDb() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create table public.productos (id bigint primary key, nombre text not null, slug text not null, activo boolean default true, imagen_principal text);
    create table public.producto_variantes (id bigint primary key, producto_id bigint not null);
    create table public.imagenes_producto (id bigint primary key, producto_id bigint, url text not null, orden integer default 0);
    insert into auth.users values ('${USER}');
    insert into public.productos values
      (1, 'Auricular Malibu', 'auricular-malibu', true, 'https://cdn.test/malibu.webp'),
      (2, 'Soporte Notebook HUB', 'soporte-hub', true, ''),
      (3, 'Pava 12V', 'pava-12v', true, null),
      (4, 'Producto pausado', 'pausado', false, null);
    insert into public.imagenes_producto values (10, 2, 'https://cdn.test/hub-2.webp', 2), (11, 2, 'https://cdn.test/hub-1.webp', 1);`)
  await db.exec(MIGRATION)
  return db
}

async function record(db: PGlite, session: string, product: number, extra = "") {
  const result = await db.query<{ status: string }>(
    `select public.record_product_view('${session}'::uuid, ${product}${extra}) as status`,
  )
  return result.rows[0].status
}

async function count(db: PGlite, where = "true") {
  const result = await db.query<{ total: number }>(`select count(*)::int as total from public.analytics_events where ${where}`)
  return result.rows[0].total
}

test("product_view: vista única por sesión y producto en 30 minutos; otra sesión u otro producto cuentan", async () => {
  const db = await createDb()
  try {
    assert.equal(await record(db, SESSION_A, 1), "recorded", "primera visita")
    assert.equal(await record(db, SESSION_A, 1), "duplicate", "refresh inmediato")
    assert.equal(await record(db, SESSION_A, 1), "duplicate", "otro refresh")
    assert.equal(await record(db, SESSION_B, 1), "recorded", "otra sesión")
    assert.equal(await record(db, SESSION_A, 2), "recorded", "otro producto")
    assert.equal(await count(db), 3)

    // Pasada la ventana desde la última vista contada, vuelve a contar.
    await db.exec(`update public.analytics_events set occurred_at = now() - interval '31 minutes'
      where session_id = '${SESSION_A}' and product_id = 1`)
    assert.equal(await record(db, SESSION_A, 1), "recorded", "fuera de la ventana")
    await db.exec(`update public.analytics_events set occurred_at = now() - interval '29 minutes'
      where session_id = '${SESSION_A}' and product_id = 1 and occurred_at > now() - interval '1 minute'`)
    assert.equal(await record(db, SESSION_A, 1), "duplicate", "dentro de la ventana")
  } finally { await db.close() }
})

test("product_view: producto inexistente, inactivo o inválido no se registra", async () => {
  const db = await createDb()
  try {
    assert.equal(await record(db, SESSION_A, 999), "invalid_product")
    assert.equal(await record(db, SESSION_A, 4), "invalid_product", "producto pausado")
    assert.equal(await record(db, SESSION_A, 0), "invalid")
    assert.equal(await count(db), 0)
    await assert.rejects(db.exec(`insert into public.analytics_events (event_type, session_id, product_id) values ('purchase', '${SESSION_A}', 1)`), /event_type_check/)
    await assert.rejects(db.exec(`insert into public.analytics_events (event_type, session_id) values ('product_view', '${SESSION_A}')`), /product_check/)
    await assert.rejects(record(db, SESSION_A, 1, ", null, 'banner'"), /source_check/)
    await assert.rejects(record(db, SESSION_A, 1, ", null, null, 'smart-tv'"), /device_type_check/)
    await assert.rejects(record(db, SESSION_A, 1, ", null, null, null, '203.0.113.9'"), /client_key_check/, "nunca un IP en claro")
  } finally { await db.close() }
})

test("product_view: guarda usuario, origen y dispositivo validados, sin datos personales", async () => {
  const db = await createDb()
  try {
    const key = "0123456789abcdef0123456789abcdef"
    assert.equal(await record(db, SESSION_A, 1, `, '${USER}'::uuid, 'quick_view', 'mobile', '${key}'`), "recorded")
    const { rows } = await db.query<Record<string, unknown>>("select * from public.analytics_events")
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "client_key", "device_type", "event_type", "id", "occurred_at", "product_id", "session_id", "source", "user_id", "variant_id",
    ])
    assert.equal(rows[0].user_id, USER)
    assert.equal(rows[0].source, "quick_view")
    assert.equal(rows[0].device_type, "mobile")
    assert.equal(rows[0].variant_id, null)
  } finally { await db.close() }
})

test("product_view: límites por sesión (120/h) y por origen (600/h)", async () => {
  const db = await createDb()
  try {
    await db.exec(`insert into public.productos select g, 'P' || g, 'p-' || g, true, null from generate_series(100, 800) g`)
    await db.exec(`insert into public.analytics_events (event_type, session_id, product_id, occurred_at)
      select 'product_view', '${SESSION_A}', g, now() - interval '5 minutes' from generate_series(100, 219) g`)
    assert.equal(await record(db, SESSION_A, 1), "rate_limited", "sesión con 120 vistas en la última hora")
    await db.exec(`update public.analytics_events set occurred_at = now() - interval '61 minutes' where session_id = '${SESSION_A}'`)
    assert.equal(await record(db, SESSION_A, 1), "recorded", "la ventana de una hora se libera")

    const key = "ffffffffffffffffffffffffffffffff"
    await db.exec(`insert into public.analytics_events (event_type, session_id, product_id, client_key)
      select 'product_view', gen_random_uuid(), 100 + (g % 600), '${key}' from generate_series(1, 600) g`)
    assert.equal(await record(db, SESSION_B, 2, `, null, null, null, '${key}'`), "rate_limited", "mismo origen rotando sesiones")
    assert.equal(await record(db, SESSION_B, 2, `, null, null, null, '${"e".repeat(32)}'`), "recorded", "otro origen")
  } finally { await db.close() }
})

test("admin_product_view_stats: ranking por vistas dentro del rango de fechas de Argentina", async () => {
  const db = await createDb()
  try {
    const insert = (product: number, at: string, times: number) => db.exec(`insert into public.analytics_events (event_type, session_id, product_id, occurred_at)
      select 'product_view', gen_random_uuid(), ${product}, '${at}'::timestamptz from generate_series(1, ${times})`)
    await insert(1, "2026-10-20 10:00-03", 5)
    await insert(2, "2026-10-20 23:59-03", 3)
    await insert(3, "2026-10-21 00:00-03", 2)   // 03:00 UTC del 21: día siguiente en Argentina
    await insert(1, "2026-10-19 23:59-03", 7)   // fuera del rango
    await insert(2, "2026-10-21 02:30+00", 4)   // 23:30 del 20 en Argentina: dentro

    const stats = async (from: string, to: string) => (await db.query<{ product_id: number; product_name: string; product_slug: string; product_image: string | null; views: number }>(
      `select product_id::int, product_name, product_slug, product_image, views::int from public.admin_product_view_stats('${from}', '${to}')`,
    )).rows

    assert.deepEqual(await stats("2026-10-20", "2026-10-20"), [
      { product_id: 2, product_name: "Soporte Notebook HUB", product_slug: "soporte-hub", product_image: "https://cdn.test/hub-1.webp", views: 7 },
      { product_id: 1, product_name: "Auricular Malibu", product_slug: "auricular-malibu", product_image: "https://cdn.test/malibu.webp", views: 5 },
    ])
    assert.deepEqual((await stats("2026-10-19", "2026-10-21")).map((row) => [row.product_id, row.views]), [[1, 12], [2, 7], [3, 2]])
    assert.deepEqual(await stats("2026-10-22", "2026-10-30"), [], "sin vistas: sin filas (nunca productos con 0)")
    assert.deepEqual(await stats("2026-10-21", "2026-10-20"), [], "rango invertido")
  } finally { await db.close() }
})

test("permisos: anon y authenticated no leen, escriben ni ejecutan; service_role sí", async () => {
  const db = await createDb()
  try {
    await record(db, SESSION_A, 1)
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`)
      await assert.rejects(db.query("select * from public.analytics_events"), /permission denied/i, `${role}: select`)
      await assert.rejects(db.exec(`insert into public.analytics_events (event_type, session_id, product_id) values ('product_view', '${SESSION_B}', 1)`), /permission denied/i, `${role}: insert`)
      await assert.rejects(db.query(`select public.record_product_view('${SESSION_B}'::uuid, 1)`), /permission denied/i, `${role}: record`)
      await assert.rejects(db.query("select * from public.admin_product_view_stats('2026-01-01', '2026-12-31')"), /permission denied/i, `${role}: stats`)
      await db.exec("reset role")
    }
    await db.exec("set role service_role")
    assert.equal((await db.query("select * from public.admin_product_view_stats('2000-01-01', '2100-12-31')")).rows.length, 1)
    assert.equal((await db.query<{ status: string }>(`select public.record_product_view('${SESSION_B}'::uuid, 1) as status`)).rows[0].status, "recorded")
    await db.exec("reset role")
  } finally { await db.close() }
})
