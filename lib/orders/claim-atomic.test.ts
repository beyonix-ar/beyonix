import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const customer = "10000000-0000-4000-8000-000000000001"
const other = "10000000-0000-4000-8000-000000000002"
const admin = "10000000-0000-4000-8000-000000000003"
const operator = "10000000-0000-4000-8000-000000000004"
const schema = readFileSync(new URL("./fixtures/claim-schema.sql", import.meta.url), "utf8")
const migration = readFileSync(new URL("../../supabase/migrations/20260905150000_claims_atomic_operations.sql", import.meta.url), "utf8")

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(readFileSync(new URL("../../supabase/migrations/20260816120000_atomic_order_claim_cancellation.sql", import.meta.url), "utf8"))
  try {
    await db.exec(migration)
    await db.exec(readFileSync(new URL("../../supabase/migrations/20260906090000_claim_case_type_transitions.sql", import.meta.url), "utf8"))
    await db.exec(readFileSync(new URL("../../supabase/migrations/20260906100000_claims_final_security.sql", import.meta.url), "utf8"))
    await db.exec(readFileSync(new URL("../../supabase/migrations/20260906110000_claim_credit_note_snapshot.sql", import.meta.url), "utf8"))
  } catch (error) {
    await db.close()
    throw new Error(error instanceof Error ? error.message : "Migration failed")
  }
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  for (const [id, role] of [[customer,"cliente"],[other,"cliente"],[admin,"admin"],[operator,"operador"]]) {
    await db.query("insert into auth.users values($1,$2,now());", [id, `${id}@example.test`])
    await db.query("insert into profiles(id,email,rol) values($1,$2,$3)", [id, `${id}@example.test`, role])
  }
  await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,financial_status) values(1,$1,'entregado',now()-interval '1 day','payment_confirmed'),(2,$2,'entregado',now()-interval '1 day','payment_confirmed')", [customer,other])
  await db.exec("insert into orden_items(id,orden_id,cantidad) values(1,1,2),(2,2,1)")
  return db
}

async function begin(db: PGlite, actor=customer, order=1, key=randomUUID().replaceAll('-','').repeat(2), paths: string[]=[], bucket='order-claim-evidence') {
  const id=randomUUID()
  const result=await db.query<{ op: { id: string; status: string; acquired: boolean } }>("select begin_order_claim_operation($1,$2,$3,$4,$5,$6) as op",[id,actor,order,key,paths,bucket])
  return result.rows[0].op
}
async function create(db: PGlite) {
  const op=await begin(db)
  const result=await db.query<{ id: number }>("select commit_customer_order_claim($1,$2,$3,'[]') as id", [op.id,customer,JSON.stringify({problemType:'falla',message:'El producto dejó de funcionar.',items:[{order_item_id:1,quantity:1}]})])
  return result.rows[0].id
}
async function row(db: PGlite, id: number) {
  return (await db.query<{ status: string; version: string; admin_needs_action: boolean }>("select status,updated_at::text as version,admin_needs_action from order_claims where id=$1",[id])).rows[0]
}
async function mutate(db: PGlite,id: number,version: string,patch: Record<string,unknown>,actor=admin) {
  return db.query("select mutate_admin_order_claim($1,$2,$3,$4)",[id,actor,version,JSON.stringify(patch)])
}

test("SQL: ownership e items ajenos fallan sin crear reclamos", async () => {
  const db=await setup()
  try {
    const op=await begin(db,other,1)
    await assert.rejects(db.query("select commit_customer_order_claim($1,$2,$3,'[]')",[op.id,other,JSON.stringify({problemType:'falla',message:'Descripción suficiente',items:[{order_item_id:1,quantity:1}]})]),/CLAIM_FORBIDDEN/)
    const own=await begin(db)
    await assert.rejects(db.query("select commit_customer_order_claim($1,$2,$3,'[]')",[own.id,customer,JSON.stringify({problemType:'falla',message:'Descripción suficiente',items:[{order_item_id:2,quantity:1}]})]),/CLAIM_INVALID_ITEMS/)
    assert.equal((await db.query<{ count: number }>("select count(*)::integer as count from order_claims")).rows[0].count,0)
  } finally { await db.close() }
})

