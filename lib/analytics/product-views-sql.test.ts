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
      await assert.rejects(db.query("select public.analytics_product_image(1, null)"), /permission denied/i, `${role}: imagen`)
      await db.exec("reset role")
    }
    await db.exec("set role service_role")
    assert.equal((await db.query("select * from public.admin_product_view_stats('2000-01-01', '2100-12-31')")).rows.length, 1)
    assert.equal((await db.query<{ status: string }>(`select public.record_product_view('${SESSION_B}'::uuid, 1) as status`)).rows[0].status, "recorded")
    await db.exec("reset role")
  } finally { await db.close() }
})
