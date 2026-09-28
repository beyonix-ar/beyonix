import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  CLAIM_RETURN_PACKING_INSTRUCTIONS,
  getAdminClaimShipmentView,
  getCustomerClaimShipmentView,
  isClaimChangeAcceptance,
  pickClaimShipment,
} from "./claim-shipment-view.ts"

// Envíos Andreani del cambio: qué ve el cliente, qué ve Admin, permisos de
// etiquetas y dónde se engancha cada tramo.

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

test("cliente, devolución: cómo devolver, etiqueta sólo si aplica, recepción; nunca datos internos", () => {
  const pickup = getCustomerClaimShipmentView({
    direction: "devolucion", status: "generada", modality: "retiro_domicilio", andreani_tracking: " 360000012345678 ",
    cost_amount: 4500, creation_error: "HTTP 500 interno",
  })
  assert.equal(pickup?.statusLabel, "Retiro/despacho generado")
  assert.equal(pickup?.modalityLabel, "Andreani retira el producto en tu domicilio")
  assert.equal(pickup?.tracking, "360000012345678")
  assert.equal(pickup?.instructions[0], CLAIM_RETURN_PACKING_INSTRUCTIONS)
  assert.deepEqual(pickup?.label, { required: false }, "retiro: etiqueta disponible pero no obligatoria")
  assert.doesNotMatch(JSON.stringify(pickup), /4500|HTTP 500|contrato|\bPROD\b|\bQA\b/i)

  const dropoff = getCustomerClaimShipmentView({ direction: "devolucion", status: "en_transito", modality: "despacho_sucursal", andreani_tracking: "T-2" })
  assert.deepEqual(dropoff?.label, { required: true }, "despacho en sucursal: etiqueta obligatoria")
  assert.match(dropoff?.instructions[1] ?? "", /imprimí la etiqueta/)
  assert.equal(dropoff?.statusLabel, "En tránsito hacia BEYONIX")

  const pending = getCustomerClaimShipmentView({ direction: "devolucion", status: "pendiente" })
  assert.equal(pending?.label, null, "sin orden Andreani no hay botón de etiqueta")
  assert.match(pending?.instructions[1] ?? "", /coordinando/)

  const received = getCustomerClaimShipmentView({ direction: "devolucion", status: "entregada", modality: "despacho_sucursal" })
  assert.equal(received?.statusLabel, "Recibido por BEYONIX")
  assert.equal(received?.label, null)
})

test("cliente, reemplazo: seguimiento y estado hasta la entrega; nunca su etiqueta", () => {
  const sent = getCustomerClaimShipmentView({ direction: "reemplazo", status: "en_transito", modality: "entrega_sucursal", andreani_tracking: "C-1" })
  assert.equal(sent?.title, "Envío del reemplazo")
  assert.equal(sent?.statusLabel, "Reemplazo en camino")
  assert.equal(sent?.modalityLabel, "Retiro en la sucursal Andreani que elegiste en tu compra")
  assert.equal(sent?.tracking, "C-1")
  assert.equal(sent?.label, null)
  const delivered = getCustomerClaimShipmentView({ direction: "reemplazo", status: "entregada", modality: "entrega_domicilio" })
  assert.equal(delivered?.statusLabel, "Reemplazo entregado")
  assert.deepEqual(delivered?.instructions, ["Andreani informó que tu producto de reemplazo fue entregado."])
  assert.equal(getCustomerClaimShipmentView(null), null)
})

test("admin: acciones por estado, etiqueta, entrega, conciliación; costo sólo si Andreani lo informó", () => {
  const pending = getAdminClaimShipmentView({ direction: "devolucion", status: "pendiente", creation_status: "not_started", creation_error: "Falta configurar el contrato" }, "devolucion")
  assert.deepEqual([pending.canCreate, pending.canSync, pending.labelAvailable, pending.error], [true, false, false, "Falta configurar el contrato"])
  assert.equal(pending.costLabel, "No informado por Andreani")

  const manual = getAdminClaimShipmentView({ direction: "reemplazo", status: "pendiente", creation_status: "manual_review", creation_error: "TIMEOUT" }, "reemplazo")
  assert.deepEqual([manual.canCreate, manual.canReconcile, manual.manualReview], [false, true, true], "nunca un segundo intento con resultado incierto")

  const created = getAdminClaimShipmentView({ direction: "reemplazo", status: "en_transito", creation_status: "created", cost_amount: "4500", modality: "entrega_sucursal" }, "reemplazo")
  assert.deepEqual([created.canSync, created.canCreate, created.labelAvailable, created.error], [true, false, true, null])
  assert.match(created.costLabel, /4\.500/)
  assert.match(created.modalityLabel ?? "", /contrato de venta sucursal/)

  const delivered = getAdminClaimShipmentView({ direction: "reemplazo", status: "entregada", creation_status: "created" }, "reemplazo")
  assert.deepEqual([delivered.delivered, delivered.canSync], [true, false])

  const missing = getAdminClaimShipmentView(null, "reemplazo")
  assert.deepEqual([missing.exists, missing.canCreate, missing.statusLabel], [false, true, "Preparando el envío del reemplazo"])
})

