import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { buildClaimNotification, claimNeedsAdminAttention } from "./admin-notification-rules.ts"
import { getAdminPendingOrderActionCount } from "../orders/admin-pending-actions.ts"

// Punto rojo de "Atención al cliente", campana y contador del pedido: sólo
// avisan si un reclamo necesita una acción del Admin. Finalizado, rechazado o
// cancelado (status 'cerrado' + cancelled_at) nunca avisan.

const claim = (overrides: Record<string, unknown> = {}) => ({
  id: 1, order_id: 7, failure_type: "falla", status: "aprobado", admin_needs_action: false,
  first_reviewed_at: "2026-09-20T10:00:00Z", last_customer_message_at: "2026-09-20T09:00:00Z",
  last_admin_response_at: "2026-09-20T10:00:00Z", created_at: "2026-09-20T09:00:00Z", ...overrides,
})

test("finalizado, rechazado y cancelado nunca avisan, aunque haya quedado una marca vieja", () => {
  for (const terminal of [
    claim({ status: "cerrado", admin_needs_action: true }),
    claim({ status: "rechazado", admin_needs_action: true }),
    claim({ status: "cerrado", cancelled_at: "2026-09-22T10:00:00Z", admin_needs_action: true, last_customer_message_at: "2026-09-23T10:00:00Z" }),
  ]) {
    assert.equal(claimNeedsAdminAttention(terminal), false, JSON.stringify(terminal))
    assert.equal(buildClaimNotification(terminal), null)
  }
})

test("en curso: avisa sólo si hay algo para hacer (marcado por la base, sin revisar o mensaje nuevo del cliente)", () => {
  assert.equal(claimNeedsAdminAttention(claim()), false, "aprobado esperando a Andreani: nada que hacer")
  assert.equal(claimNeedsAdminAttention(claim({ first_reviewed_at: null })), false, "aprobado directo desde 'recibido': ya se decidió")
  assert.equal(claimNeedsAdminAttention(claim({ status: "recibido", first_reviewed_at: null })), true, "nuevo sin revisar")
  assert.equal(claimNeedsAdminAttention(claim({ admin_needs_action: true })), true)
  assert.equal(claimNeedsAdminAttention(claim({ last_customer_message_at: "2026-09-21T10:00:00Z" })), true, "el cliente escribió después")
})

test("contador del pedido: sigue mientras quede otro reclamo pendiente; desaparece al resolver el último", () => {
  const order = (claims: Array<Record<string, unknown>>) => ({ estado: "entregado", order_claims: claims })
  const pendingCount = (claims: Array<Record<string, unknown>>) =>
    getAdminPendingOrderActionCount(order(claims) as Parameters<typeof getAdminPendingOrderActionCount>[0])
  const cancelled = { id: 1, status: "cerrado", admin_needs_action: true }
  const open = { id: 2, status: "en_revision", admin_needs_action: true }
  assert.equal(pendingCount([cancelled, open]), 1, "el cancelado no cuenta; el otro sí")
  assert.equal(pendingCount([cancelled, { ...open, status: "rechazado" }]), 0, "rechazado el último: sin aviso")
  assert.equal(pendingCount([{ ...open, status: "cerrado", admin_needs_action: false }]), 0, "finalizado: sin aviso")
})

test("el punto rojo de Atención al cliente usa la misma regla (no 'cualquier reclamo no cerrado')", () => {
  const source = readFileSync(new URL("../../app/admin/sections/pedidos/admin-pedidos.tsx", import.meta.url), "utf8")
  assert.equal(source.split("find(claimNeedsAdminAttention)").length - 1, 2, "estado ejecutivo y pestaña")
  assert.doesNotMatch(source, /claim\.admin_needs_action \|\|\s*!\["cerrado", "rechazado"\]/, "nada de 'cualquier reclamo no cerrado'")
  const listRule = readFileSync(new URL("./order-notifications.ts", import.meta.url), "utf8")
  assert.match(listRule, /order\.order_claims \?\? \[\]\)\.some\(claimNeedsAdminAttention\)/, "listado de pedidos: misma regla")
})
