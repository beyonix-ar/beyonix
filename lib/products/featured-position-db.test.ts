import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Migración 20261102120000 (orden manual de destacados) contra PostgreSQL real
// (PGlite). El trigger de revisión de la ficha es el real de 20261015130000.

const readMigration = (file: string) => readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8")
const migration = readMigration("20261102120000_product_featured_position.sql")

function sqlBlock(file: string, start: string, end: string) {
  const source = readMigration(file)
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `${start} en ${file}`)
  return source.slice(from, to + end.length)
}
const revisionTrigger = sqlBlock(
  "20261015130000_variant_parent_integrity.sql",
  "create or replace function public.bump_product_catalog_revision()",
  "for each row execute function public.bump_product_catalog_revision();",
)

// Mismo ORDER BY que `orderFeaturedProducts` (lib/products/featured-products.ts).
const HOME_ORDER = "order by featured_position asc nulls last, created_at desc, id desc"

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create role service_role;
    create function auth.role() returns text language sql stable as $$
      select current_setting('request.jwt.claim.role', true)
    $$;
    create table public.productos (
      id bigint generated always as identity primary key,
      nombre text not null,
      sku text, slug text not null default 'p', descripcion text, video_url text,
      precio numeric not null default 0, precio_anterior numeric, descuento numeric,
      categoria_id bigint,
      destacado boolean not null default false,
      activo boolean not null default true,
      peso_empaquetado_kg numeric, alto_paquete_cm numeric, ancho_paquete_cm numeric, largo_paquete_cm numeric,
      promo_event_id uuid, promo_original_precio numeric, promo_original_precio_anterior numeric, promo_original_descuento numeric,
      catalog_revision bigint not null default 0,
      created_at timestamptz not null default now()
    );
    ${revisionTrigger}
  `)
  // Destacados existentes ANTES de la migración (como los 5 de producción).
  await db.exec(`
    insert into public.productos (nombre, destacado, activo, created_at) values
      ('ENCENDEDOR ELÉCTRICO', true, true, '2026-10-08'),
      ('SOPORTE DE ALUMINIO', true, true, '2026-10-09'),
      ('TRÍPODE ÑANDÚ 360º', true, true, '2026-10-10'),
      ('SACACORCHOS', true, true, '2026-10-26'),
      ('BALANZA DE BAÑO', true, true, '2026-10-27'),
      ('LÁMPARA SIN DESTACAR', false, true, '2026-10-28'),
      ('PARLANTE INACTIVO', true, false, '2026-10-29');
  `)
  await db.exec(migration)
  return db
}

const asService = (db: PGlite) => db.exec("select set_config('request.jwt.claim.role', 'service_role', false)")

async function setFeatured(db: PGlite, id: number, destacado: boolean, position: number | null, revision: number | null = null) {
  const { rows } = await db.query<{ result: { destacado: boolean; featured_position: number | null; catalog_revision: number } }>(
    "select public.set_product_featured_position($1, $2, $3, $4) as result",
    [id, destacado, position, revision],
  )
  return rows[0].result
}

async function rejects(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (error: { code?: string; message?: string }) => {
    assert.equal(error.code, code, error.message)
    if (message) assert.match(error.message ?? "", message)
    return true
  })
}

const homeIds = async (db: PGlite) =>
  (await db.query<{ id: number }>(`select id from public.productos where activo and destacado ${HOME_ORDER}`)).rows.map((row) => Number(row.id))

test("la migración deja a los destacados existentes sin posición y Home conserva el orden por fecha", async () => {
  const db = await setup()
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.productos where featured_position is not null")
  assert.equal(rows[0].n, 0, "no asigna posiciones arbitrarias")
  assert.deepEqual(await homeIds(db), [5, 4, 3, 2, 1], "sin posiciones: más nuevo primero, el inactivo no aparece")
})

test("posiciones 1/2/3: Home las respeta y los destacados sin posición van después", async () => {
  const db = await setup()
  await asService(db)
  await setFeatured(db, 2, true, 1)
  await setFeatured(db, 1, true, 2)
  await setFeatured(db, 3, true, 3)
  assert.deepEqual(await homeIds(db), [2, 1, 3, 5, 4])

  // Destacar uno nuevo sin posición: entra al final de los ordenados.
  await setFeatured(db, 6, true, null)
  assert.deepEqual(await homeIds(db), [2, 1, 3, 6, 5, 4])
})

test("posición ocupada: se rechaza con el nombre del producto (Unicode) y nada se reordena", async () => {
  const db = await setup()
  await asService(db)
  await setFeatured(db, 3, true, 1)
  await rejects(setFeatured(db, 2, true, 1), "23505", /La posición 1 ya está ocupada por "TRÍPODE ÑANDÚ 360º"/)
  const { rows } = await db.query<{ id: number; featured_position: number | null }>(
    "select id, featured_position from public.productos where id in (2, 3) order by id",
  )
  assert.deepEqual(rows.map((row) => [Number(row.id), row.featured_position]), [[2, null], [3, 1]], "sin intercambio automático")

  // Reasignar la propia posición no choca consigo mismo.
  assert.equal((await setFeatured(db, 3, true, 1)).featured_position, 1)
})

test("un inactivo con posición la sigue ocupando y el mensaje lo aclara", async () => {
  const db = await setup()
  await asService(db)
  await setFeatured(db, 7, true, 4)
  await rejects(setFeatured(db, 1, true, 4), "23505", /"PARLANTE INACTIVO" \(inactivo\)/)
  assert.ok(!(await homeIds(db)).includes(7), "inactivo no aparece en Home")
})

test("unicidad en la base: dos escrituras con la misma posición (carrera que salteó el chequeo) → una falla", async () => {
  const db = await setup()
  await db.exec("update public.productos set featured_position = 1 where id = 1")
  // Simula el Admin que llegó segundo: escribe directo, sin pasar por la función.
  await rejects(db.exec("update public.productos set featured_position = 1 where id = 2"), "23505")
  // No destacados no ocupan posiciones (índice parcial).
  await db.exec("update public.productos set destacado = false where id = 1")
  await db.exec("update public.productos set featured_position = 1 where id = 2")
})

test("quitar destacado limpia la posición en la misma escritura, venga de la función o de otro camino", async () => {
  const db = await setup()
  await asService(db)
  await setFeatured(db, 1, true, 1)
  await setFeatured(db, 2, true, 2)

  const removed = await setFeatured(db, 1, false, null)
  assert.deepEqual([removed.destacado, removed.featured_position], [false, null])

  // Guardado de la ficha / archivado: `destacado = false` por UPDATE directo.
  await db.exec("update public.productos set destacado = false, activo = false where id = 2")
  const { rows } = await db.query<{ featured_position: number | null }>("select featured_position from public.productos where id = 2")
  assert.equal(rows[0].featured_position, null)

  // La posición 1 queda libre para otro producto.
  assert.equal((await setFeatured(db, 3, true, 1)).featured_position, 1)
})

test("restricciones: posición > 0 y nunca sin destacado", async () => {
  const db = await setup()
  await rejects(db.exec("update public.productos set featured_position = 0 where id = 1"), "23514")
  await db.exec("update public.productos set featured_position = 5 where id = 6")
  const { rows } = await db.query<{ featured_position: number | null }>("select featured_position from public.productos where id = 6")
  assert.equal(rows[0].featured_position, null, "un no destacado nunca guarda posición")
})

test("validación y permisos de set_product_featured_position", async () => {
  const db = await setup()
  await rejects(setFeatured(db, 1, true, 1), "42501")
  await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false)")
  await rejects(setFeatured(db, 1, true, 1), "42501")
  await asService(db)
  await rejects(setFeatured(db, 1, false, 3), "22023")
  await rejects(setFeatured(db, 1, true, 0), "22023")
  await rejects(setFeatured(db, 999, true, 1), "P0002")
  const { rows } = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(`
    select
      has_function_privilege('anon', 'public.set_product_featured_position(bigint, boolean, integer, bigint)', 'execute') as anon,
      has_function_privilege('authenticated', 'public.set_product_featured_position(bigint, boolean, integer, bigint)', 'execute') as authenticated,
      has_function_privilege('service_role', 'public.set_product_featured_position(bigint, boolean, integer, bigint)', 'execute') as service
  `)
  assert.deepEqual(rows[0], { anon: false, authenticated: false, service: true })
})

test("revisión del editor: rechaza si la ficha cambió y devuelve la revisión nueva si no", async () => {
  const db = await setup()
  await asService(db)
  const { rows } = await db.query<{ catalog_revision: number }>("select catalog_revision from public.productos where id = 6")
  const revision = Number(rows[0].catalog_revision)

  await rejects(setFeatured(db, 6, true, 1, revision + 5), "40001")
  const result = await setFeatured(db, 6, true, 1, revision)
  assert.equal(Number(result.catalog_revision), revision + 1, "destacar cambia la ficha (sube la revisión)")
  // Cambiar sólo la posición no invalida al editor abierto.
  assert.equal(Number((await setFeatured(db, 6, true, 2, revision + 1)).catalog_revision), revision + 1)
})