test("SQL: tipo y plazo se reconstruyen; no se acepta garantía para daño de transporte", async () => {
  const db=await setup()
  try {
    await db.exec("update ordenes set delivered_at=now()-interval '3 days' where id=1")
    const op=await begin(db)
    await assert.rejects(db.query("select commit_customer_order_claim($1,$2,$3,'[]')",[op.id,customer,JSON.stringify({problemType:'danado',claimType:'garantia_beyonix',message:'Descripción suficiente',items:[{order_item_id:1,quantity:1}]})]),/CLAIM_EXPIRED/)
    await db.exec("update ordenes set delivered_at=null where id=1")
    await assert.rejects(create(db),/CLAIM_DELIVERY_DATE/)
  } finally { await db.close() }
})

test("SQL: versión de pantalla rechaza respuestas simultáneas que conservan el estado", async () => {
  const db=await setup()
  try {
    const id=await create(db)
    const before=await row(db,id)
    const results=await Promise.allSettled([
      mutate(db,id,before.version,{status:'recibido',admin_response:'Respuesta A',append_message:true}),
      mutate(db,id,before.version,{status:'recibido',admin_response:'Respuesta B',append_message:true}),
    ])
    assert.equal(results.filter((result)=>result.status==='fulfilled').length,1)
    const current=await row(db,id)
    assert.equal(current.admin_needs_action,false)
    await mutate(db,id,current.version,{status:'cerrado',resolution:'otro'})
    await assert.rejects(mutate(db,id,(await row(db,id)).version,{status:'cerrado',admin_response:'No debe cambiar'}),/CLAIM_TERMINAL/)
  } finally { await db.close() }
})

test("SQL: operador no aprueba resoluciones económicas; cierre genérico no simula reintegro", async () => {
  const db=await setup()
  try {
    const id=await create(db)
    const before=await row(db,id)
    await assert.rejects(mutate(db,id,before.version,{status:'reintegro_pendiente',resolution:'reintegro_total'},operator),/CLAIM_FORBIDDEN/)
    await mutate(db,id,before.version,{status:'reintegro_pendiente',resolution:'reintegro_total'})
    const current=await row(db,id)
    await assert.rejects(mutate(db,id,current.version,{status:'cerrado'}),/CLAIM_ECONOMIC_CLOSE/)
    await assert.rejects(mutate(db,id,current.version,{action:'mark_refund_done'}),/CLAIM_REFUND_PENDING/)
    await assert.rejects(mutate(db,id,current.version,{action:'save_coupon',coupon_code:'inventado'}),/CLAIM_INVALID/)
  } finally { await db.close() }
})

test("SQL: fallo de auditoría revierte estado y mensaje completos", async () => {
  const db=await setup()
  try {
    const id=await create(db)
    const before=await row(db,id)
    await db.exec("alter table order_audit_events add constraint test_audit_failure check (action<>'claim_update')")
    await assert.rejects(mutate(db,id,before.version,{status:'en_revision',admin_response:'Mensaje que no debe quedar',append_message:true}),/test_audit_failure/)
    assert.equal((await row(db,id)).status,'recibido')
    assert.equal((await db.query<{ count: number }>("select count(*)::integer as count from order_claim_messages")).rows[0].count,1)
  } finally { await db.close() }
})

test("SQL: retry devuelve el mismo reclamo y la DB rechaza un segundo formal", async () => {
  const db=await setup()
  try {
    const key='a'.repeat(64)
    const op=await begin(db,customer,1,key)
    const duplicate=await begin(db,customer,1,key)
    assert.equal(duplicate.acquired,false)
    assert.equal(duplicate.id,op.id)
    const payload=JSON.stringify({problemType:'falla',message:'Descripción suficiente',items:[{order_item_id:1,quantity:1}]})
    const query="select commit_customer_order_claim($1,$2,$3,'[]') as id"
    const first=await db.query<{id:number}>(query,[op.id,customer,payload])
    const retry=await db.query<{id:number}>(query,[op.id,customer,payload])
    assert.equal(first.rows[0].id,retry.rows[0].id)
    const id=first.rows[0].id
    await mutate(db,id,(await row(db,id)).version,{status:'cerrado',resolution:'otro'})
    await assert.rejects(create(db),/CLAIM_EXISTS/)
  } finally { await db.close() }
})

