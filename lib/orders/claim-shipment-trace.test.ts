import assert from "node:assert/strict"
import test from "node:test"
import { claimShipmentTestStatusEnabled } from "../andreani/claim-test-status.ts"
import { buildClaimJourney, buildClaimShipmentTrace } from "./claim-shipment-trace.ts"
import type { SupabaseOrderClaim, SupabasePedido } from "../supabase/types.ts"

test("trazabilidad conserva el envío original, la devolución y el reenvío con identidad propia", () => {
  const order = { id: 8, created_at: "2026-10-01T10:00:00Z", andreani_envio_id: "ORIGINAL",
    andreani_tracking: "TRACK-ORIGINAL", andreani_estado: "Entregado", delivered_at: "2026-10-03T10:00:00Z" } as SupabasePedido
  const claim = { order_claim_shipments: [
    { id: 32, direction: "reemplazo", attempt: 1, status: "entregada", andreani_envio_id: "REEMPLAZO",
      andreani_tracking: "TRACK-REEMPLAZO", delivered_at: "2026-10-12T10:00:00Z", environment: "QA", creation_status: "created", closed_at: "2026-10-12T10:00:00Z" },
    { id: 31, direction: "devolucion", attempt: 1, status: "entregada", andreani_envio_id: "DEVOLUCION",
      andreani_tracking: "TRACK-DEVOLUCION", delivered_at: "2026-10-08T10:00:00Z", environment: "QA", creation_status: "created", closed_at: "2026-10-08T10:00:00Z" },
  ] } as SupabaseOrderClaim
  const rows = buildClaimShipmentTrace(order, claim)
  assert.deepEqual(rows.map((row) => [row.title, row.number, row.tracking]), [
    ["Envío original", "ORIGINAL", "TRACK-ORIGINAL"],
    ["Devolución", "DEVOLUCION", "TRACK-DEVOLUCION"],
    ["Reemplazo / reenvío", "REEMPLAZO", "TRACK-REEMPLAZO"],
  ])
  assert.equal(rows[1].date, "2026-10-08T10:00:00Z")
  assert.equal(rows[2].status, "Entregado")
  assert.equal(rows[1].canSimulate, false)
  assert.equal(rows[2].canSimulate, false)
  assert.deepEqual(buildClaimJourney(order, { ...claim, created_at: "2026-10-04T10:00:00Z" }).map((event) => event.label), [
    "Pedido entregado", "Reclamo abierto", "Devolución entregada a BEYONIX", "Reemplazo entregado al cliente",
  ])
})

test("override sólo se expone en desarrollo QA o con flag explícita en producción QA", () => {
  assert.equal(claimShipmentTestStatusEnabled({ NODE_ENV: "development", ANDREANI_SHIPMENT_ENV: "QA" }), true)
  assert.equal(claimShipmentTestStatusEnabled({ NODE_ENV: "production", ANDREANI_SHIPMENT_ENV: "QA" }), false)
  assert.equal(claimShipmentTestStatusEnabled({ NODE_ENV: "production", ANDREANI_SHIPMENT_ENV: "QA", CLAIM_SHIPMENT_TEST_OVERRIDE_ENABLED: "true" }), true)
  assert.equal(claimShipmentTestStatusEnabled({ NODE_ENV: "production", ANDREANI_SHIPMENT_ENV: "PROD", CLAIM_SHIPMENT_TEST_OVERRIDE_ENABLED: "true" }), false)
})
