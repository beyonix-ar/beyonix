import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { calculateRemainingCreditableAmount } from "./credit-note-remaining.ts"

// Contrato SQL: set_pending_credit_note_amount cierra el TOCTOU entre
// "leer el remanente acreditable" y "escribir ordenes.credit_note_amount"
// (app/api/admin/order-claims/[claimId]/route.ts). Estos tests no pueden
// levantar la base local (no hay Docker en este entorno) para probar la
// concurrencia real; en su lugar verifican, por contrato estático:
//   1) que la RPC toma el MISMO advisory lock por pedido que
//      begin_partial_credit_note (así ambas rutas que tocan
//      order_credit_notes/credit_note_amount se serializan entre sí, y no
//      solo "cada una por su lado"), y
//   2) que la lógica de validación (remanente = total - comprometido,
//      comprometido = processing+authorized, rechaza si excede) es la
//      correcta.
// La prueba de que la carrera real queda cerrada se hace con una
// simulación a nivel de lógica (más abajo), comparando el patrón viejo
// (leer-luego-escribir sin recomputar) contra el patrón nuevo (recomputar
// dentro de la misma "transacción" antes de escribir).

const RPC_MIGRATION = readFileSync(
  new URL(
    "../../supabase/migrations/20260818100000_atomic_pending_credit_note_amount.sql",
    import.meta.url,
  ),
  "utf8",
)

const PARTIAL_NOTE_MIGRATION = readFileSync(
  new URL(
    "../../supabase/migrations/20260729181538_formalize_partial_credit_notes.sql",
    import.meta.url,
  ),
  "utf8",
)

test("set_pending_credit_note_amount usa el mismo advisory lock por pedido que begin_partial_credit_note", () => {
  const lockPattern = /pg_advisory_xact_lock\(91091,\s*p_order_id::integer\)/

  assert.match(
    RPC_MIGRATION,
    lockPattern,
    "set_pending_credit_note_amount debe tomar pg_advisory_xact_lock(91091, p_order_id::integer)",
  )
  assert.match(
    PARTIAL_NOTE_MIGRATION,
    lockPattern,
    "begin_partial_credit_note debe seguir tomando el mismo lock (91091) para que ambas rutas se serialicen",
  )
})

test("set_pending_credit_note_amount bloquea la fila de la orden y recalcula el remanente contra processing+authorized", () => {
  assert.match(RPC_MIGRATION, /from public\.ordenes\s*\n\s*where id = p_order_id\s*\n\s*for update/)
  assert.match(
    RPC_MIGRATION,
    /from public\.order_credit_notes\s*\n\s*where order_id = p_order_id\s*\n\s*and status in \('processing', 'authorized'\)/,
  )
})

test("set_pending_credit_note_amount rechaza server-side un importe que excede el remanente, sin confiar solo en la validación previa de TypeScript", () => {
  assert.match(RPC_MIGRATION, /if v_amount > v_remaining \+ 0\.005 then/)
  assert.match(RPC_MIGRATION, /raise exception 'CREDIT_NOTE_EXCEEDS_REMAINING'/)
  assert.match(RPC_MIGRATION, /if v_amount <= 0 then/)
  assert.match(RPC_MIGRATION, /raise exception 'INVALID_CREDIT_NOTE_AMOUNT'/)
})

test("set_pending_credit_note_amount solo es ejecutable por service_role (no expone la RPC a clientes)", () => {
  assert.match(
    RPC_MIGRATION,
    /revoke all on function public\.set_pending_credit_note_amount\(bigint, numeric\)\s*\n\s*from public, anon, authenticated;/,
  )
  assert.match(
    RPC_MIGRATION,
    /grant execute on function public\.set_pending_credit_note_amount\(bigint, numeric\)\s*\n\s*to service_role;/,
  )
})