test("SQL: RLS/grants impiden escrituras directas y acceso a RPC del navegador", async () => {
  const db=await setup()
  try {
    await create(db)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[customer])
    await db.exec("grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated; set role authenticated")
    assert.equal((await db.query("select id from order_claims")).rows.length,0)
    await assert.rejects(db.exec("insert into order_claim_messages(claim_id,author_role,message) values(1,'admin','falso')"),/permission denied/)
    await assert.rejects(db.exec("truncate order_claims"),/permission denied/)
    await assert.rejects(db.query("select mutate_admin_order_claim(1,$1,now(),'{}')",[customer]),/permission denied/)
  } finally { await db.close() }
})

test("SQL: archivos incompletos revierten creación, mensajes, metadata y auditoría", async () => {
  const db=await setup()
  try {
    const id=randomUUID(), path=customer+'/'+id+'/0.jpg'
    await db.query("select begin_order_claim_operation($1,$2,1,$3,$4)",[id,customer,'b'.repeat(64),[path]])
    await assert.rejects(db.query("select commit_customer_order_claim($1,$2,$3,$4)",[id,customer,JSON.stringify({problemType:'falla',message:'Descripción suficiente',items:[{order_item_id:1,quantity:1}]}),JSON.stringify([{path,name:'foto.jpg',type:'image/jpeg',size:20}])]),/CLAIM_INVALID_FILES/)
    for (const table of ['order_claims','order_claim_messages','order_claim_files','order_audit_events']) assert.equal((await db.query(`select * from ${table}`)).rows.length,0)
  } finally { await db.close() }
})

