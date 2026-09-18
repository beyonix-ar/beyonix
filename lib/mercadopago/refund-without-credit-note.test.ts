import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Fase 4 (cierre del módulo cancelaciones/reintegros/NC), puntos 1 y 3.
// Ejercita las RPCs SQL REALES (no una reimplementación) contra PostgreSQL
// en memoria (PGlite): commit_order_refund_proof extendido (reintegro sin
// NC cuando el pedido nunca la necesitó) y begin_mercadopago_order_refund
// con el guard credit_note_required. Sin red, credenciales ni llamadas
// reales a Mercado Pago.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const schema = read("lib/mercadopago/fixtures/refund-without-credit-note.sql")
const migration = read(
  "supabase/migrations/20260917130000_external_refund_without_credit_note_and_mp_nc_policy.sql",
)

const admin = "10000000-0000-4000-8000-000000000003"
const customer = "10000000-0000-4000-8000-000000000001"

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(migration)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into auth.users(id) values($1),($2)", [admin, customer])
  await db.query("insert into public.profiles(id,rol) values($1,'admin'),($2,'cliente')", [admin, customer])
  return db
}

async function insertOrder(
  db: PGlite,
  overrides: Record<string, unknown> = {},
) {
  const fields = {
    id: 1,
    usuario_id: customer,
    total: 30000,
    payment_method_id: "transferencia",
    payment_confirmed_amount: 30000,
    financial_status: "refund_pending",
    estado: "cancelado",
    credit_note_required: false,
    ...overrides,
  }
  const columns = Object.keys(fields)
  const values = Object.values(fields)
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(",")
  await db.query(
    `insert into ordenes (${columns.join(",")}) values (${placeholders})`,
    values,
  )
}

async function beginUploadOperation(db: PGlite, orderId: number, path: string) {
  const operationId = randomUUID()
  await db.query(
    `insert into order_claim_operations (id, actor_id, order_id, request_key, status, file_paths, bucket_id)
     values ($1, $2, $3, $4, 'uploading', $5, 'payment-proofs')`,
    [operationId, admin, orderId, randomUUID(), [path]],
  )
  await db.query(`insert into storage.objects (bucket_id, name) values ('payment-proofs', $1)`, [path])
  return operationId
}

function commitRefundProof(
  db: PGlite,
  operationId: string,
  file: Record<string, unknown>,
) {
  return db.query<{ id: number; financial_status: string; refund_amount: string }>(
    "select * from commit_order_refund_proof($1, $2, $3::jsonb)",
    [operationId, admin, JSON.stringify(file)],
  )
}

// --- Punto 1: transferencia pagada, nunca facturada ---

test("transferencia sin factura (credit_note_required=false, sin NC): el reintegro se completa con el monto correcto", async () => {
  const db = await setup()
  try {
    await insertOrder(db, { id: 1 })
    const operationId = await beginUploadOperation(db, 1, "proof-1.jpg")

    const { rows } = await commitRefundProof(db, operationId, {
      path: "proof-1.jpg",
      name: "comprobante.jpg",
      type: "image/jpeg",
      size: 1024,
      reference: "OP-12345",
      refund_date: "2026-09-17",
      notes: "Transferencia realizada por Banco Galicia",
    })

    assert.equal(rows[0].financial_status, "refunded")
    assert.equal(Number(rows[0].refund_amount), 30000)

    const proof = await db.query<{
      amount: string
      bank_reference: string
      refund_date: string | Date
      observation: string
    }>("select amount, bank_reference, refund_date::text as refund_date, observation from order_refund_proofs where order_id=1")
    assert.equal(Number(proof.rows[0].amount), 30000)
    assert.equal(proof.rows[0].bank_reference, "OP-12345")
    assert.equal(proof.rows[0].observation, "Transferencia realizada por Banco Galicia")
    assert.ok(String(proof.rows[0].refund_date).startsWith("2026-09-17"))
  } finally {
    await db.close()
  }
})

test("reintentar el mismo reintegro (sin NC) después de completado -- CLAIM_REFUND_PENDING, no segunda devolución", async () => {
  const db = await setup()
  try {
    await insertOrder(db, { id: 1 })
    const firstOp = await beginUploadOperation(db, 1, "proof-1.jpg")
    await commitRefundProof(db, firstOp, {
      path: "proof-1.jpg",
      name: "comprobante.jpg",
      type: "image/jpeg",
      size: 1024,
    })

    const secondOp = await beginUploadOperation(db, 1, "proof-2.jpg")
    await assert.rejects(
      commitRefundProof(db, secondOp, { path: "proof-2.jpg", name: "otro.jpg", type: "image/jpeg", size: 1024 }),
      /CLAIM_REFUND_PENDING/,
    )

    const total = await db.query<{ count: string }>("select count(*)::text as count from order_refund_proofs where order_id=1")
    assert.equal(total.rows[0].count, "1")
  } finally {
    await db.close()
  }
})

