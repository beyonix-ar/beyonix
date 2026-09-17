import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  toCustomerSafeOrderAuditEvent,
  toCustomerSafeOrderAuditEvents,
} from "./customer-order-audit-view.ts"

function source(relativePath: string) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8")
}

const INTERNAL_EVENT = {
  id: 1,
  order_id: 9,
  actor_type: "admin" as const,
  actor_id: "admin-uuid",
  action: "andreani_reconciliation_resolved",
  previous_status: "reconciliation_required",
  new_status: "created",
  created_at: "2026-09-17T12:00:00.000Z",
  metadata: {
    resolution: "created",
    notes: "Confirmé por teléfono con soporte Andreani el 17/09.",
    envioId: "ENV-REAL-1",
    tracking: "TRACK-1",
    andreaniSnapshot: {
      envioId: "ENV-REAL-1",
      environment: "PROD",
      estado: "En tránsito",
      trackingEventAt: "2026-09-17T11:00:00.000Z",
    },
    reasonCode: "pago_no_recibido",
    reasonText: "El cliente pidió cancelar por email.",
    previousEstado: "pagado",
    newEstado: "cancelado",
    source: "admin_direct_cancellation",
    claimId: 42,
  },
}

test("toCustomerSafeOrderAuditEvent elimina toda la metadata administrativa/operativa interna", () => {
  const safe = toCustomerSafeOrderAuditEvent(INTERNAL_EVENT)

  assert.equal(safe.action, "andreani_reconciliation_resolved")
  assert.equal(safe.actor_type, "admin")
  assert.equal(safe.new_status, "created")
  assert.equal(safe.created_at, "2026-09-17T12:00:00.000Z")

  const forbiddenKeys = [
    "andreaniSnapshot",
    "envioId",
    "environment",
    "tracking",
    "notes",
    "resolution",
    "reasonCode",
    "previousEstado",
    "source",
    "claimId",
  ]
  const serialized = JSON.stringify(safe)
  for (const key of forbiddenKeys) {
    assert.doesNotMatch(serialized, new RegExp(key), `no debe incluir "${key}"`)
  }
  // previous_status (top-level, no metadata) tampoco viaja: no lo usa
  // ninguna pantalla de cliente y describe transiciones internas.
  assert.ok(!("previous_status" in safe))
})

test("toCustomerSafeOrderAuditEvent conserva reasonText y newEstado -- lo único que usa el cliente", () => {
  const safe = toCustomerSafeOrderAuditEvent(INTERNAL_EVENT)

  assert.deepEqual(safe.metadata, {
    reasonText: "El cliente pidió cancelar por email.",
    newEstado: "cancelado",
  })
})

test("un evento sin metadata útil para el cliente devuelve metadata=null, no un objeto vacío ambiguo", () => {
  const safe = toCustomerSafeOrderAuditEvent({
    ...INTERNAL_EVENT,
    metadata: { andreaniSnapshot: { envioId: "x" }, source: "cron" },
  })

  assert.equal(safe.metadata, null)
})

test("un evento sin metadata en absoluto no rompe (null/undefined)", () => {
  assert.equal(toCustomerSafeOrderAuditEvent({ ...INTERNAL_EVENT, metadata: null }).metadata, null)
  assert.equal(
    toCustomerSafeOrderAuditEvent({ ...INTERNAL_EVENT, metadata: undefined }).metadata,
    null,
  )
})

test("toCustomerSafeOrderAuditEvents mapea un array completo y tolera null/undefined", () => {
  assert.deepEqual(toCustomerSafeOrderAuditEvents(null), [])
  assert.deepEqual(toCustomerSafeOrderAuditEvents(undefined), [])
  assert.equal(toCustomerSafeOrderAuditEvents([INTERNAL_EVENT, INTERNAL_EVENT]).length, 2)
})

// --- Wiring: las 3 rutas de cliente deben pasar por este sanitizador antes
// de responder, en vez de reenviar el objeto crudo de DB/RPC.

test("GET /api/orders sanea order_audit_events con toCustomerSafeOrderAuditEvents antes de responder", () => {
  const route = source("app/api/orders/route.ts")

  assert.match(route, /toCustomerSafeOrderAuditEvents/)
  assert.match(
    route,
    /order_audit_events:\s*toCustomerSafeOrderAuditEvents\(order\.order_audit_events\)/,
  )
})

test("GET /api/orders/[id] sanea order_audit_events con toCustomerSafeOrderAuditEvents antes de responder", () => {
  const route = source("app/api/orders/[id]/route.ts")

  assert.match(route, /toCustomerSafeOrderAuditEvents/)
})

test("POST /api/orders/[id]/cancel nunca reenvía la fila cruda del RPC -- pasa por un contrato público explícito", () => {
  const route = source("app/api/orders/[id]/cancel/route.ts")

  assert.match(route, /function toCustomerCancellationOrderView/)
  assert.match(route, /order:\s*toCustomerCancellationOrderView\(updatedOrder\)/)
  // Regresión: antes se hacía `order: updatedOrder` directo, reenviando
  // andreani_contrato / andreani_creation_environment /
  // andreani_creation_claim_token tal cual venían de to_jsonb(v_order).
  assert.doesNotMatch(route, /order:\s*updatedOrder\s*[,}]/)
})

test("toCustomerCancellationOrderView (fila completa simulada del RPC) nunca expone campos internos de creación Andreani", () => {
  const route = source("app/api/orders/[id]/cancel/route.ts")
  const fnMatch = route.match(
    /function toCustomerCancellationOrderView\(order: CancelableOrder\) \{([\s\S]*?)\n\}/,
  )
  assert.ok(fnMatch, "no se encontró toCustomerCancellationOrderView")
  const body = fnMatch![1]

  for (const forbidden of [
    "andreani_contrato",
    "andreani_creation_environment",
    "andreani_creation_claim_token",
    "andreani_creation_attempts",
    "andreani_envio_id",
    "invoice_cae",
    "payment_proof_url",
  ]) {
    assert.doesNotMatch(body, new RegExp(forbidden))
  }
  for (const allowed of ["id", "estado", "financial_status", "cancelled_at"]) {
    assert.match(body, new RegExp(allowed))
  }
})