test("SQL: perfil no puede escalar mediante INSERT ni mediante un trigger que cambia rol al editar email", async () => {
  const db=await setup()
  try {
    await db.exec("create function test_email_promotion() returns trigger language plpgsql as $$ begin if new.email='promotion@example.test' then new.rol='super_admin'; end if; return new; end $$; create trigger protect_primary_super_admin before update on profiles for each row execute function test_email_promotion();")
    await db.query("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[customer])
    await assert.rejects(db.query("update profiles set email='promotion@example.test' where id=$1",[customer]),/PROFILE_ROLE_FORBIDDEN/)
    await assert.rejects(db.query("insert into profiles(id,email,rol) values($1,'attacker@example.test','admin')",[randomUUID()]),/PROFILE_ROLE_FORBIDDEN/)
    assert.equal((await db.query<{rol:string}>("select rol from profiles where id=$1",[customer])).rows[0].rol,'cliente')
  } finally { await db.close() }
})

test("SQL: reintegro canónico atómico, idempotente y respaldado por nota autorizada", async () => {
  const db=await setup()
  try {
    const claimId=await create(db)
    await mutate(db,claimId,(await row(db,claimId)).version,{status:'reintegro_pendiente',resolution:'reintegro_total'})
    const op=randomUUID(), path=admin+'/'+op+'/0.pdf'
    await db.query("select begin_order_claim_operation($1,$2,1,$3,$4,'payment-proofs')",[op,admin,'c'.repeat(64),[path]])
    await db.query("insert into storage.objects values('payment-proofs',$1)",[path])
    const noteId = randomUUID()
    const file=JSON.stringify({path,name:'comprobante.pdf',type:'application/pdf',size:20,expected_note_ids:[noteId]})
    await assert.rejects(db.query("select commit_order_refund_proof($1,$2,$3)",[op,admin,file]),/CLAIM_REFUND_PENDING/)
    await db.query("insert into order_credit_notes(id,order_id,claim_id,status,destination,total_amount,cae) values($2,1,$1,'authorized','external_refund',50,'test')",[claimId,noteId])
    await assert.rejects(db.query("select commit_order_refund_proof($1,$2,$3)", [op,admin,JSON.stringify({path,expected_note_ids:[randomUUID()]})]), /CLAIM_CONFLICT/)
    await db.exec("alter table order_audit_events add constraint test_refund_failure check(action<>'order_refunded')")
    await assert.rejects(db.query("select commit_order_refund_proof($1,$2,$3)",[op,admin,file]),/test_refund_failure/)
    assert.equal((await db.query("select * from order_refund_proofs")).rows.length,0)
    await db.exec("alter table order_audit_events drop constraint test_refund_failure")
    await db.query("select commit_order_refund_proof($1,$2,$3)",[op,admin,file])
    await db.query("select commit_order_refund_proof($1,$2,$3)",[op,admin,file])
    assert.equal((await db.query("select * from order_refund_proofs")).rows.length,1)
    await mutate(db,claimId,(await row(db,claimId)).version,{action:'mark_refund_done'})
    assert.equal((await row(db,claimId)).status,'cerrado')
  } finally { await db.close() }
})

test("SQL: no modifica cantidades procesadas o comprometidas por nota fiscal", async () => {
  const db=await setup()
  try {
    const id=await create(db)
    await db.exec("update orden_items set return_inventory_processed_at=now() where id=1")
    await assert.rejects(mutate(db,id,(await row(db,id)).version,{action:'affected_items',items:[{order_item_id:1,quantity:2}]}),/CLAIM_ITEMS_LOCKED/)
    await db.exec("update orden_items set return_inventory_processed_at=null where id=1")
    await db.query("insert into order_credit_notes(order_id,claim_id,status) values(1,$1,'processing')",[id])
    await assert.rejects(mutate(db,id,(await row(db,id)).version,{action:'affected_items',items:[{order_item_id:1,quantity:2}]}),/CLAIM_ITEMS_LOCKED/)
    await assert.rejects(db.query("select process_claim_return_inventory($1,1,1,0,0,'',$2)",[id,admin]),/CLAIM_INVALID_ITEMS/)
    await assert.rejects(db.query("select process_claim_return_inventory($1,1,1,1,0,'',$2)",[id,admin]),/CLAIM_ITEMS_LOCKED/)
  } finally { await db.close() }
})

test("SQL: cancelación delegada conserva auditoría, mensaje y orden; rechaza operador y versión vieja",async()=>{
  const db=await setup()
  try {
    await db.exec("update ordenes set estado='pendiente',delivered_at=null,financial_status='pending_payment' where id=1")
    await db.query("insert into order_claims(order_id,user_id,claim_type,failure_type,description) values(1,$1,'transporte_48hs','cancelar_compra','Cancelar mi compra')",[customer])
    const before=await row(db,1)
    await assert.rejects(mutate(db,1,before.version,{action:'approve_cancellation'},operator),/CLAIM_FORBIDDEN/)
    await mutate(db,1,before.version,{action:'approve_cancellation',admin_response:'Cancelación aprobada.'})
    assert.equal((await row(db,1)).status,'cerrado')
    assert.equal((await db.query<{estado:string}>("select estado from ordenes where id=1")).rows[0].estado,'cancelado')
    assert.equal((await db.query("select * from order_claim_messages where claim_id=1")).rows.length,1)
    assert.equal((await db.query("select * from order_audit_events where action='claim_approve_cancellation'")).rows.length,1)
    await assert.rejects(mutate(db,1,before.version,{action:'approve_cancellation'}),/CLAIM_CONFLICT|CLAIM_TERMINAL/)
  } finally {await db.close()}
})

test("SQL: nota de crédito requiere acreditación completada; no admite importes ajenos a la resolución",async()=>{
  const db=await setup()
  try {
    const id=await create(db)
    const before=await row(db,id)
    await assert.rejects(mutate(db,id,before.version,{status:'en_revision',resolution:'otro',credit_note_amount:20}),/CLAIM_INVALID_AMOUNT/)
    await mutate(db,id,before.version,{status:'aprobado',resolution:'cupon_descuento',credit_note_amount:20})
    await db.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,cae) values(1,$1,'authorized','customer_balance',20,'test')",[id])
    await db.query("insert into customer_credit_movements(order_id,claim_id,source_type,movement_type) values(1,$1,'credit_note','credit')",[id])
    await assert.rejects(mutate(db,id,(await row(db,id)).version,{action:'mark_credit_note_issued'}),/CLAIM_CREDIT_PENDING/)
    await db.exec("update order_credit_notes set settlement_status='completado' where order_id=1")
    await mutate(db,id,(await row(db,id)).version,{action:'mark_credit_note_issued'})
    assert.equal((await row(db,id)).status,'cerrado')
  } finally {await db.close()}
})