test("saldo + transferencia sin factura: el monto sin NC es sólo la porción externa confirmada, no el total", async () => {
  const db = await setup()
  try {
    await insertOrder(db, { id: 1, total: 50000, credit_balance_used: 20000, payment_confirmed_amount: 30000 })
    const operationId = await beginUploadOperation(db, 1, "proof-1.jpg")
    const { rows } = await commitRefundProof(db, operationId, {
      path: "proof-1.jpg",
      name: "comprobante.jpg",
      type: "image/jpeg",
      size: 1024,
    })
    assert.equal(Number(rows[0].refund_amount), 30000)
  } finally {
    await db.close()
  }
})

test("un pedido que SÍ requiere NC nunca puede tomar el camino sin NC, aunque no tenga notas todavía", async () => {
  const db = await setup()
  try {
    await insertOrder(db, { id: 1, credit_note_required: true })
    const operationId = await beginUploadOperation(db, 1, "proof-1.jpg")
    await assert.rejects(
      commitRefundProof(db, operationId, { path: "proof-1.jpg", name: "comprobante.jpg", type: "image/jpeg", size: 1024 }),
      /CLAIM_REFUND_PENDING/,
      "sin NC autorizada, la rama normal (con NC) sigue exigiendo la nota -- nunca se cuela por la rama sin NC",
    )
  } finally {
    await db.close()
  }
})

test("el camino con NC sigue funcionando exactamente igual (regresión)", async () => {
  const db = await setup()
  try {
    await insertOrder(db, { id: 1, credit_note_required: true })
    const noteId = (
      await db.query<{ id: string }>(
        `insert into order_credit_notes (order_id, status, destination, cae, total_amount, settlement_status)
         values (1, 'authorized', 'external_refund', 'CAE-1', 30000, 'pendiente') returning id`,
      )
    ).rows[0].id
    const operationId = await beginUploadOperation(db, 1, "proof-1.jpg")

    const { rows } = await commitRefundProof(db, operationId, {
      path: "proof-1.jpg",
      name: "comprobante.jpg",
      type: "image/jpeg",
      size: 1024,
      expected_note_ids: [noteId],
    })
    assert.equal(rows[0].financial_status, "refunded")
    assert.equal(Number(rows[0].refund_amount), 30000)

    const note = await db.query<{ settlement_status: string }>("select settlement_status from order_credit_notes where id=$1", [noteId])
    assert.equal(note.rows[0].settlement_status, "completado")
  } finally {
    await db.close()
  }
})

test("referencia/observación demasiado largas se rechazan server-side", async () => {
  const db = await setup()
  try {
    await insertOrder(db, { id: 1 })
    const operationId = await beginUploadOperation(db, 1, "proof-1.jpg")
    await assert.rejects(
      commitRefundProof(db, operationId, {
        path: "proof-1.jpg",
        name: "comprobante.jpg",
        type: "image/jpeg",
        size: 1024,
        reference: "x".repeat(200),
      }),
      /INVALID_REFUND_DETAILS/,
    )
  } finally {
    await db.close()
  }
})

// --- Punto 3: política de NC para Mercado Pago ---

function beginMpRefund(db: PGlite, orderId: number) {
  return db.query<{ should_call_mp: boolean; amount: string }>(
    "select * from begin_mercadopago_order_refund($1, $2)",
    [orderId, admin],
  )
}

test("Mercado Pago facturado (credit_note_required=true) -- refund bloqueado hasta NC autorizada", async () => {
  const db = await setup()
  try {
    await insertOrder(db, {
      id: 1,
      payment_method_id: "mercadopago",
      payment_id: "MP-1",
      credit_note_required: true,
    })
    await assert.rejects(beginMpRefund(db, 1), /CREDIT_NOTE_REQUIRED/)
  } finally {
    await db.close()
  }
})

test("Mercado Pago sin factura (credit_note_required=false) -- refund sigue funcionando sin cambios", async () => {
  const db = await setup()
  try {
    await insertOrder(db, {
      id: 1,
      payment_method_id: "mercadopago",
      payment_id: "MP-1",
      credit_note_required: false,
    })
    const { rows } = await beginMpRefund(db, 1)
    assert.equal(rows[0].should_call_mp, true)
    assert.equal(Number(rows[0].amount), 30000)
  } finally {
    await db.close()
  }
})

test("Mercado Pago: una vez con NC autorizada (credit_note_required vuelve a false), el refund se desbloquea", async () => {
  const db = await setup()
  try {
    await insertOrder(db, {
      id: 1,
      payment_method_id: "mercadopago",
      payment_id: "MP-1",
      credit_note_required: true,
    })
    await assert.rejects(beginMpRefund(db, 1), /CREDIT_NOTE_REQUIRED/)

    // Simula lo que hace credit-note/route.ts al autorizar cualquier NC:
    // credit_note_required pasa a false, sin importar el destino.
    await db.query("update ordenes set credit_note_required=false where id=1")

    const { rows } = await beginMpRefund(db, 1)
    assert.equal(rows[0].should_call_mp, true)
  } finally {
    await db.close()
  }
})
