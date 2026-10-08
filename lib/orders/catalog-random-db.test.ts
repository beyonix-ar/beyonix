import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
let requestNumber = 0
const key = () => `50000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`

// Encendedor USB aleatorio: Negro (41), Rojo (42), Azul (43). Stock físico
// base: Negro 4, Rojo 3, Azul 1. El stock vendible se deriva de
// orden_items.variante_id (como inventory_movements + refresh_inventory_stock,
// fail closed): cambiar la variante de un renglón devuelve la unidad a la
// anterior y la consume de la nueva en el mismo UPDATE.
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
    alter table producto_variantes add column activo boolean not null default true, add column stock integer not null default 0,
      add column nombre text, add column color_hex text, add column orden integer;
    alter table catalog_sku_registry add column conditioned_stock_id uuid;
    create table stock_reservations (session_id text, product_id bigint, variant_id bigint,
      conditioned_stock_id uuid, quantity integer, expires_at timestamptz, order_id bigint);
    create table checkout_reservation_sessions (session_id text primary key, user_id uuid, order_id bigint,
      reservation_started_at timestamptz, expires_at timestamptz);
  `)
  await db.exec(read("supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql"))
  await db.exec(read("supabase/migrations/20261009100000_random_fulfillment_traceability.sql"))
  await db.exec(`
    create table test_inventory_base (variant_id bigint primary key, quantity integer not null);
    create function test_refresh_stock() returns trigger language plpgsql as $$
    begin
      update producto_variantes v set stock = b.quantity - coalesce((
        select sum(i.cantidad) from orden_items i join ordenes o on o.id = i.orden_id
        where i.variante_id = v.id and o.estado <> 'cancelado'), 0)
      from test_inventory_base b where b.variant_id = v.id;
      if exists (select 1 from producto_variantes where stock < 0) then
        raise exception 'INVENTORY_CORRUPTION_NEGATIVE_STOCK';
      end if;
      return null;
    end $$;
    create trigger test_refresh_items after insert or update or delete on orden_items
      for each statement execute function test_refresh_stock();
    create trigger test_refresh_orders after update of estado on ordenes
      for each statement execute function test_refresh_stock();
  `)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
  await db.exec(`
    insert into productos(id,sku,codigo_barra,nombre,venta_aleatoria) values (4,'ENC','7170972998100','Encendedor USB',true),(5,'BOT',null,'Botella',false);
    insert into producto_variantes(id,producto_id,sku,codigo_barra,nombre,orden) values
      (41,4,'ENC-NEG','7790000000041','Negro',1),(42,4,'ENC-ROJ','7790000000042','Rojo',2),(43,4,'ENC-AZU','7790000000043','Azul',3),
      (51,5,'BOT-AZU-ROS','7790000000051','Azul / Rosa',1),(52,5,'BOT-VER','7790000000052','Verde',2);
    insert into test_inventory_base values (41,4),(42,3),(43,1),(51,5),(52,5);
    insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values
      ('ENC',4,null),('ENC-NEG',null,41),('ENC-ROJ',null,42),('ENC-AZU',null,43),('BOT',5,null),('BOT-AZU-ROS',null,51),('BOT-VER',null,52);
    insert into ordenes(id) values (1040),(1050),(1060);
    insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,random_fulfillment) values
      (1,1040,4,41,1,true),(2,1040,4,41,1,true),(3,1050,5,51,1,false);
  `)
  return db
}

type ScanResponse = {
  orderItemId: number; scanned: number; expected: number; status: string; duplicate: boolean
  requiresVariant: boolean; candidates?: Array<{ variantId: number; name: string; assigned: boolean; selectable: boolean }>
}
const scan = (db: PGlite, orderId: number, code: string, requestKey = key(), variantId: number | null = null) =>
  db.query<{ r: ScanResponse }>(
    "select scan_order_preparation_code($1,$2,$3,$4,$5) r", [orderId, code, actor, requestKey, variantId])
const count = async (db: PGlite, sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n
const variants = async (db: PGlite, orderId: number) =>
  (await db.query<{ variante_id: number }>("select variante_id from orden_items where orden_id=$1 order by id", [orderId])).rows.map((row) => Number(row.variante_id))
const reserved = async (db: PGlite, orderId: number) =>
  (await db.query<{ v: number }>("select reserved_variant_id v from orden_items where orden_id=$1 order by id", [orderId])).rows.map((row) => Number(row.v))
const stock = async (db: PGlite) => Object.fromEntries((await db.query<{ id: number; stock: number }>(
  "select id, stock from producto_variantes where producto_id=4 order by id")).rows.map((row) => [Number(row.id), Number(row.stock)]))
const physicalScans = async (db: PGlite, orderId: number) => (await db.query<{ attempt: number; item: number; variant: number; how: string; from: number | null }>(
  `select s.attempt_number attempt, s.order_item_id item, s.physical_variant_id variant, s.variant_identification how,
     s.reassigned_from_variant_id "from"
   from order_preparation_scans s join order_packages p on p.id = s.package_id
   where p.order_id = $1 order by s.id`, [orderId])).rows.map((row) => ({
  attempt: Number(row.attempt), item: Number(row.item), variant: Number(row.variant), how: row.how,
  from: row.from === null ? null : Number(row.from),
}))

test("aleatorio: la reserva queda fijada por la base y es inmutable", async () => {
  const db = await setup()
  try {
    assert.deepEqual(await reserved(db, 1040), [41, 41])
    assert.deepEqual(await stock(db), { 41: 2, 42: 3, 43: 1 }, "las dos unidades reservadas consumen Negro")
    await assert.rejects(db.exec("update orden_items set reserved_variant_id=42 where id=1"), /ORDER_ITEM_RESERVED_VARIANT_IMMUTABLE/)
    // Un renglón normal nunca guarda reserva aleatoria, aunque el cliente la mande.
    await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,reserved_variant_id) values (9,1060,5,52,1,51)")
    assert.equal((await db.query<{ v: number | null }>("select reserved_variant_id v from orden_items where id=9")).rows[0].v, null)
  } finally { await db.close() }
})

test("aleatorio: misma variante reservada y despachada → sin reasignación ni movimiento de stock", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    await scan(db, 1040, "7790000000041")
    const done = (await scan(db, 1040, "ENC-NEG")).rows[0].r
    assert.equal(done.status, "prepared")
    assert.deepEqual(await variants(db, 1040), [41, 41])
    assert.deepEqual(await stock(db), { 41: 2, 42: 3, 43: 1 })
    assert.deepEqual((await physicalScans(db, 1040)).map((row) => [row.variant, row.how, row.from]), [[41, "variant_code", null], [41, "variant_code", null]])
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='random_variant_assigned'"), 0)
  } finally { await db.close() }
})

test("aleatorio: reservado Negro, sale Azul + Rojo → despachado Azul + Rojo y el stock se mueve atómicamente", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    const first = (await scan(db, 1040, "7790000000043")).rows[0].r
    assert.equal(first.scanned, 1)
    const second = (await scan(db, 1040, "7790000000042")).rows[0].r
    assert.equal(second.status, "prepared")
    assert.deepEqual(await variants(db, 1040), [43, 42], "variante física final")
    assert.deepEqual(await reserved(db, 1040), [41, 41], "la reserva original se conserva")
    // Negro recupera sus 2 unidades; Azul y Rojo consumen 1 cada una. Total igual.
    assert.deepEqual(await stock(db), { 41: 4, 42: 2, 43: 0 })
    assert.deepEqual((await physicalScans(db, 1040)).map((row) => [row.item, row.variant, row.from]), [[1, 43, 41], [2, 42, 41]])
    const events = (await db.query<{ action: string; metadata: Record<string, unknown> }>(
      "select action, metadata from order_audit_events where order_id=1040 and action like 'random_variant_%' order by id")).rows
    assert.deepEqual(events.map((event) => event.action), ["random_variant_assigned", "random_variant_dispatched", "random_variant_assigned", "random_variant_dispatched"])
    assert.deepEqual(
      [events[1].metadata.reservedVariantId, events[1].metadata.dispatchedVariantId, events[1].metadata.reassigned, events[1].metadata.code],
      [41, 43, true, "7790000000043"])
    const reasons = (await db.query<{ r: string[] }>("select dispatch_order_block_reasons(1040) r")).rows[0].r
    assert.ok(!reasons.includes("items_changed"), reasons.join(","))
  } finally { await db.close() }
})

test("aleatorio: una variante sin stock libre no se asigna; el reintento no duplica", async () => {
  const db = await setup()
  try {
    // La única Azul está reservada por otro checkout vigente.
    await db.exec("insert into stock_reservations values ('otra-sesion-123',4,43,null,1,now() + interval '10 minutes',null)")
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    await assert.rejects(scan(db, 1040, "7790000000043"), /DISPATCH_RANDOM_VARIANT_NO_STOCK/)
    assert.deepEqual(await variants(db, 1040), [41, 41], "nada cambió")
    assert.equal(await count(db, "select count(*)::int n from order_preparation_scans"), 0)
    const retryKey = key()
    await scan(db, 1040, "7790000000042", retryKey)
    const retry = (await scan(db, 1040, "7790000000042", retryKey)).rows[0].r
    assert.equal(retry.duplicate, true)
    assert.equal(await count(db, "select count(*)::int n from order_preparation_scans"), 1)
    assert.deepEqual(await stock(db), { 41: 3, 42: 2, 43: 1 })
  } finally { await db.close() }
})

test("aleatorio: no puede tomar la variante ya vendida a otro pedido", async () => {
  const db = await setup()
  try {
    // Pedido B (1060) reservó y pagó la única Azul.
    await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,random_fulfillment) values (6,1060,4,43,1,true)")
    assert.deepEqual(await stock(db), { 41: 2, 42: 3, 43: 0 })
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    await assert.rejects(scan(db, 1040, "7790000000043"), /DISPATCH_RANDOM_VARIANT_NO_STOCK/)
    await assert.rejects(scan(db, 1040, "ENC", key(), 43), /DISPATCH_RANDOM_VARIANT_NO_STOCK/)
    assert.deepEqual(await variants(db, 1060), [43], "el pedido B conserva su Azul")
    assert.deepEqual(await variants(db, 1040), [41, 41])
  } finally { await db.close() }
})

test("código de grupo: exige confirmar la variante física; nunca registra la reservada en silencio", async () => {
  const db = await setup()
  try {
    await db.exec(`insert into catalog_barcode_aliases(normalized_barcode,barcode,product_id,variant_id) values
      ('7791234567890','7791234567890',4,42),('BX-ENC-000123','BX-ENC-000123',4,null)`)
    const target = (await db.query<{ product_id: number; variant_id: number | null; matched_by: string }>("select * from catalog_code_target('7791234567890')")).rows[0]
    assert.deepEqual([Number(target.product_id), Number(target.variant_id), target.matched_by], [4, 42, "alias"])
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    // Alias de variante: identifica Rojo.
    await scan(db, 1040, "7791234567890")
    // Código de grupo (alias sin variante, EAN del producto o SKU del grupo): pide variante.
    for (const groupCode of ["BX-ENC-000123", "7170972998100", "ENC"]) {
      assert.equal((await scan(db, 1040, groupCode)).rows[0].r.requiresVariant, true, groupCode)
    }
    const pending = (await scan(db, 1040, "BX-ENC-000123")).rows[0].r
    assert.deepEqual(pending.candidates?.map((candidate) => [candidate.name, candidate.assigned, candidate.selectable]),
      [["Negro", true, true], ["Rojo", false, true], ["Azul", false, true]])
    assert.equal(await count(db, "select count(*)::int n from order_preparation_scans"), 1, "sin confirmación no se registra")
    // Confirmación explícita de la variante en mano.
    const confirmKey = key()
    const done = (await scan(db, 1040, "BX-ENC-000123", confirmKey, 43)).rows[0].r
    assert.equal(done.status, "prepared")
    assert.deepEqual(await variants(db, 1040), [42, 43])
    assert.deepEqual((await physicalScans(db, 1040)).map((row) => [row.variant, row.how]), [[42, "variant_code"], [43, "group_confirmed"]])
    // Reintento con la misma clave: idempotente; con otra variante: conflicto.
    assert.equal((await scan(db, 1040, "BX-ENC-000123", confirmKey, 43)).rows[0].r.duplicate, true)
    await assert.rejects(scan(db, 1040, "BX-ENC-000123", confirmKey, 41), /DISPATCH_SCAN_KEY_CONFLICT/)
  } finally { await db.close() }
})

test("código de grupo confirmado: valida producto, variante activa, coherencia y cantidad", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    await assert.rejects(scan(db, 1040, "7790000000042", key(), 43), /DISPATCH_VARIANT_CONFIRMATION_MISMATCH/)
    await assert.rejects(scan(db, 1040, "ENC", key(), 51), /DISPATCH_WRONG_SKU_OR_VARIANT/, "variante de otro producto")
    await db.exec("update producto_variantes set activo=false where id=42")
    await assert.rejects(scan(db, 1040, "ENC", key(), 42), /DISPATCH_WRONG_SKU_OR_VARIANT/, "variante deshabilitada")
    await assert.rejects(scan(db, 1040, "ENC", key(), 0), /DISPATCH_SCAN_INVALID/)
    assert.equal(await count(db, "select count(*)::int n from order_preparation_scans"), 0)
    await scan(db, 1040, "ENC", key(), 41)
    await scan(db, 1040, "ENC", key(), 41)
    await assert.rejects(scan(db, 1040, "ENC", key(), 41), /DISPATCH_ALREADY_PREPARED/)
  } finally { await db.close() }
})

test("cancelación antes del despacho: devuelve la variante que el pedido consume (la física si ya se armó)", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    await scan(db, 1040, "7790000000043")
    assert.deepEqual(await stock(db), { 41: 3, 42: 3, 43: 0 })
    await db.exec("update ordenes set estado='cancelado' where id=1040")
    assert.deepEqual(await stock(db), { 41: 4, 42: 3, 43: 1 }, "Azul vuelve a Azul y Negro queda completo")
  } finally { await db.close() }
})

test("devolución: el reingreso usa la variante física despachada, no la reservada", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    await scan(db, 1040, "7790000000043")
    await scan(db, 1040, "7790000000041")
    assert.deepEqual(await variants(db, 1040), [43, 41])
    assert.deepEqual(await reserved(db, 1040), [41, 41])
    // La recepción de devoluciones toma orden_items.variante_id del renglón.
    const reception = read("supabase/migrations/20260920110000_unify_return_reception_rpc.sql")
    assert.match(reception, /coalesce\(p_variant_id_override, v_item\.variante_id\)/)
  } finally { await db.close() }
})

test("rearmado: cada intento conserva su propia variante física (R1 Rojo → R2 Azul)", async () => {
  const db = await setup()
  try {
    await db.exec("delete from orden_items where id=2")
    await db.query("select begin_order_preparation($1,$2)", [1040, actor])
    assert.equal((await scan(db, 1040, "7790000000042")).rows[0].r.status, "prepared")
    await db.query("select reset_order_preparation($1,$2,$3,$4)", [1040, actor, key(), "Se armó con el color equivocado"])
    assert.equal((await scan(db, 1040, "7790000000043")).rows[0].r.status, "prepared")
    assert.deepEqual((await physicalScans(db, 1040)).map((row) => [row.attempt, row.variant, row.from]), [[1, 42, 41], [2, 43, 42]])
    assert.deepEqual(await variants(db, 1040), [43])
    assert.deepEqual(await reserved(db, 1040), [41])
    assert.deepEqual(await stock(db), { 41: 4, 42: 3, 43: 0 })
  } finally { await db.close() }
})

test("concurrencia: la reasignación corre bajo el mismo lock por producto que reservas y stock", () => {
  const migration = read("supabase/migrations/20261009100000_random_fulfillment_traceability.sql")
  const assign = migration.slice(migration.indexOf("function public.assign_random_order_line_variant"))
  assert.match(assign, /pg_advisory_xact_lock\(93000, v_item\.producto_id::integer\)[\s\S]*available_stock_for_session/)
  assert.match(migration, /revoke all on function[\s\S]*scan_order_preparation_code\(bigint,text,uuid,uuid,bigint\)[\s\S]*from public, anon, authenticated/)
})

test("pedido NO aleatorio: sigue exigiendo la variante exacta", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1050, actor])
    await assert.rejects(scan(db, 1050, "7790000000052"), /DISPATCH_WRONG_SKU_OR_VARIANT/)
    // El código del grupo no alcanza y una confirmación manual tampoco.
    await assert.rejects(scan(db, 1050, "BOT"), /DISPATCH_WRONG_SKU_OR_VARIANT/)
    await assert.rejects(scan(db, 1050, "BOT", key(), 51), /DISPATCH_WRONG_SKU_OR_VARIANT/)
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
