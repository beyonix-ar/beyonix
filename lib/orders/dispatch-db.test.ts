import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const actor = "20000000-0000-4000-8000-000000000002"
let requestNumber = 0
const key = () => `30000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`

async function setup() {
  const db = new PGlite()
  await db.exec(read("lib/orders/fixtures/dispatch-schema.sql"))
  await db.exec(read("supabase/migrations/20261005100000_dispatch_operations.sql"))
  await db.exec(read("supabase/migrations/20261005110000_dispatch_guards.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
  await db.exec("insert into productos values (1,'SKU-A','BAR-A'),(2,'SKU-B','BAR-B')")
  await db.exec("insert into producto_variantes values (11,1,'SKU-A-RED','BAR-A-RED'),(12,1,'SKU-A-BLUE','BAR-A-BLUE')")
  await db.exec("insert into ordenes(id) values (1031),(1032)")
  await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values (1,1031,1,11,2),(2,1031,2,null,1),(3,1032,1,12,1)")
  return db
}

async function prepare(db: PGlite, orderId: number, scans: Array<[number,string]>) {
  await db.query("select (begin_order_preparation($1,$2)).id", [orderId, actor])
  for (const [itemId, code] of scans) {
    await db.query("select (scan_order_preparation_item($1,$2,$3,$4,$5)).status", [orderId,itemId,code,actor,key()])
  }
}

test("preparation validates variant, SKU, exact quantities and duplicate scan keys", async () => {
  const db = await setup()
  try {
    await db.query("select begin_order_preparation($1,$2)", [1031,actor])
    await assert.rejects(db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"SKU-A-BLUE",actor,key()]), /DISPATCH_WRONG_SKU_OR_VARIANT/)
    await assert.rejects(db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"SKU-B",actor,key()]), /DISPATCH_WRONG_SKU_OR_VARIANT/)
    const scanKey = key()
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"BAR-A-RED",actor,scanKey])
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"BAR-A-RED",actor,scanKey])
    await assert.rejects(db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,2,"SKU-B",actor,scanKey]),/DISPATCH_SCAN_KEY_CONFLICT/)
    assert.equal((await db.query<{ scanned_quantity: number }>("select scanned_quantity from order_preparation_lines where order_item_id=1")).rows[0].scanned_quantity,1)
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"SKU-A-RED",actor,key()])
    await assert.rejects(db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,1,"SKU-A-RED",actor,key()]), /DISPATCH_QUANTITY_EXCEEDED/)
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)", [1031,2,"SKU-B",actor,key()])
    assert.equal((await db.query<{ status: string }>("select status from order_packages where order_id=1031")).rows[0].status,"prepared")
  } finally { await db.close() }
})

test("payment reversal and manual block stop a closed batch; resolution remains audited", async () => {
  const db=await setup()
  try {
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batch=(await db.query<{id:number}>("select (create_dispatch_batch($1,$2)).id",[actor,key()])).rows[0]
    await db.query("select add_order_to_dispatch_batch($1,$2,$3)",[batch.id,1032,actor])
    await db.query("select close_dispatch_batch($1,$2)",[batch.id,actor])
    await db.query("select set_dispatch_manual_block($1,$2,$3,$4)",[1032,actor,"Retener por control interno",true])
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor]),/DISPATCH_ORDER_BLOCKED/)
    await db.query("select set_dispatch_manual_block($1,$2,$3,$4)",[1032,actor,"Retener por control interno",false])
    await db.query("select set_dispatch_manual_block($1,$2,$3,$4)",[1032,actor,"Retener por control interno",false])
    await db.exec("update ordenes set financial_status='refund_pending' where id=1032")
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor]),/DISPATCH_ORDER_BLOCKED/)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1032 and reason='financial_conflict' and resolved_at is null")).rows[0].n,1)
    await db.exec("update ordenes set financial_status='payment_confirmed' where id=1032")
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1032 and resolved_at is null")).rows[0].n,0)
    await db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor])
    assert.equal((await db.query<{n:number}>("select count(*)::int n from order_audit_events where order_id=1032 and action in ('dispatch_block_added','dispatch_block_resolved')")).rows[0].n,2)
    await assert.rejects(db.exec("update ordenes set andreani_handed_over_at=null where id=1032"),/DISPATCH_HANDOVER_IMMUTABLE/)
  } finally { await db.close() }
})