// --- Simulación de la carrera a nivel de lógica ---
//
// Modela dos requests concurrentes que quieren dejar pendiente un
// credit_note_amount sobre el mismo pedido, mientras una tercera operación
// (equivalente a begin_partial_credit_note) autoriza una nota de crédito
// justo en el medio.

type Note = { status: string; total_amount: number }

function staleReadThenWrite(
  orderTotal: number,
  notesAtReadTime: Note[],
  requestedAmount: number,
) {
  // Patrón viejo: lee el remanente una vez, valida, y escribe sin
  // recomputar — exactamente el bug que reportó Codex.
  const remaining = calculateRemainingCreditableAmount(orderTotal, notesAtReadTime)
  const wouldSucceed = requestedAmount <= remaining + 0.005
  return { wouldSucceed, remaining }
}

function atomicRecomputeThenWrite(
  orderTotal: number,
  currentNotes: Note[],
  requestedAmount: number,
) {
  // Patrón nuevo (lo que hace set_pending_credit_note_amount dentro del
  // advisory lock): recalcula el remanente contra el estado ACTUAL de
  // order_credit_notes, dentro de la misma transacción que hace la
  // escritura, así que siempre ve cualquier nota que ya haya committeado.
  const remaining = calculateRemainingCreditableAmount(orderTotal, currentNotes)
  if (requestedAmount > remaining + 0.005) {
    throw new Error("CREDIT_NOTE_EXCEEDS_REMAINING")
  }
  return { credit_note_amount: requestedAmount, remaining }
}

test("un importe válido dentro del remanente puede almacenarse", () => {
  const result = atomicRecomputeThenWrite(50000, [], 20000)
  assert.equal(result.credit_note_amount, 20000)
  assert.equal(result.remaining, 50000)
})

test("un importe superior al remanente falla", () => {
  assert.throws(
    () => atomicRecomputeThenWrite(50000, [{ status: "authorized", total_amount: 45000 }], 10000),
    /CREDIT_NOTE_EXCEEDS_REMAINING/,
  )
})

test("notas authorized/processing reducen correctamente el disponible antes de aceptar un nuevo importe", () => {
  const notes = [
    { status: "authorized", total_amount: 20000 },
    { status: "processing", total_amount: 15000 },
  ]
  assert.throws(
    () => atomicRecomputeThenWrite(50000, notes, 20000),
    /CREDIT_NOTE_EXCEEDS_REMAINING/,
  )
  const result = atomicRecomputeThenWrite(50000, notes, 15000)
  assert.equal(result.remaining, 15000)
})

test("carrera detectada: el patrón viejo (leer-luego-escribir) permite sobreacreditar; el patrón atómico no", () => {
  const orderTotal = 50000
  const notesAtReadTime: Note[] = [] // ninguna nota comprometida todavía cuando arrancan ambos requests

  // Dos reclamos concurrentes, cada uno propone $30.000 (cabe individualmente
  // contra el remanente leído, pero juntos exceden el total del pedido).
  const requestA = staleReadThenWrite(orderTotal, notesAtReadTime, 30000)
  const requestB = staleReadThenWrite(orderTotal, notesAtReadTime, 30000)
  assert.ok(requestA.wouldSucceed)
  assert.ok(requestB.wouldSucceed) // ambos "pasan" contra el mismo snapshot stale: bug reproducido

  // Con el patrón atómico, la segunda escritura recalcula contra el estado
  // real (que ya incluye lo que la primera comprometió) y falla.
  const notesAfterA: Note[] = [{ status: "processing", total_amount: 30000 }]
  const resultA = atomicRecomputeThenWrite(orderTotal, [], 30000)
  assert.equal(resultA.credit_note_amount, 30000)
  assert.throws(
    () => atomicRecomputeThenWrite(orderTotal, notesAfterA, 30000),
    /CREDIT_NOTE_EXCEEDS_REMAINING/,
    "la segunda escritura debe fallar server-side aunque su validación previa en TypeScript haya visto un remanente stale",
  )
})