test("la devolución se dispara sólo en el guardado que acepta el cambio; embed por tramo", () => {
  assert.equal(isClaimChangeAcceptance({ status: "aprobado", resolution: "cambio_producto" }, { status: "aprobado", resolution: "cambio_producto" }), true)
  assert.equal(isClaimChangeAcceptance({ admin_response: "Hola" } as never, { status: "aprobado", resolution: "cambio_producto" }), false)
  assert.equal(isClaimChangeAcceptance({ status: "aprobado", resolution: "reintegro_total" }, { status: "aprobado", resolution: "reintegro_total" }), false)
  const rows = [{ direction: "devolucion" as const, status: "generada" as const }, { direction: "reemplazo" as const, status: "pendiente" as const }]
  assert.equal(pickClaimShipment(rows, "reemplazo")?.status, "pendiente")
  assert.equal(pickClaimShipment(rows[0], "devolucion")?.status, "generada")
  assert.equal(pickClaimShipment(null, "devolucion"), null)
})

test("etiquetas: cliente sólo la de SU devolución (sesión + dueño + reclamo del pedido); Admin ambas; nunca públicas", () => {
  const customer = read("app/api/orders/[id]/claims/[claimId]/return-label/route.ts")
  assert.match(customer, /await authorizeCustomerClaimOrder\(id\)/)
  assert.match(customer, /\.eq\("id", claimId\)\.eq\("order_id", auth\.order\.id\)/)
  assert.match(customer, /\.eq\("direction", "devolucion"\)/)
  assert.doesNotMatch(customer, /"reemplazo"/, "nunca consulta el tramo del reemplazo")
  assert.match(customer, /"Cache-Control": "private, no-store"/)
  const admin = read("app/api/admin/order-claims/[claimId]/andreani-shipment/route.ts")
  assert.equal(admin.match(/const auth = await requireAdmin\(request\)/g)?.length, 2, "POST y GET exigen Admin")
  assert.match(admin, /"Cache-Control": "private, no-store"/)
  const lib = read("lib/andreani/claim-shipments.ts")
  assert.match(lib, /productionAccess: shipment\.environment === "PROD" \? "shipment-read" : undefined/)
})

test("reemplazo automático: después de registrar el reemplazo (stock ya descontado una vez) y sin volver a tocar stock", () => {
  const route = read("app/api/admin/pedidos/[id]/replacements/route.ts")
  const replacement = route.indexOf('rpc("create_order_replacement"')
  const shipment = route.indexOf("createAndreaniReplacementShipmentForClaim(auth.admin, claimId)")
  assert.ok(replacement > 0 && shipment > replacement)
  const lib = read("lib/andreani/claim-shipments.ts")
  assert.doesNotMatch(lib, /"create_order_replacement"|"process_claim_return_inventory"/, "los envíos nunca llaman a las RPCs de stock")
  const patch = read("app/api/admin/order-claims/[claimId]/route.ts")
  assert.ok(patch.indexOf("if (isClaimChangeAcceptance(patch, claim))") > patch.indexOf('rpc("mutate_admin_order_claim"'))
  assert.match(read("app/api/cron/andreani-sync-tracking/route.ts"), /runClaimShipmentTrackingBatch\(admin\)/)
  assert.match(read("app/api/orders/[id]/claims/route.ts"), /order_claim_shipments\(direction,status,modality,andreani_tracking,delivered_at\)/)
})

test("UI: devolución en Recepción, reemplazo en Ejecución (wizard actual); el cliente ve ambos tramos", () => {
  const manager = read("components/claims/admin-claim-manager.tsx")
  const returnPanel = manager.indexOf('<ClaimAndreaniShipmentPanel claim={claim} direction="devolucion"')
  const reception = manager.indexOf("<ReturnInventoryPanel pedido={pedido} claim={claim}")
  const replacementPanel = manager.indexOf('<ClaimAndreaniShipmentPanel claim={claim} direction="reemplazo"')
  const confirm = manager.indexOf("Confirmar envío o entrega y finalizar")
  assert.ok(returnPanel > 0 && reception > returnPanel)
  assert.ok(replacementPanel > 0 && confirm > replacementPanel)
  const panel = read("components/claims/claim-andreani-shipment-panel.tsx")
  assert.match(panel, /if \(inFlightRef\.current\) return/, "doble click: una sola solicitud en vuelo")
  const customer = read("components/claims/customer-claim-shipments-notice.tsx")
  assert.match(customer, /\/api\/orders\/\$\{claim\.order_id\}\/claims\/\$\{claim\.id\}\/return-label/)
  assert.match(customer, /Descargar etiqueta de devolución/)
  assert.match(read("components/claims/customer-claim-experience.tsx"), /<CustomerClaimShipmentsNotice claim=\{claim\} \/>/)
})