test("refund in progress blocks delivery, and request cannot begin after physical handover", async () => {
  const db=await setup()
  try {
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batch=(await db.query<{id:number}>("select (create_dispatch_batch($1,$2)).id",[actor,key()])).rows[0]
    await db.query("select add_order_to_dispatch_batch($1,$2,$3)",[batch.id,1032,actor])
    await db.query("select close_dispatch_batch($1,$2)",[batch.id,actor])
    await db.exec("insert into mercadopago_order_refunds(order_id,status) values (1032,'processing')")
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor]),/DISPATCH_ORDER_BLOCKED/)
    await db.exec("update mercadopago_order_refunds set status='failed' where order_id=1032")
    await db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor])
    await assert.rejects(db.exec("insert into mercadopago_order_refunds(order_id,status,automation_mode) values (1032,'requested','automatic')"),/DISPATCH_REFUND_AFTER_HANDOVER/)
  } finally { await db.close() }
})

test("cancellation or item change before handover raises a durable dispatch hold", async () => {
  const db=await setup()
  try {
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batch=(await db.query<{id:number}>("select (create_dispatch_batch($1,$2)).id",[actor,key()])).rows[0]
    await db.query("select add_order_to_dispatch_batch($1,$2,$3)",[batch.id,1032,actor])
    await db.query("select close_dispatch_batch($1,$2)",[batch.id,actor])
    await db.exec("update orden_items set cantidad=2 where id=3")
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1032 and reason='items_changed' and resolved_at is null")).rows[0].n,1)
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor]),/DISPATCH_ORDER_BLOCKED/)
    await db.exec("update orden_items set cantidad=1 where id=3")
    await db.exec("update ordenes set estado='cancelado',cancelled_at=now(),financial_status='refund_pending' where id=1032")
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1032 and reason='cancelled' and resolved_at is null")).rows[0].n,1)
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[batch.id,actor]),/DISPATCH_ORDER_BLOCKED/)
  } finally { await db.close() }
})

test("packing may start while invoice or label is pending, but batch inclusion waits", async () => {
  const db=await setup()
  try {
    await db.exec("update ordenes set invoice_status='pending',invoice_cae=null,andreani_envio_id=null,andreani_creation_status=null where id=1032")
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batch=(await db.query<{id:number}>("select (create_dispatch_batch($1,$2)).id",[actor,key()])).rows[0]
    await assert.rejects(db.query("select add_order_to_dispatch_batch($1,$2,$3)",[batch.id,1032,actor]),/DISPATCH_ORDER_BLOCKED/)
    await db.exec("update ordenes set invoice_status='authorized',invoice_cae='CAE-TEST',andreani_envio_id='AND-TEST',andreani_creation_status='created' where id=1032")
    await db.query("select add_order_to_dispatch_batch($1,$2,$3)",[batch.id,1032,actor])
  } finally { await db.close() }
})

test("changed order can be re-prepared after controlled removal without losing scan history", async () => {
  const db=await setup()
  try {
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batch=(await db.query<{id:number}>("select (create_dispatch_batch($1,$2)).id",[actor,key()])).rows[0]
    await db.query("select add_order_to_dispatch_batch($1,$2,$3)",[batch.id,1032,actor])
    await db.query("select close_dispatch_batch($1,$2)",[batch.id,actor])
    await db.exec("update orden_items set cantidad=2 where id=3")
    const resetKey=key()
    await assert.rejects(db.query("select reset_order_preparation($1,$2,$3,$4)",[1032,actor,resetKey,"Se agrego una unidad al pedido"]),/DISPATCH_RESET_REQUIRES_REMOVAL/)
    await db.query("select remove_order_from_dispatch_batch($1,$2,$3,$4)",[batch.id,1032,actor,"Pedido modificado antes del despacho"])
    await db.query("select reset_order_preparation($1,$2,$3,$4)",[1032,actor,resetKey,"Se agrego una unidad al pedido"])
    await db.query("select reset_order_preparation($1,$2,$3,$4)",[1032,actor,resetKey,"Se agrego una unidad al pedido"])
    assert.equal((await db.query<{attempt_number:number}>("select attempt_number from order_packages where order_id=1032")).rows[0].attempt_number,2)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from order_preparation_scans where package_id=(select id from order_packages where order_id=1032)")).rows[0].n,1)
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)",[1032,3,"SKU-A-BLUE",actor,key()])
    await db.query("select scan_order_preparation_item($1,$2,$3,$4,$5)",[1032,3,"SKU-A-BLUE",actor,key()])
    assert.equal((await db.query<{status:string}>("select status from order_packages where order_id=1032")).rows[0].status,"prepared")
    assert.equal((await db.query<{n:number}>("select count(*)::int n from order_preparation_scans where package_id=(select id from order_packages where order_id=1032)")).rows[0].n,3)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1032 and resolved_at is null")).rows[0].n,0)
  } finally { await db.close() }
})

