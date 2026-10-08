import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
let requestNumber = 0
const key = () => `50000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`

// Encendedor USB aleatorio: Negro (41), Rojo (42), Azul (43, sin stock).
async function setup() {
  const db = new PGlite()
  await db.exec(read("lib/orders/fixtures/dispatch-schema.sql"))
  await db.exec(read("supabase/migrations/20260820120000_cost_catalog_barcode.sql"))
  await db.exec(read("supabase/migrations/20261005100000_dispatch_operations.sql"))
  await db.exec(read("supabase/migrations/20261005110000_dispatch_guards.sql"))
  await db.exec(read("supabase/migrations/20261007100000_barcodes_parcels_dispatch.sql"))
  // Columnas/tablas reales que el fixture de despacho no necesitaba.
  await db.exec(`
    alter table productos add column activo boolean not null default true, add column stock integer not null default 0;
    alter table producto_variantes add column activo boolean not null default true, add column stock integer not null default 0;
    alter table catalog_sku_registry add column conditioned_stock_id uuid;
    create table stock_reservations (session_id text, product_id bigint, variant_id bigint,
      conditioned_stock_id uuid, quantity integer, expires_at timestamptz, order_id bigint);
    create table checkout_reservation_sessions (session_id text primary key, user_id uuid, order_id bigint,
      reservation_started_at timestamptz, expires_at timestamptz);
  `)
  await db.exec(read("supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
  await db.exec(`
    insert into productos(id,sku,codigo_barra,nombre,venta_aleatoria) values (4,'ENC','7170972998100','Encendedor USB',true),(5,'BOT',null,'Botella',false);
    insert into producto_variantes(id,producto_id,sku,codigo_barra,stock) values
      (41,4,'ENC-NEG','7790000000041',4),(42,4,'ENC-ROJ','7790000000042',3),(43,4,'ENC-AZU','7790000000043',0),
      (51,5,'BOT-AZU-ROS','7790000000051',5),(52,5,'BOT-VER','7790000000052',5);
    insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values
      ('ENC',4,null),('ENC-NEG',null,41),('ENC-ROJ',null,42),('ENC-AZU',null,43),('BOT',5,null),('BOT-AZU-ROS',null,51),('BOT-VER',null,52);
    insert into ordenes(id) values (1040),(1050);
    insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,random_fulfillment) values
      (1,1040,4,41,1,true),(2,1040,4,41,1,true),(3,1050,5,51,1,false);
  `)
  return db
}

const scan = (db: PGlite, orderId: number, code: string, requestKey = key()) =>
  db.query<{ r: { orderItemId: number; scanned: number; expected: number; status: string; duplicate: boolean } }>(
    "select scan_order_preparation_code($1,$2,$3,$4) r", [orderId, code, actor, requestKey])
const variants = async (db: PGlite, orderId: number) =>
  (await db.query<{ variante_id: number }>("select variante_id from orden_items where orden_id=$1 order by id", [orderId])).rows.map((row) => Number(row.variante_id))

test("aleatorio: 2 unidades, se escanea rojo y negro → 2/2 y queda 1 rojo + 1 negro", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    const first = (await scan(db, 1040, "7790000000042")).rows[0].r
    assert.equal(first.scanned, 1)
    const second = (await scan(db, 1040, "7790000000041")).rows[0].r
    assert.equal(second.status, "prepared")
    assert.deepEqual((await variants(db, 1040)).sort(), [41, 42])
    const events = (await db.query<{ metadata: { toVariantId: number } }>("select metadata from order_audit_events where order_id=1040 and action='random_variant_assigned'")).rows
    assert.deepEqual(events.map((event) => Number(event.metadata.toVariantId)), [42])
    // Los renglones de armado quedan coherentes con orden_items: sin bloqueo "ítems cambiados".
    const reasons = (await db.query<{ r: string[] }>("select dispatch_order_block_reasons(1040) r")).rows[0].r
    assert.ok(!reasons.includes("items_changed"), reasons.join(","))
  } finally { await db.close() }
})

test("aleatorio: una variante agotada no se puede asignar; el reintento no duplica", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    await assert.rejects(scan(db, 1040, "7790000000043"), /DISPATCH_RANDOM_VARIANT_NO_STOCK/)
    assert.deepEqual(await variants(db, 1040), [41, 41], "nada cambió")
    const retryKey = key()
    await scan(db, 1040, "7790000000042", retryKey)
    const retry = (await scan(db, 1040, "7790000000042", retryKey)).rows[0].r
    assert.equal(retry.duplicate, true)
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from order_preparation_scans")).rows[0].n, 1)
  } finally { await db.close() }
})

