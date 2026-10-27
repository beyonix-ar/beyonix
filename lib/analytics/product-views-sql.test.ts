import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Migraciones reales de Analítica (20261026100000 + 20261026120000) sobre
// PostgreSQL embebido: vista única por sesión/producto, límites de abuso,
// ranking por fechas de Argentina, histórico que sobrevive a borrados,
// archivados y renombres, y permisos (anon/authenticated sin acceso).

const MIGRATIONS = [
  "20261026100000_analytics_events_product_views.sql",
  "20261026120000_analytics_history_merge_snapshots.sql",
  "20261026140000_analytics_peak_hour.sql",
  "20261026160000_analytics_peak_weekday.sql",
  "20261026180000_analytics_views_by_weekday.sql",
  "20261027100000_analytics_views_by_hour.sql",
].map((file) => readFileSync(`supabase/migrations/${file}`, "utf8"))

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
  for (const migration of MIGRATIONS) await db.exec(migration)
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

type StatsRow = { product_id: number; product_name: string; product_slug: string; product_image: string | null; product_available: boolean; views: number }

async function allTimeStats(db: PGlite) {
  return (await db.query<StatsRow>(
    "select product_id::int, product_name, product_slug, product_image, product_available, views::int from public.admin_product_view_stats('2000-01-01', '2100-12-31')",
  )).rows
}

test("histórico: borrar un producto no borra sus vistas y el ranking lo sigue mostrando con su snapshot", async () => {
  const db = await createDb()
  try {
    assert.equal(await record(db, SESSION_A, 2), "recorded")
    assert.equal(await record(db, SESSION_B, 2), "recorded")
    assert.equal(await record(db, SESSION_A, 1), "recorded")
    await db.exec("update public.productos set nombre = 'Soporte HUB Pro', slug = 'soporte-hub-pro' where id = 2")
    await db.exec("delete from public.imagenes_producto where producto_id = 2 and id = 11")
    await db.exec("delete from public.productos where id = 2")

    assert.equal(await count(db, "product_id = 2"), 2, "los eventos sobreviven al borrado")
    assert.deepEqual(await allTimeStats(db), [
      // Última foto tomada justo antes del borrado: nombre nuevo e imagen que quedaba.
      { product_id: 2, product_name: "Soporte HUB Pro", product_slug: "soporte-hub-pro", product_image: "https://cdn.test/hub-2.webp", product_available: false, views: 2 },
      { product_id: 1, product_name: "Auricular Malibu", product_slug: "auricular-malibu", product_image: "https://cdn.test/malibu.webp", product_available: true, views: 1 },
    ])
  } finally { await db.close() }
})

test("histórico: producto archivado conserva sus vistas, sin PDP pública; renombrado usa el nombre actual", async () => {
  const db = await createDb()
  try {
    await record(db, SESSION_A, 1)
    await record(db, SESSION_A, 3)
    await db.exec("update public.productos set activo = false where id = 1")
    await db.exec("update public.productos set nombre = 'Pava eléctrica 12V' where id = 3")

    const rows = await allTimeStats(db)
    const archived = rows.find((row) => row.product_id === 1)!
    assert.equal(archived.views, 1, "sigue sumando al total")
    assert.equal(archived.product_available, false, "sin enlace público")
    assert.equal(archived.product_name, "Auricular Malibu")
    assert.equal(rows.find((row) => row.product_id === 3)!.product_name, "Pava eléctrica 12V", "si existe, se usa el dato actual")
    assert.equal(await record(db, SESSION_B, 1), "invalid_product", "un archivado no suma vistas nuevas")
  } finally { await db.close() }
})

