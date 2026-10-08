import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { findCatalogArticleByCode, type CatalogCodeOwner, type CatalogCodeStore } from "./catalog-lookup.ts"

type OwnerRow = { product_id: number | null; variant_id: number | null }

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.productos (id bigint primary key, nombre text not null, activo boolean not null default true, stock integer, sku text, codigo_barra text);
    create table public.producto_variantes (id bigint primary key, producto_id bigint not null references public.productos(id), nombre text not null, activo boolean not null default true, stock integer, sku text, color_hex text, codigo_barra text);
    create table public.catalog_sku_registry (normalized_sku text primary key, product_id bigint unique, variant_id bigint unique);
    create table public.product_cost_entries (product_id bigint, variant_id bigint, sku text, purchase_date date, created_at timestamptz default now());
  `)
  await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20260820120000_cost_catalog_barcode.sql"), "utf8"))
  return db
}

// Las mismas consultas por clave única que el store de Supabase.
function pgStore(db: PGlite, queries: string[]): CatalogCodeStore {
  const one = async <T>(sql: string, params: unknown[]) => {
    queries.push(sql)
    return (await db.query<T>(sql, params)).rows[0] ?? null
  }
  const owner = (row: OwnerRow | null): CatalogCodeOwner | null =>
    row && { productId: row.product_id == null ? null : Number(row.product_id), variantId: row.variant_id == null ? null : Number(row.variant_id) }
  return {
    async barcodeOwner(code) { return owner(await one<OwnerRow>("select product_id, variant_id from catalog_barcode_registry where normalized_barcode = $1", [code])) },
    async aliasOwner() { return null },
    async skuOwner(sku) { return owner(await one<OwnerRow>("select product_id, variant_id from catalog_sku_registry where normalized_sku = $1", [sku])) },
    async variant(id) {
      const row = await one<{ id: number; producto_id: number; nombre: string; activo: boolean; stock: number | null; sku: string | null; color_hex: string | null; codigo_barra: string | null }>(
        "select id, producto_id, nombre, activo, stock, sku, color_hex, codigo_barra from producto_variantes where id = $1", [id])
      return row && { ...row, id: Number(row.id), producto_id: Number(row.producto_id) }
    },
    async product(id) {
      const row = await one<{ id: number; nombre: string; activo: boolean; stock: number | null; sku: string | null; codigo_barra: string | null; variant_count: number }>(
        "select p.id, p.nombre, p.activo, p.stock, p.sku, p.codigo_barra, (select count(*)::int from producto_variantes v where v.producto_id = p.id) as variant_count from productos p where p.id = $1", [id])
      if (!row) return null
      const { variant_count: variantCount, ...fields } = row
      return { ...fields, id: Number(fields.id), variantCount }
    },
    async latestProductCostSku() { return null },
  }
}

test("registro de códigos: un código no puede quedar en dos artículos", async () => {
  const db = await setup()
  await db.exec("insert into productos(id,nombre) values (1,'Auriculares'),(2,'Cable')")
  await db.exec("insert into producto_variantes(id,producto_id,nombre,codigo_barra) values (11,1,'Negro','7790001000017')")
  await assert.rejects(
    db.exec("insert into producto_variantes(id,producto_id,nombre,codigo_barra) values (21,2,'Rojo',' 7790001000017 ')"),
    /ya está asignado a otro artículo/,
  )
  await assert.rejects(db.exec("update productos set codigo_barra = '7790001000017' where id = 2"), /ya está asignado/)
  const { rows } = await db.query<{ count: number }>("select count(*)::int as count from catalog_barcode_registry where normalized_barcode = '7790001000017'")
  assert.equal(rows[0].count, 1)
  await db.close()
})

test("lookup por registro con 1500 productos: variante exacta, fabricante y BEYONIX, sin traer el catálogo", async () => {
  const db = await setup()
  await db.exec(`
    insert into productos(id,nombre,sku) select g, 'Producto ' || g, 'P-' || g from generate_series(1,1500) g;
    insert into producto_variantes(id,producto_id,nombre,sku,color_hex,codigo_barra)
      select 100000 + g, g, 'Color ' || g, 'P-' || g || '-V', '#123456', '779' || lpad(g::text, 10, '0') from generate_series(1,1500) g;
    update producto_variantes set codigo_barra = 'BX-PRO-001400' where id = 101400;
    insert into productos(id,nombre,codigo_barra) values (2000,'Legacy Ñandú','LEG-BAR');
    insert into catalog_sku_registry(normalized_sku,variant_id) select upper(sku), id from producto_variantes;
  `)
  const queries: string[] = []
  const store = pgStore(db, queries)

  const manufacturer = await findCatalogArticleByCode(store, "7790000001499")
  assert.equal(manufacturer?.value, "v:1499:101499")
  assert.equal(manufacturer?.variant?.sku, "P-1499-V")
  assert.equal(manufacturer?.variant?.color_hex, "#123456")
  assert.equal(queries.length, 3)
  assert.ok(queries.every((sql) => /where (normalized_barcode|id|p\.id) = \$1/.test(sql)))

  assert.equal((await findCatalogArticleByCode(store, "BX-PRO-001400"))?.value, "v:1400:101400")
  assert.equal((await findCatalogArticleByCode(store, "p-1450-v"))?.matchedBy, "sku")
  assert.equal((await findCatalogArticleByCode(store, "LEG-BAR"))?.value, "p:2000")
  assert.equal(await findCatalogArticleByCode(store, "7790000009999"), null)
  await db.close()
})