test("SQL: PATCH genérico no cierra cancelaciones ni convierte consultas en operaciones económicas",async()=>{
  const db=await setup()
  try {
    await db.query("insert into order_claims(order_id,user_id,claim_type,failure_type,description) values(1,$1,'transporte_48hs','cancelar_compra','Cancelar mi compra')",[customer])
    await assert.rejects(mutate(db,1,(await row(db,1)).version,{status:'cerrado',resolution:'otro'},operator),/CLAIM_CANCELLATION_ACTION/)
    await db.query("insert into order_claims(order_id,user_id,claim_type,failure_type,description) values(2,$1,'transporte_48hs','consulta_pedido','Consulta sobre mi compra')",[other])
    await assert.rejects(mutate(db,2,(await row(db,2)).version,{status:'aprobado',resolution:'reintegro_total'}),/CLAIM_INVALID/)
    await assert.rejects(mutate(db,2,(await row(db,2)).version,{status:'en_revision',resolution:'rechazado'}),/CLAIM_INVALID/)
    await mutate(db,2,(await row(db,2)).version,{status:'cerrado',resolution:'otro'},operator)
    assert.equal((await row(db,2)).status,'cerrado')
  } finally {await db.close()}
})

test("SQL: RPC retirada deniega acceso incluso al servicio; recepción no opera terminales", async () => {
  const db = await setup()
  try {
    const id = await create(db)
    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.exec(`set role ${role}`)
      await assert.rejects(db.query("select approve_order_claim_product_change($1,$2)", [id, admin]), /permission denied/)
      await db.exec("reset role")
    }
    await mutate(db, id, (await row(db, id)).version, { status: "cerrado", resolution: "otro" })
    await assert.rejects(db.query("select process_claim_return_inventory($1,1,1,1,0,'',$2)", [id, admin]), /CLAIM_TERMINAL/)
  } finally { await db.close() }
})

test("SQL: una nota comprometida bloquea cambiar resolución, rechazo y cierre prematuro", async () => {
  const db = await setup()
  try {
    const id = await create(db)
    await mutate(db, id, (await row(db, id)).version, { status: "aprobado", resolution: "otro" })
    await db.query("insert into order_credit_notes(order_id,claim_id,status) values(1,$1,'processing')", [id])
    const version = (await row(db, id)).version
    await assert.rejects(mutate(db, id, version, { resolution: "cambio_producto" }), /CLAIM_RESOLUTION_LOCKED/)
    await assert.rejects(mutate(db, id, version, { status: "rechazado", resolution: "rechazado", rejection_reason: "No corresponde" }), /CLAIM_RESOLUTION_LOCKED/)
    await assert.rejects(mutate(db, id, version, { status: "cerrado" }), /CLAIM_CREDIT_PENDING/)
    assert.equal((await row(db, id)).version, version)
  } finally { await db.close() }
})

test("SQL: la versión cambia aun dentro de la misma transacción y rechaza CAS anterior", async () => {
  const db = await setup()
  try {
    const id = await create(db)
    await db.exec("begin")
    const version = (await row(db, id)).version
    await mutate(db, id, version, { admin_response: "Respuesta concurrente", append_message: true })
    const current = (await row(db, id)).version
    assert.notEqual(current, version)
    await assert.rejects(mutate(db, id, version, { admin_response: "Respuesta obsoleta" }), /CLAIM_CONFLICT/)
    await db.exec("rollback")
  } finally { await db.close() }
})