test("dispatch tables enforce RLS and RPCs reject untrusted callers", async () => {
  const db=await setup()
  try {
    const access=(await db.query<{rls:boolean;table_write:boolean;rpc_execute:boolean}>(`
      select c.relrowsecurity rls,
        has_table_privilege('authenticated','public.dispatch_batches','INSERT') table_write,
        has_function_privilege('authenticated','public.hand_over_dispatch_batch(bigint,uuid)','EXECUTE') rpc_execute
      from pg_class c where c.oid='public.dispatch_batches'::regclass
    `)).rows[0]
    assert.deepEqual(access,{rls:true,table_write:false,rpc_execute:false})
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(db.query("select begin_order_preparation($1,$2)",[1031,actor]),/DISPATCH_FORBIDDEN/)
  } finally { await db.close() }
})

test("batch code, active uniqueness, claim block, removal and atomic handover", async () => {
  const db = await setup()
  try {
    await prepare(db,1031,[[1,"SKU-A-RED"],[1,"SKU-A-RED"],[2,"SKU-B"]])
    await prepare(db,1032,[[3,"SKU-A-BLUE"]])
    const batchKey=key()
    const first=(await db.query<{id:number;code:string}>("select (create_dispatch_batch($1,$2)).*",[actor,batchKey])).rows[0]
    assert.match(first.code,/^DSP-\d{8}-001$/)
    assert.equal((await db.query<{id:number}>("select (create_dispatch_batch($1,$2)).id",[actor,batchKey])).rows[0].id,first.id)
    const second=(await db.query<{id:number}>("select (create_dispatch_batch($1,$2)).id",[actor,key()])).rows[0]
    await db.query("select add_order_to_dispatch_batch($1,$2,$3)",[first.id,1031,actor])
    await db.query("select add_order_to_dispatch_batch($1,$2,$3)",[first.id,1032,actor])
    await assert.rejects(db.query("select add_order_to_dispatch_batch($1,$2,$3)",[second.id,1031,actor]),/duplicate key/)
    await db.query("select close_dispatch_batch($1,$2)",[first.id,actor])
    await db.exec("insert into order_claims(order_id) values (1031)")
    await assert.rejects(db.query("select hand_over_dispatch_batch($1,$2)",[first.id,actor]),/DISPATCH_ORDER_BLOCKED/)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dispatch_blocks where order_id=1031 and reason='claim' and resolved_at is null")).rows[0].n,1)
    await db.query("select remove_order_from_dispatch_batch($1,$2,$3,$4)",[first.id,1031,actor,"Reclamo abierto, retirar bulto"])
    await db.query("select hand_over_dispatch_batch($1,$2)",[first.id,actor])
    await db.query("select hand_over_dispatch_batch($1,$2)",[first.id,actor])
    const order=(await db.query<{andreani_handed_over_at:string|null}>("select andreani_handed_over_at from ordenes where id=1032")).rows[0]
    assert.ok(order.andreani_handed_over_at)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from order_audit_events where order_id=1032 and action='order_handed_over_to_andreani'")).rows[0].n,1)
    await assert.rejects(db.query("insert into mercadopago_order_refunds(order_id,status,automation_mode) values (1032,'processing','automatic')"),/DISPATCH_REFUND_AFTER_HANDOVER/)
  } finally { await db.close() }
})