test("códigos equivalentes: alias de variante y código del grupo (mismo EAN para todos los colores)", async () => {
  const db = await setup()
  try {
    await db.exec(`insert into catalog_barcode_aliases(normalized_barcode,barcode,product_id,variant_id) values
      ('7791234567890','7791234567890',4,42),('BX-ENC-000123','BX-ENC-000123',4,null)`)
    const target = (await db.query<{ product_id: number; variant_id: number | null; matched_by: string }>("select * from catalog_code_target('7791234567890')")).rows[0]
    assert.deepEqual([Number(target.product_id), Number(target.variant_id), target.matched_by], [4, 42, "alias"])
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    await scan(db, 1040, "7791234567890")
    const group = (await scan(db, 1040, "BX-ENC-000123")).rows[0].r
    assert.equal(group.status, "prepared")
    assert.deepEqual((await variants(db, 1040)).sort(), [41, 42], "el código de grupo conserva la variante asignada")
  } finally { await db.close() }
})

test("pedido NO aleatorio: sigue exigiendo la variante exacta", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1050, actor])
    await assert.rejects(scan(db, 1050, "7790000000052"), /DISPATCH_WRONG_SKU_OR_VARIANT/)
    assert.equal((await scan(db, 1050, "7790000000051")).rows[0].r.status, "prepared")
    await assert.rejects(scan(db, 1050, "NO-EXISTE"), /DISPATCH_ALREADY_PREPARED/)
  } finally { await db.close() }
})

test("unicidad global: un código no puede ser principal de un artículo y alias de otro", async () => {
  const db = await setup()
  try {
    await assert.rejects(
      db.exec("insert into catalog_barcode_aliases(normalized_barcode,barcode,product_id,variant_id) values ('7790000000051','7790000000051',4,41)"),
      /CATALOG_BARCODE_DUPLICATE/,
    )
    await db.exec("insert into catalog_barcode_aliases(normalized_barcode,barcode,product_id,variant_id) values ('7799876543210','7799876543210',4,41)")
    await assert.rejects(db.exec("update producto_variantes set codigo_barra='7799876543210' where id=52"), /duplicate|DUPLICATE|ya está/i)
    await assert.rejects(
      db.exec("insert into catalog_barcode_aliases(normalized_barcode,barcode,product_id,variant_id) values ('X1','X1',5,41)"),
      /CATALOG_ALIAS_VARIANT_MISMATCH/,
    )
    await assert.rejects(
      db.exec("insert into catalog_barcode_aliases(normalized_barcode,barcode,product_id) values ('BX-PKG-1-01','BX-PKG-1-01',4)"),
      /check/i,
    )
    const access = (await db.query<{ rls: boolean; write: boolean }>(`select
      (select relrowsecurity from pg_class where oid='public.catalog_barcode_aliases'::regclass) rls,
      has_table_privilege('authenticated','public.catalog_barcode_aliases','INSERT') write`)).rows[0]
    assert.deepEqual(access, { rls: true, write: false })
  } finally { await db.close() }
})

test("dos colores: el segundo color se valida como hex; legacy de un color sigue igual", async () => {
  const db = await setup()
  try {
    await db.exec("update producto_variantes set color_hex_secundario='#EC4899' where id=51")
    await assert.rejects(db.exec("update producto_variantes set color_hex_secundario='rosa' where id=51"), /color_hex_secundario/)
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from producto_variantes where color_hex_secundario is null")).rows[0].n, 4)
  } finally { await db.close() }
})

test("factura: un renglón aleatorio se describe como 'Color aleatorio'", () => {
  const migration = read("supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql")
  assert.match(migration, /case when i\.random_fulfillment then 'Color aleatorio'/)
})

test("venta aleatoria: se activa/desactiva bajo lock y exige al menos dos variantes", async () => {
  const db = await setup()
  try {
    await db.exec("insert into productos(id,sku,nombre) values (6,'UNI','Producto de una variante'); insert into producto_variantes(id,producto_id,sku,stock) values (61,6,'UNI-1',2)")
    await assert.rejects(db.query("select set_product_random_fulfillment(6,true,$1)", [actor]), /RANDOM_FULFILLMENT_NEEDS_VARIANTS/)
    const enabled = (await db.query<{ v: boolean }>("select (set_product_random_fulfillment(5,true,$1)).venta_aleatoria v", [actor])).rows[0]
    assert.equal(enabled.v, true)
    const disabled = (await db.query<{ v: boolean }>("select (set_product_random_fulfillment(4,false,$1)).venta_aleatoria v", [actor])).rows[0]
    assert.equal(disabled.v, false)
    // Desactivar nunca exige variantes; un producto inexistente se informa.
    await assert.rejects(db.query("select set_product_random_fulfillment(999,false,$1)", [actor]), /ya no existe/)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(db.query("select set_product_random_fulfillment(5,false,$1)", [actor]), /permisos/)
  } finally { await db.close() }
})

test("segundo color: el RPC de metadata lo guarda, lo quita con null y no lo toca si no viene", () => {
  const migration = read("supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql")
  const rpc = migration.slice(migration.indexOf("function public.update_product_variant_metadata_atomic"))
  assert.match(rpc, /color_hex_secundario = case when p_metadata \? 'color_hex_secundario'/)
  assert.match(rpc, /else variants\.color_hex_secundario end/)
  assert.match(rpc, /pg_advisory_xact_lock\(93000, p_product_id::integer\)/)
})