test("SQL: comprobante de otra nota no habilita cierre; otra emisión pendiente tampoco", async () => {
  const db = await setup()
  try {
    const id = await create(db)
    await mutate(db, id, (await row(db, id)).version, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    await db.exec("update ordenes set financial_status='refunded' where id=1; insert into order_refund_proofs(order_id) values(1)")
    await db.query("insert into order_credit_notes(order_id,claim_id,status,destination,cae,settlement_status) values(1,$1,'authorized','external_refund','test','completado')", [id])
    await assert.rejects(mutate(db, id, (await row(db, id)).version, { action: "mark_refund_done" }), /CLAIM_REFUND_PENDING/)
    await db.exec("update order_credit_notes set settlement_reference='1' where order_id=1")
    await db.query("insert into order_credit_notes(order_id,claim_id,status) values(1,$1,'processing')", [id])
    await assert.rejects(mutate(db, id, (await row(db, id)).version, { action: "mark_refund_done" }), /CLAIM_REFUND_PENDING/)
  } finally { await db.close() }
})

test("SQL: operador no elude permisos cambiando una reposición a otra solución", async () => {
  const db = await setup()
  try {
    const id = await create(db)
    await mutate(db, id, (await row(db, id)).version, { status: "aprobado", resolution: "cambio_producto" })
    await assert.rejects(mutate(db, id, (await row(db, id)).version, { status: "cerrado", resolution: "otro" }, operator), /CLAIM_FORBIDDEN/)
  } finally { await db.close() }
})

test("SQL: emisión fiscal en proceso no expira ni se libera al reservar otra nota", async () => {
  const db = await setup()
  try {
    const id = await create(db)
    await db.query("insert into order_credit_notes(order_id,claim_id,status) values(1,$1,'processing')", [id])
    await assert.rejects(db.query("select begin_partial_credit_note(1,$1,'external_refund','Prueba aislada',10,0,10,1,1,$2,'[]','devolucion_parcial')", [id, admin]), /CREDIT_NOTE_PROCESSING_IN_PROGRESS/)
    assert.equal((await db.query<{ status: string }>("select status from order_credit_notes where order_id=1")).rows[0].status, "processing")
  } finally { await db.close() }
})

test("SQL: mensaje del cliente en aprobado conserva el badge de atención", async () => {
  const db = await setup()
  try {
    const id = await create(db)
    await mutate(db, id, (await row(db, id)).version, { status: "aprobado", resolution: "otro", admin_response: "Revisamos tu caso", append_message: true })
    assert.equal((await row(db, id)).admin_needs_action, false)
    const operation = await begin(db)
    await db.query("select commit_customer_order_claim($1,$2,$3,'[]')", [operation.id, customer, JSON.stringify({ claimId: id, expectedUpdatedAt: (await row(db, id)).version, message: "Tengo nueva información" })])
    assert.equal((await row(db, id)).admin_needs_action, true)
    await mutate(db, id, (await row(db, id)).version, { status: "cerrado" })
    assert.equal((await row(db, id)).admin_needs_action, false)
  } finally { await db.close() }
})

test("SQL: snapshot fiscal anterior no permite repetir una emisión parcial ya autorizada", async () => {
  const db = await setup()
  try {
    const id = await create(db)
    await mutate(db, id, (await row(db, id)).version, { status: "reintegro_pendiente", resolution: "reintegro_parcial" })
    await db.exec("update ordenes set invoice_status='authorized',invoice_cae='test',invoice_point=1,invoice_number=1 where id=1")
    const reserve = "select begin_partial_credit_note(1,$1,'external_refund','Prueba aislada',0,10,10,1,1,$2,'[]','devolucion_parcial','{}'::uuid[])"
    await db.query(reserve, [id, admin])
    await db.exec("update order_credit_notes set status='authorized' where order_id=1")
    await assert.rejects(db.query(reserve, [id, admin]), /CREDIT_NOTE_SNAPSHOT_CONFLICT/)
    assert.equal((await db.query("select id from order_credit_notes where order_id=1")).rows.length, 1)
    await db.exec("set role service_role")
    await assert.rejects(db.query("select begin_partial_credit_note(1,$1,'external_refund','Prueba aislada',10,0,10,1,1,$2,'[]','devolucion_parcial')", [id, admin]), /permission denied/)
  } finally { await db.close() }
})
