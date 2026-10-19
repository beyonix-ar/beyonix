import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const migration = (name: string) => readFileSync(join(process.cwd(), "supabase/migrations", name), "utf8")
const legacyGenerator = migration("20261007100000_barcodes_parcels_dispatch.sql")
const prefixStart = legacyGenerator.indexOf("create or replace function public.beyonix_barcode_prefix(")
const prefixEnd = legacyGenerator.indexOf("$$;", prefixStart)
assert.ok(prefixStart >= 0 && prefixEnd > prefixStart)
const prefixFunction = legacyGenerator.slice(prefixStart, prefixEnd + 3)

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.role() returns text language sql stable as $$
      select current_setting('request.jwt.claim.role', true)
    $$;
    create table public.productos (
      id bigint primary key, nombre text not null, sku text, codigo_barra text
    );
    create table public.producto_variantes (
      id bigint primary key, producto_id bigint not null references public.productos(id),
      nombre text not null, sku text, codigo_barra text
    );
    create table public.catalog_barcode_aliases (
      normalized_barcode text primary key, barcode text not null,
      product_id bigint not null, variant_id bigint
    );
  `)
  await db.exec(migration("20260820120000_cost_catalog_barcode.sql"))
  await db.exec("create sequence public.beyonix_variant_barcode_seq as bigint start 1")
  await db.exec(prefixFunction)
  return db
}

test("backfill preserva códigos reales, completa faltantes y registra identidad escaneable", async () => {
  const db = await setup()
  try {
    await db.exec(`
      insert into productos(id,nombre,sku) values
        (1,'Auricular Bluetooth',null),
        (2,'Cable USB',null),
        (3,'Soporte Notebook','SOP01');
      insert into producto_variantes(id,producto_id,nombre,sku,codigo_barra) values
        (11,1,'Negro','AUR01','714604245896'),
        (12,1,'Blanco','AUR02',null),
        (21,2,'Verde','CZ01',null);
    `)
    await db.exec(migration("20261019100000_catalog_barcodes_required.sql"))
    await db.exec(migration("20261019101000_validate_catalog_barcodes_required.sql"))
    const { rows } = await db.query<{ id: number; codigo_barra: string }>(
      "select id,codigo_barra from producto_variantes order by id"
    )
    assert.equal(rows[0].codigo_barra, "714604245896")
    assert.match(rows[1].codigo_barra, /^BX-AUR-\d{6,}$/)
    assert.match(rows[2].codigo_barra, /^BX-CAB-\d{6,}$/)
    assert.notEqual(rows[1].codigo_barra, rows[2].codigo_barra)
    const product = await db.query<{ codigo_barra: string }>("select codigo_barra from productos where id = 3")
    assert.match(product.rows[0].codigo_barra, /^BX-SOP-\d{6,}$/)
    const registry = await db.query<{ normalized_barcode: string }>("select normalized_barcode from catalog_barcode_registry")
    assert.ok(registry.rows.some((row) => row.normalized_barcode === rows[1].codigo_barra))
    assert.ok(registry.rows.every((row) => !["AUR01", "AUR02", "CZ01", "SOP01"].includes(row.normalized_barcode)))
  } finally {
    await db.close()
  }
})

test("alta automática es única; RPC repetida conserva código; edición vacía genera otro", async () => {
  const db = await setup()
  try {
    await db.exec(migration("20261019100000_catalog_barcodes_required.sql"))
    await db.exec(migration("20261019101000_validate_catalog_barcodes_required.sql"))
    await db.exec("insert into productos(id,nombre,sku) values (4,'Auricular Bluetooth',null)")
    await db.exec(`
      insert into producto_variantes(id,producto_id,nombre,sku) values
        (41,4,'Negro','AUCN01'),(42,4,'Blanco','AUCB01');
    `)
    const before = await db.query<{ id: number; codigo_barra: string }>("select id,codigo_barra from producto_variantes order by id")
    assert.equal(before.rows.length, 2)
    assert.notEqual(before.rows[0].codigo_barra, before.rows[1].codigo_barra)
    const parent = await db.query<{ codigo_barra: string | null }>("select codigo_barra from productos where id=4")
    assert.equal(parent.rows[0].codigo_barra, null)
    await db.query("select set_config('request.jwt.claim.role','service_role',false)")
    const repeated = await db.query<{ codigo_barra: string }>(
      "select codigo_barra from generate_beyonix_variant_barcode(4,41,null)"
    )
    assert.equal(repeated.rows[0].codigo_barra, before.rows[0].codigo_barra)
    await db.exec("update producto_variantes set codigo_barra = null where id = 41")
    const changed = await db.query<{ codigo_barra: string }>("select codigo_barra from producto_variantes where id=41")
    assert.match(changed.rows[0].codigo_barra, /^BX-AUR-\d{6,}$/)
    assert.notEqual(changed.rows[0].codigo_barra, before.rows[0].codigo_barra)
    await db.exec("update producto_variantes set codigo_barra = '714604245896' where id = 42")
    const real = await db.query<{ codigo_barra: string }>("select codigo_barra from producto_variantes where id=42")
    assert.equal(real.rows[0].codigo_barra, "714604245896")
  } finally {
    await db.close()
  }
})