test("snapshot: una fila por producto, se actualiza sólo si cambió y el histórico es legible tras renombrar y borrar", async () => {
  const db = await createDb()
  try {
    await record(db, SESSION_A, 1)
    await record(db, SESSION_B, 1)
    const snapshots = async () => (await db.query<{ product_id: number; product_name: string; updated_at: string }>(
      "select product_id::int, product_name, updated_at::text from public.analytics_product_snapshots order by product_id",
    )).rows
    const [first] = await snapshots()
    assert.equal((await snapshots()).length, 1)

    await db.exec("update public.productos set nombre = 'Auricular Malibu Max' where id = 1")
    assert.equal(await record(db, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", 1), "recorded")
    const [renamed] = await snapshots()
    assert.equal(renamed.product_name, "Auricular Malibu Max")
    assert.notEqual(renamed.updated_at, first.updated_at)

    await db.exec("update public.productos set nombre = 'Auricular Malibu Ultra' where id = 1")
    await db.exec("delete from public.productos where id = 1")
    assert.deepEqual((await allTimeStats(db)).map((row) => [row.product_name, row.views, row.product_available]), [["Auricular Malibu Ultra", 3, false]])
  } finally { await db.close() }
})

test("snapshot: los eventos previos a esta migración quedan cubiertos por el backfill", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users (id uuid primary key);
      create table public.productos (id bigint primary key, nombre text not null, slug text not null, activo boolean default true, imagen_principal text);
      create table public.producto_variantes (id bigint primary key, producto_id bigint not null);
      create table public.imagenes_producto (id bigint primary key, producto_id bigint, url text not null, orden integer default 0);
      insert into public.productos values (1, 'Auricular Malibu', 'auricular-malibu', true, 'https://cdn.test/malibu.webp');`)
    await db.exec(MIGRATIONS[0])
    await db.exec(`select public.record_product_view('${SESSION_A}'::uuid, 1)`)
    await db.exec(MIGRATIONS[1])
    await db.exec("delete from public.productos where id = 1")
    assert.deepEqual((await allTimeStats(db)).map((row) => [row.product_name, row.views]), [["Auricular Malibu", 1]])
  } finally { await db.close() }
})

test("horario pico: franja con más visualizaciones en hora de Argentina, empate a la más temprana, sin datos = sin filas", async () => {
  const db = await createDb()
  try {
    const views = (at: string, times: number, product = 1) => db.exec(`insert into public.analytics_events (event_type, session_id, product_id, occurred_at)
      select 'product_view', gen_random_uuid(), ${product}, '${at}'::timestamptz from generate_series(1, ${times})`)
    const peak = async (from: string, to: string) => (await db.query<{ peak_hour: number; peak_views: number; total_views: number }>(
      `select peak_hour, peak_views::int, total_views::int from public.admin_product_view_peak_hour('${from}', '${to}')`,
    )).rows

    // 20/10 (Argentina): 14 h = 28 (dos productos), 10 h = 9, 23 h = 4 cargadas en UTC (02:xx del 21).
    await views("2026-10-20 14:05-03", 20)
    await views("2026-10-20 14:59-03", 8, 2)
    await views("2026-10-20 10:30-03", 9)
    await views("2026-10-21 02:10+00", 4)
    // 21/10: empate 10 h y 18 h (6 y 6); 25/10: 3 a las 00 h; 26/10 (hoy del test): 5 a las 09 h.
    await views("2026-10-21 18:00-03", 6)
    await views("2026-10-21 10:59-03", 6)
    await views("2026-10-25 00:00-03", 3)
    await views("2026-10-26 09:15-03", 5)

    assert.deepEqual(await peak("2026-10-20", "2026-10-20"), [{ peak_hour: 14, peak_views: 28, total_views: 41 }], "A + B: las 02:10 UTC del 21 son las 23 h del 20 en Argentina (suman al 20)")
    assert.deepEqual(await peak("2026-10-21", "2026-10-21"), [{ peak_hour: 10, peak_views: 6, total_views: 12 }], "G: empate → la más temprana")
    assert.deepEqual(await peak("2026-10-26", "2026-10-26"), [{ peak_hour: 9, peak_views: 5, total_views: 5 }], "C: un solo día (Hoy)")
    assert.deepEqual(await peak("2026-10-20", "2026-10-26"), [{ peak_hour: 14, peak_views: 28, total_views: 61 }], "D: 7 días")
    assert.deepEqual(await peak("2026-09-27", "2026-10-26"), [{ peak_hour: 14, peak_views: 28, total_views: 61 }], "E: 30 días")
    assert.deepEqual(await peak("2026-10-24", "2026-10-25"), [{ peak_hour: 0, peak_views: 3, total_views: 3 }], "F: personalizado, extremos inclusive")
    assert.deepEqual(await peak("2026-10-22", "2026-10-24"), [], "H: sin vistas no devuelve 00:00 con 0")
    assert.deepEqual(await peak("2026-10-21", "2026-10-20"), [], "rango invertido")

    const ranking = await db.query<{ total: number }>("select sum(views)::int as total from public.admin_product_view_stats('2026-10-20', '2026-10-26')")
    assert.equal(ranking.rows[0].total, 61, "mismo total que Productos más vistos")
  } finally { await db.close() }
})

test("día con más visualizaciones: día de Argentina (ISO), empate al más temprano de la semana, sin datos = sin filas", async () => {
  const db = await createDb()
  try {
    const views = (at: string, times: number, product = 1) => db.exec(`insert into public.analytics_events (event_type, session_id, product_id, occurred_at)
      select 'product_view', gen_random_uuid(), ${product}, '${at}'::timestamptz from generate_series(1, ${times})`)
    const peak = async (from: string, to: string) => (await db.query<{ peak_weekday: number; peak_views: number; total_views: number }>(
      `select peak_weekday, peak_views::int, total_views::int from public.admin_product_view_peak_weekday('${from}', '${to}')`,
    )).rows

    // Octubre 2026: lunes 12 y 19, martes 20, miércoles 21, sábado 24, domingo 25, lunes 26 (hoy del test).
    await views("2026-10-12 15:00-03", 10)
    await views("2026-10-19 23:59-03", 40)
    await views("2026-10-20 12:00-03", 10, 2)
    await views("2026-10-21 02:30+00", 5)    // miércoles en UTC, martes 23:30 en Argentina
    await views("2026-10-21 12:00-03", 15)
    await views("2026-10-24 00:00-03", 30)
    await views("2026-10-25 23:59-03", 4)
    await views("2026-10-26 00:00-03", 2)    // ya es lunes 26: fuera de un rango que termina el 25
    await views("2026-10-26 09:00-03", 7)

    assert.deepEqual(await peak("2026-10-20", "2026-10-26"), [{ peak_weekday: 6, peak_views: 30, total_views: 73 }], "A + D: 7 días, gana el sábado")
    assert.deepEqual(await peak("2026-10-21", "2026-10-21"), [{ peak_weekday: 3, peak_views: 15, total_views: 15 }], "B: las 02:30 UTC del 21 son del martes en Argentina")
    assert.deepEqual(await peak("2026-10-20", "2026-10-21"), [{ peak_weekday: 2, peak_views: 15, total_views: 30 }], "G: martes 15 = miércoles 15 → martes")
    assert.deepEqual(await peak("2026-10-26", "2026-10-26"), [{ peak_weekday: 1, peak_views: 9, total_views: 9 }], "C + I: Hoy, un solo día posible (100%)")
    assert.deepEqual(await peak("2026-09-27", "2026-10-26"), [{ peak_weekday: 1, peak_views: 59, total_views: 123 }], "E: 30 días suma todos los lunes")
    assert.deepEqual(await peak("2026-10-24", "2026-10-25"), [{ peak_weekday: 6, peak_views: 30, total_views: 34 }], "F: personalizado, inicio inclusivo y fin exclusivo del día siguiente")
    assert.deepEqual(await peak("2026-10-22", "2026-10-23"), [], "H: sin vistas no devuelve \"Lunes, 0\"")
    assert.deepEqual(await peak("2026-10-21", "2026-10-20"), [], "rango invertido")

    const ranking = await db.query<{ total: number }>("select sum(views)::int as total from public.admin_product_view_stats('2026-10-20', '2026-10-26')")
    assert.equal(ranking.rows[0].total, 73, "mismo total que Productos más vistos")
  } finally { await db.close() }
})

test("por día de la semana: suma todas las fechas de cada día en hora de Argentina; sólo días con vistas", async () => {
  const db = await createDb()
  try {
    const views = (at: string, times: number, product = 1) => db.exec(`insert into public.analytics_events (event_type, session_id, product_id, occurred_at)
      select 'product_view', gen_random_uuid(), ${product}, '${at}'::timestamptz from generate_series(1, ${times})`)
    const byWeekday = async (from: string, to: string) => (await db.query<{ weekday: number; view_count: number }>(
      `select weekday, view_count::int from public.admin_product_views_by_weekday('${from}', '${to}')`,
    )).rows.map((row) => [row.weekday, row.view_count])

    // Octubre 2026: lunes 5, 12, 19 y 26 (hoy del test); martes 20; miércoles 21; sábado 24; domingo 25.
    await views("2026-10-05 10:00-03", 20)
    await views("2026-10-12 10:00-03", 30, 2)
    await views("2026-10-19 23:59-03", 25)
    await views("2026-10-26 09:00-03", 35)
    await views("2026-10-20 12:00-03", 10)
    await views("2026-10-21 02:30+00", 5)    // miércoles en UTC, martes 23:30 en Argentina
    await views("2026-10-21 12:00-03", 15)
    await views("2026-10-24 00:00-03", 30)
    await views("2026-10-25 23:59-03", 4)
    await views("2026-10-26 00:00-03", 2)    // ya es lunes 26: fuera de un rango que termina el 25

    assert.deepEqual(await byWeekday("2026-10-05", "2026-10-26"), [[1, 112], [2, 15], [3, 15], [6, 30], [7, 4]], "A + C + H: 4 lunes suman 20 + 30 + 25 + 35 + 2; sin filas para jueves y viernes")
    assert.deepEqual(await byWeekday("2026-10-21", "2026-10-21"), [[3, 15]], "B: las 02:30 UTC del 21 son del martes en Argentina")
    assert.deepEqual(await byWeekday("2026-10-26", "2026-10-26"), [[1, 37]], "D: Hoy")
    assert.deepEqual(await byWeekday("2026-10-20", "2026-10-26"), [[1, 37], [2, 15], [3, 15], [6, 30], [7, 4]], "E: 7 días")
    assert.deepEqual(await byWeekday("2026-09-27", "2026-10-26"), [[1, 112], [2, 15], [3, 15], [6, 30], [7, 4]], "F: 30 días")
    assert.deepEqual(await byWeekday("2026-10-24", "2026-10-25"), [[6, 30], [7, 4]], "G: personalizado, inicio inclusivo y fin exclusivo del día siguiente")
    assert.deepEqual(await byWeekday("2026-10-22", "2026-10-23"), [], "I: sin vistas, sin filas (el servidor completa los 7 ceros)")
    assert.deepEqual(await byWeekday("2026-10-21", "2026-10-20"), [], "rango invertido")

    const ranking = await db.query<{ total: number }>("select sum(views)::int as total from public.admin_product_view_stats('2026-09-27', '2026-10-26')")
    assert.equal(ranking.rows[0].total, 176, "mismo total que Productos más vistos")
  } finally { await db.close() }
})

test("consistencia: \"Día con más visualizaciones\" es siempre el máximo de la distribución por día (empate al más temprano)", async () => {
  const db = await createDb()
  try {
    // Distribuciones pseudoaleatorias con empates frecuentes, en hora de Argentina y UTC.
    let seed = 7
    const next = () => (seed = (seed * 48271) % 2147483647) % 4
    for (let day = 0; day < 42; day += 1) {
      const times = next()
      if (times > 0) {
        await db.exec(`insert into public.analytics_events (event_type, session_id, product_id, occurred_at)
          select 'product_view', gen_random_uuid(), 1, timestamptz '2026-09-14 22:30-03' + interval '${day} days' + interval '${next() * 2} hours'
          from generate_series(1, ${times})`)
      }
    }
    for (const [from, to] of [["2026-09-14", "2026-10-25"], ["2026-09-20", "2026-09-26"], ["2026-10-01", "2026-10-01"], ["2026-10-05", "2026-10-18"], ["2026-11-01", "2026-11-07"]]) {
      const distribution = (await db.query<{ weekday: number; view_count: number }>(
        `select weekday, view_count::int from public.admin_product_views_by_weekday('${from}', '${to}')`,
      )).rows
      const peak = (await db.query<{ peak_weekday: number; peak_views: number; total_views: number }>(
        `select peak_weekday, peak_views::int, total_views::int from public.admin_product_view_peak_weekday('${from}', '${to}')`,
      )).rows
      if (distribution.length === 0) {
        assert.deepEqual(peak, [], `${from}..${to}: sin vistas en ninguno de los dos`)
        continue
      }
      const max = Math.max(...distribution.map((row) => row.view_count))
      const expected = distribution.filter((row) => row.view_count === max).sort((a, b) => a.weekday - b.weekday)[0]
      assert.deepEqual(peak, [{
        peak_weekday: expected.weekday,
        peak_views: max,
        total_views: distribution.reduce((sum, row) => sum + row.view_count, 0),
      }], `${from}..${to}`)
    }
  } finally { await db.close() }
})

test("por hora del día: suma la misma hora de todas las fechas en hora de Argentina; sólo horas con vistas", async () => {
  const db = await createDb()
  try {
    const views = (at: string, times: number, product = 1) => db.exec(`insert into public.analytics_events (event_type, session_id, product_id, occurred_at)
      select 'product_view', gen_random_uuid(), ${product}, '${at}'::timestamptz from generate_series(1, ${times})`)
    const byHour = async (from: string, to: string) => (await db.query<{ hour: number; view_count: number }>(
      `select hour, view_count::int from public.admin_product_views_by_hour('${from}', '${to}')`,
    )).rows.map((row) => [row.hour, row.view_count])
    const peak = async (from: string, to: string) => (await db.query<{ peak_hour: number; peak_views: number; total_views: number }>(
      `select peak_hour, peak_views::int, total_views::int from public.admin_product_view_peak_hour('${from}', '${to}')`,
    )).rows

    // 20 h de lunes 19, martes 20 y miércoles 21 (dos productos): 10 + 15 + 20 = 45.
    await views("2026-10-19 20:10-03", 10)
    await views("2026-10-20 20:45-03", 15)
    await views("2026-10-21 20:00-03", 20, 2)
    await views("2026-10-21 02:30+00", 4)    // 02 h UTC del 21 = 23:30 del 20 en Argentina
    await views("2026-10-20 08:59-03", 3)
    await views("2026-10-25 23:59-03", 1)
    await views("2026-10-26 00:00-03", 2)    // 26 (hoy del test) a las 00 h: fuera de un rango que termina el 25
    await views("2026-10-26 09:15-03", 5)
    await views("2026-10-01 20:00-03", 7)    // sólo en 30 días
    await views("2026-09-26 12:00-03", 9)    // fuera de 30 días

    assert.deepEqual(await byHour("2026-10-19", "2026-10-21"), [[8, 3], [20, 45], [23, 4]], "A + C + H: la misma hora de varios días suma; sin filas para las horas sin vistas")
    assert.deepEqual(await byHour("2026-10-20", "2026-10-20"), [[8, 3], [20, 15], [23, 4]], "B: las 02:30 UTC del 21 son las 23 h del 20 en Argentina")
    assert.deepEqual(await byHour("2026-10-21", "2026-10-21"), [[20, 20]], "B: y no suman al 21")
    assert.deepEqual(await byHour("2026-10-26", "2026-10-26"), [[0, 2], [9, 5]], "D: Hoy")
    assert.deepEqual(await byHour("2026-10-20", "2026-10-26"), [[0, 2], [8, 3], [9, 5], [20, 35], [23, 5]], "E: 7 días")
    assert.deepEqual(await byHour("2026-09-27", "2026-10-26"), [[0, 2], [8, 3], [9, 5], [20, 52], [23, 5]], "F: 30 días")
    assert.deepEqual(await byHour("2026-10-24", "2026-10-25"), [[23, 1]], "G: personalizado, inicio inclusivo y fin exclusivo del día siguiente")
    assert.deepEqual(await byHour("2026-10-22", "2026-10-23"), [], "I: sin vistas, sin filas (el servidor completa los 24 ceros)")
    assert.deepEqual(await byHour("2026-10-21", "2026-10-20"), [], "rango invertido")

    assert.deepEqual(await peak("2026-09-27", "2026-10-26"), [{ peak_hour: 20, peak_views: 52, total_views: 67 }], "L: el horario pico es la barra más alta, con el mismo total")
    const ranking = await db.query<{ total: number }>("select sum(views)::int as total from public.admin_product_view_stats('2026-09-27', '2026-10-26')")
    assert.equal(ranking.rows[0].total, 67, "mismo total que Productos más vistos")
  } finally { await db.close() }
})

test("consistencia: \"Horario pico\" es siempre el máximo de la distribución por hora (empate a la más temprana)", async () => {
  const db = await createDb()
  try {
    // Distribuciones pseudoaleatorias con empates frecuentes, cargadas en UTC y leídas en hora de Argentina.
    let seed = 11
    const next = () => (seed = (seed * 48271) % 2147483647) % 4
    for (let slot = 0; slot < 24 * 20; slot += 1) {
      const times = next()
      if (times > 0) {
        await db.exec(`insert into public.analytics_events (event_type, session_id, product_id, occurred_at)
          select 'product_view', gen_random_uuid(), 1, timestamptz '2026-09-30 21:30+00' + interval '${slot * 97} minutes'
          from generate_series(1, ${times})`)
      }
    }
    // Empate explícito: 10 h y 20 h con 30 vistas cada una → 10:00 – 11:00.
    await db.exec(`insert into public.analytics_events (event_type, session_id, product_id, occurred_at)
      select 'product_view', gen_random_uuid(), 1, timestamptz '2026-11-20 10:15-03' + (g % 2) * interval '10 hours' from generate_series(1, 60) g`)

    for (const [from, to] of [["2026-10-01", "2026-10-30"], ["2026-10-05", "2026-10-11"], ["2026-10-12", "2026-10-12"], ["2026-10-15", "2026-10-28"], ["2026-11-20", "2026-11-20"], ["2026-12-01", "2026-12-07"]]) {
      const distribution = (await db.query<{ hour: number; view_count: number }>(
        `select hour, view_count::int from public.admin_product_views_by_hour('${from}', '${to}')`,
      )).rows
      const peak = (await db.query<{ peak_hour: number; peak_views: number; total_views: number }>(
        `select peak_hour, peak_views::int, total_views::int from public.admin_product_view_peak_hour('${from}', '${to}')`,
      )).rows
      if (distribution.length === 0) {
        assert.deepEqual(peak, [], `${from}..${to}: sin vistas en ninguno de los dos`)
        continue
      }
      const max = Math.max(...distribution.map((row) => row.view_count))
      const expected = distribution.filter((row) => row.view_count === max).sort((a, b) => a.hour - b.hour)[0]
      assert.deepEqual(peak, [{
        peak_hour: expected.hour,
        peak_views: max,
        total_views: distribution.reduce((sum, row) => sum + row.view_count, 0),
      }], `${from}..${to}`)
    }
    assert.deepEqual((await db.query("select peak_hour, peak_views::int from public.admin_product_view_peak_hour('2026-11-20', '2026-11-20')")).rows, [{ peak_hour: 10, peak_views: 30 }], "M: empate → la hora más temprana")
  } finally { await db.close() }
})

test("permisos: anon y authenticated no leen, escriben ni ejecutan; service_role sí", async () => {
  const db = await createDb()
  try {
    for (const table of ["analytics_events", "analytics_product_snapshots"]) {
      const { rows } = await db.query<{ rls: boolean; policies: number }>(
        `select relrowsecurity as rls, (select count(*)::int from pg_policies where tablename = '${table}') as policies from pg_class where oid = 'public.${table}'::regclass`,
      )
      assert.deepEqual(rows[0], { rls: true, policies: 0 }, `${table}: RLS activo y sin políticas públicas`)
    }
    await record(db, SESSION_A, 1)
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`)
      await assert.rejects(db.query("select * from public.analytics_events"), /permission denied/i, `${role}: select`)
      await assert.rejects(db.exec(`insert into public.analytics_events (event_type, session_id, product_id) values ('product_view', '${SESSION_B}', 1)`), /permission denied/i, `${role}: insert`)
      await assert.rejects(db.query(`select public.record_product_view('${SESSION_B}'::uuid, 1)`), /permission denied/i, `${role}: record`)
      await assert.rejects(db.query("select * from public.admin_product_view_stats('2026-01-01', '2026-12-31')"), /permission denied/i, `${role}: stats`)
      await assert.rejects(db.query("select * from public.analytics_product_snapshots"), /permission denied/i, `${role}: snapshots`)
      await assert.rejects(db.query("select * from public.admin_product_view_peak_hour('2026-01-01', '2026-12-31')"), /permission denied/i, `${role}: horario pico`)
      await assert.rejects(db.query("select * from public.admin_product_view_peak_weekday('2026-01-01', '2026-12-31')"), /permission denied/i, `${role}: día con más visualizaciones`)
      await assert.rejects(db.query("select * from public.admin_product_views_by_weekday('2026-01-01', '2026-12-31')"), /permission denied/i, `${role}: por día de la semana`)
      await assert.rejects(db.query("select * from public.admin_product_views_by_hour('2026-01-01', '2026-12-31')"), /permission denied/i, `${role}: por hora del día`)
      await assert.rejects(db.query("select public.analytics_product_image(1, null)"), /permission denied/i, `${role}: imagen`)
      await db.exec("reset role")
    }
    await db.exec("set role service_role")
    assert.equal((await db.query("select * from public.admin_product_view_stats('2000-01-01', '2100-12-31')")).rows.length, 1)
    assert.equal((await db.query("select * from public.admin_product_view_peak_weekday('2000-01-01', '2100-12-31')")).rows.length, 1)
    assert.equal((await db.query("select * from public.admin_product_views_by_weekday('2000-01-01', '2100-12-31')")).rows.length, 1)
    assert.equal((await db.query("select * from public.admin_product_views_by_hour('2000-01-01', '2100-12-31')")).rows.length, 1)
    assert.equal((await db.query("select * from public.admin_product_view_peak_hour('2000-01-01', '2100-12-31')")).rows.length, 1)
    assert.equal((await db.query<{ status: string }>(`select public.record_product_view('${SESSION_B}'::uuid, 1) as status`)).rows[0].status, "recorded")
    await db.exec("reset role")
  } finally { await db.close() }
})
