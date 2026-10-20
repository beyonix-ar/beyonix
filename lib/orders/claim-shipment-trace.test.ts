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

test("estado forzado del reenvío: sólo hacia adelante, cancelar sólo en Creado, real vs operativo", async () => {
  const { getClaimForceOptions, getClaimForceEffects } = await import("./claim-shipment-trace.ts")
  const base = { direction: "reemplazo", creation_status: "created", closed_at: null, review_required: false } as const
  assert.deepEqual(getClaimForceOptions({ ...base, status: "generada" }), ["en_transito", "en_sucursal", "entregada", "cancelada"])
  assert.deepEqual(getClaimForceOptions({ ...base, status: "en_transito" }), ["en_sucursal", "entregada"])
  assert.deepEqual(getClaimForceOptions({ ...base, status: "entregada" }), [])
  assert.deepEqual(getClaimForceOptions({ ...base, status: "en_transito", review_required: true }), [], "revisión abierta")
  assert.deepEqual(getClaimForceOptions({ ...base, direction: "devolucion", status: "generada" }), [], "sólo el reenvío")
  assert.deepEqual(getClaimForceOptions({ ...base, creation_status: "processing", status: "pendiente" }), [])
  assert.match(getClaimForceEffects("entregada").join(" "), /No se puede deshacer/)
  assert.match(getClaimForceEffects("cancelada").join(" "), /No cancela nada en Andreani/)

  const order = { id: 9, created_at: "2026-10-01T10:00:00Z" } as SupabasePedido
  const claim = { order_claim_shipments: [
    { id: 41, direction: "reemplazo", attempt: 1, status: "entregada", creation_status: "created", environment: "PROD",
      andreani_tracking: "360000000041", andreani_estado: "En distribución", delivered_at: "2026-10-05T10:00:00Z",
      manual_status_override: "entregada", manual_status_override_kind: "admin_override", manual_status_override_note: "El cliente confirmó la entrega" },
  ] } as SupabaseOrderClaim
  const [, row] = buildClaimShipmentTrace(order, claim)
  assert.deepEqual([row.override, row.simulated, row.status, row.realStatus, row.overrideNote],
    ["forced", false, "Entregado", "En distribución", "El cliente confirmó la entrega"])
  assert.deepEqual(buildClaimJourney(order, claim).map((event) => event.label), ["Reemplazo entregado al cliente (forzado por BEYONIX)"])
})
