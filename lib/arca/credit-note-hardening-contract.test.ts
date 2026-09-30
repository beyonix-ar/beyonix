import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { getNotesPendingReconciliation } from "./credit-note-reconciliation-view.ts"

// Contratos de integración del hardening de Notas de Crédito C.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")
const route = read("app/api/admin/orders/[id]/credit-note/route.ts")
const finalization = read("lib/orders/credit-note-finalization.ts")
const reconcile = read("app/api/admin/credit-notes/[noteId]/reconcile/route.ts")

test("emisión: reserva -> servicio idempotente -> finalización reanudable; nunca FECAESolicitar directo", () => {
  assert.doesNotMatch(route, /fecaeSolicitar|feCompUltimoAutorizado|feCompConsultar/)
  const pointCheck = route.indexOf("configuration = requireArcaConfiguration()")
  const reservation = route.indexOf('.rpc("begin_partial_credit_note"')
  const emission = route.indexOf("await emitCreditNote(auth.admin, {")
  const finalize = route.indexOf("await finalizeCreditNote(auth.admin, { noteId, actorId: auth.user.id })")
  assert.ok(pointCheck > 0 && pointCheck < reservation, "config inválida nunca deja una NC reservada colgada")
  assert.ok(reservation < emission && emission < finalize)
  assert.match(route, /conditioned_discount_percent:\s*stockDestination === "stock_observaciones" \? conditionedDiscountPercent : null/)
  assert.match(route, /usá “Conciliar con ARCA” para completar la gestión sin emitir otra nota/)
  assert.match(route, /reconciliation_required: true/)
})

test("finalización: stock, saldo y resumen idempotentes; auditoría sólo la primera vez; sin mover dinero externo", () => {
  assert.match(finalization, /p_idempotency_key: `credit-note-item:\$\{creditItem\.id\}`/)
  assert.match(finalization, /RETURN_EXCEEDS_REMAINING/)
  assert.match(finalization, /creditCustomerForOrderCreditNote\(admin, \{/)
  const finish = finalization.indexOf('admin.rpc("finish_credit_note_finalization"')
  const audit = finalization.indexOf('action: "credit_note_authorized"')
  assert.ok(finish > 0 && finish < audit)
  assert.match(finalization, /if \(firstFinalization === true\) \{/)
  // Reintegro a saldo BEYONIX sí (idempotente por comprobante); dinero
  // externo nunca: ni Mercado Pago ni comprobantes de reintegro.
  assert.doesNotMatch(finalization, /mercadopago|refund_proof|order_refund_proofs|external_amount_due/i)
  assert.match(finalization, /\.is\("stock_processed_at", null\)/)
})

test("conciliación: sólo Admin, nunca emite una NC nueva y completa pasos pendientes", () => {
  assert.match(reconcile, /requireAdmin\(request\)/)
  assert.match(reconcile, /reconcileCreditNote\(auth\.admin, \{ noteId, gateway: createWsfeInvoiceGateway\(configuration\) \}\)/)
  assert.doesNotMatch(reconcile, /emitCreditNote|requestCae|fecaeSolicitar|begin_partial_credit_note/)
  assert.match(reconcile, /finalizeCreditNote\(auth\.admin, \{ noteId, actorId: auth\.user\.id \}\)/)
  const service = read("lib/arca/credit-note-emission.ts")
  const reconcileFn = service.slice(service.indexOf("export async function reconcileCreditNote"))
  assert.doesNotMatch(reconcileFn, /requestCae|record_credit_note_request/)
})

test("Admin: alerta de conciliación sólo para NC colgadas o autorizadas sin completar", () => {
  const notes = [
    { id: "a", status: "authorized", finalized_at: "2026-09-27T10:00:00Z" },
    { id: "b", status: "processing", error: "Resultado fiscal pendiente de conciliación." },
    { id: "c", status: "authorized", finalized_at: null },
    { id: "d", status: "error" },
    // Antes de aplicar la migración la columna no existe: nunca se marca.
    { id: "e", status: "authorized" },
  ]
  assert.deepEqual(getNotesPendingReconciliation(notes, false).map((note) => note.id), ["b", "c"])
  assert.deepEqual(getNotesPendingReconciliation(notes, true), [], "mientras se emite, no se ofrece conciliar")
  const admin = read("app/admin/sections/pedidos/admin-pedidos.tsx")
  assert.match(admin, /<CreditNoteReconcileAlert\s*notes=\{getNotesPendingReconciliation\(creditNotes, creditSaving\)\}/)
})
