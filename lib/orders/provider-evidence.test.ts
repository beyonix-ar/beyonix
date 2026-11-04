import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { getAdminDispatchStatus, getAdminShippingStage } from "./admin-order-status-presentation.ts"
import { getCancellationJourney, type CancellationJourneyOrder } from "./cancellation-journey.ts"
import { buildClaimShipmentTrace } from "./claim-shipment-trace.ts"
import { andreaniHandedOverAt, isOrderDeliveryReached, isOrderDispatchCutoffReached } from "./dispatch-cutoff.ts"
import type { SupabaseOrderClaim, SupabasePedido } from "../supabase/types.ts"

// Regla única de proveedor efectivo en TS (isLocalDeliveryOrder: shipping_provider
// manda; sin él, el fallback legacy envio_proveedor): los campos Andreani sólo
// son evidencia logística si el pedido NO es Envío BEYONIX. Misma regla que
// order_dispatch_cutoff_reached / dispatch_order_block_reasons en la base (migración C).

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
const RESIDUE = {
  andreani_handed_over_at: "2026-11-01T09:00:00Z", andreani_envio_id: "ENV-RES", andreani_creation_status: "created",
  andreani_tracking: "360000009999", andreani_estado: "Entregado", tracking_number: "TRK-RES",
}
const local = { shipping_provider: "beyonix", ...RESIDUE }
const modern = { shipping_provider: "andreani", ...RESIDUE }
const legacy = { shipping_provider: null, envio_proveedor: null, ...RESIDUE }

test("corte y entrega: BEYONIX sólo por su estado; Andreani moderno y legacy sin cambios", () => {
  assert.equal(isOrderDispatchCutoffReached({ ...local, estado: "pagado", andreani_estado: "En transito" }), false)
  assert.equal(isOrderDispatchCutoffReached({ ...local, estado: "en_camino" }), true)
  for (const order of [modern, legacy]) assert.equal(isOrderDispatchCutoffReached({ ...order, estado: "pagado" }, true), true)
  assert.equal(isOrderDeliveryReached({ ...local, estado: "pagado" }), false, "andreani_estado 'Entregado' residual")
  assert.equal(isOrderDeliveryReached({ ...local, estado: "entregado" }), true)
  assert.equal(isOrderDeliveryReached({ ...local, estado: "en_camino", delivered_at: "2026-11-03T10:00:00Z" } as never), true)
  for (const order of [modern, legacy]) assert.equal(isOrderDeliveryReached({ ...order, estado: "en_camino" }), true)
  assert.equal(andreaniHandedOverAt(local), null)
  assert.equal(andreaniHandedOverAt(modern), RESIDUE.andreani_handed_over_at)
  assert.equal(andreaniHandedOverAt(legacy), RESIDUE.andreani_handed_over_at)
})

test("Admin: un BEYONIX Preparando con residuos no figura Despachado ni Listo; Andreani sí", () => {
  const facts = { admin_pending_facts: { dispatch: { packageStatus: null } } }
  assert.equal(getAdminDispatchStatus({ ...local, ...facts, estado: "pagado" }).key, "not_shipped")
  assert.equal(getAdminShippingStage({ ...local, ...facts, estado: "pagado" }, true), "preparing")
  assert.equal(getAdminDispatchStatus({ ...modern, ...facts, estado: "pagado" }).label, "Despachado")
  assert.equal(getAdminDispatchStatus({ ...legacy, ...facts, estado: "pagado" }).label, "Despachado")
})

test("cancelación Admin (journey): el QR final residual de un BEYONIX no exige devolución por transportista", () => {
  const cancelled = (order: Record<string, unknown>): CancellationJourneyOrder => ({
    id: 32, estado: "cancelado", financial_status: "refund_pending", payment_method_id: "mercadopago", payment_status: "approved",
    paid_at: "2026-10-22T10:00:00Z", payment_confirmed_amount: 899, total: 899, invoice_status: "authorized", invoice_cae: "CAE-1",
    credit_note_required: true, order_credit_notes: [], mercadopago_order_refunds: [], cancelled_at: "2026-10-22T11:00:00Z",
    admin_pending_facts: { financial: { mode: "wizard", resolutionStatus: null, hasOptions: true }, dispatch: null }, ...order,
  }) as CancellationJourneyOrder
  const merchandise = (order: Record<string, unknown>) => getCancellationJourney(cancelled(order))!.steps[1].detail
  assert.doesNotMatch(merchandise(local), /transportista/)
  assert.match(merchandise(modern), /se entregó al transportista/)
})

test("reclamos Admin: el envío original BEYONIX no muestra datos Andreani residuales; la logística inversa real sí", () => {
  const order = { id: 9, created_at: "2026-10-01T10:00:00Z", estado: "entregado", delivered_at: "2026-10-03T10:00:00Z", ...local } as unknown as SupabasePedido
  const claim = { order_claim_shipments: [{ id: 41, direction: "devolucion", attempt: 1, status: "entregada", andreani_envio_id: "DEVOLUCION",
    andreani_tracking: "TRACK-DEVOLUCION", delivered_at: "2026-10-08T10:00:00Z", environment: "QA", creation_status: "created", closed_at: "2026-10-08T10:00:00Z" }] } as SupabaseOrderClaim
  const [original, reverse] = buildClaimShipmentTrace(order, claim)
  assert.deepEqual([original.title, original.number, original.tracking, original.status, original.environment],
    ["Envío original (Envío BEYONIX)", null, null, "Entregado", null])
  assert.deepEqual([reverse.number, reverse.tracking], ["DEVOLUCION", "TRACK-DEVOLUCION"], "devolución por Andreani intacta")
  const [andreaniOriginal] = buildClaimShipmentTrace({ ...order, ...modern } as unknown as SupabasePedido, claim)
  assert.deepEqual([andreaniOriginal.number, andreaniOriginal.tracking], ["ENV-RES", "360000009999"])
})

test("contratos: cancelación cliente, automática, reintegros y reclamos leen el proveedor y usan la regla canónica", () => {
  const cancel = source("app/api/orders/[id]/cancel/route.ts")
  assert.match(cancel, /andreani_handed_over_at, shipping_provider, envio_proveedor, delivered_at/)
  assert.match(cancel, /return isOrderDeliveryReached\(order\)/)
  const automatic = source("lib/orders/automatic-cancellation.ts")
  assert.match(automatic, /tracking_number,andreani_tracking,shipping_provider,envio_proveedor,auto_cancellation_attempts/)
  assert.match(automatic, /return hasAndreaniShippingEvidenceScope\(order\) &&/)
  const financial = source("lib/orders/financial-resolution-server.ts")
  assert.match(financial, /andreani_estado,shipping_provider,envio_proveedor,estado/)
  assert.match(financial, /const handedOverAt = andreaniHandedOverAt\(order\)/)
  assert.doesNotMatch(financial, /order\.andreani_handed_over_at[^,;]*\)/, "ningún otro uso directo del QR final")
  assert.match(source("components/claims/admin-claim-manager.tsx"), /return isOrderDeliveryReached\(order\)/)
  const customerClaim = source("components/claims/customer-claim-experience.tsx")
  assert.match(customerClaim, /hasAndreaniShippingEvidenceScope\(order\) && \(order\.tracking_number \|\| order\.andreani_tracking\)/)
  assert.match(customerClaim, /return isOrderDispatchCutoffReached\(order\)/)
})
