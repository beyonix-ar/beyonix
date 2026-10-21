import assert from "node:assert/strict"
import test from "node:test"

import {
  getCustomerClaimConversation,
  getCustomerClaimHistory,
  getCustomerClaimMilestone,
  getCustomerClaimNotificationCta,
  getCustomerClaimSummary,
  type CustomerClaimSource,
} from "./customer-claim-experience.ts"

// Experiencia del cliente en un reclamo formal: un solo estado arriba, el
// historial aparte y en el chat sólo lo que escribió una persona.

const leg = (direction: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id: 1, direction, status, ...extra }) as never
const claim = (overrides: Partial<CustomerClaimSource> = {}): CustomerClaimSource => ({
  status: "aprobado",
  resolution: "cambio_producto",
  created_at: "2026-10-18T10:00:00Z",
  ...overrides,
})
const message = (id: number, author_role: string, text: string, system_key: string | null = null, minute = id) => ({
  id, author_role, message: text, system_key, created_at: `2026-10-19T10:${String(minute).padStart(2, "0")}:00Z`,
})

test("estado: una frase clara por momento del reclamo", () => {
  const title = (overrides: Partial<CustomerClaimSource>) => getCustomerClaimSummary(claim(overrides)).title
  assert.equal(title({ status: "recibido", resolution: null }), "Estamos revisando tu reclamo")
  assert.equal(title({ status: "falta_informacion" }), "Necesitamos tu respuesta")
  assert.equal(title({ order_claim_shipments: [leg("devolucion", "pendiente")] }), "Estamos preparando tu devolución")
  assert.equal(title({ order_claim_shipments: [leg("devolucion", "en_transito")] }), "Tu producto está en camino a BEYONIX")
  assert.equal(title({ order_claim_shipments: [leg("reemplazo", "pendiente")] }), "Estamos preparando tu reemplazo")
  assert.equal(title({ order_claim_shipments: [leg("reemplazo", "en_transito")] }), "Tu reemplazo está en camino")
  assert.equal(title({ order_claim_shipments: [leg("reemplazo", "en_sucursal")] }), "Retirá tu reemplazo en Andreani")
  assert.equal(title({ order_claim_shipments: [leg("reemplazo", "entregada", { closed_at: "x" })] }), "Tu reemplazo fue entregado")
  assert.equal(title({ order_claim_shipments: [leg("cambio", "en_sucursal")] }), "Andá a la sucursal a hacer el cambio")
  assert.equal(title({ order_claim_shipments: [leg("cambio", "en_sucursal", { exchange_outcome: "no_completado" })] }), "El cambio no se completó")
  assert.equal(title({ status: "reintegro_pendiente", resolution: "reintegro_total" }), "Necesitamos tus datos para el reintegro")
  assert.equal(title({ status: "reintegro_pendiente", resolution: "reintegro_total", refund_details_submitted_at: "x" }), "Estamos preparando tu reintegro")
  assert.equal(title({ status: "cupon_pendiente", resolution: "saldo_a_favor" }), "Estamos preparando tu saldo a favor")

  const received = getCustomerClaimSummary(claim({ order_claim_shipments: [leg("devolucion", "entregada", { closed_at: "x" })] }))
  assert.deepEqual([received.title, received.lines], ["Recibimos tu producto", ["Estamos preparando el reemplazo."]])
})

test("reclamo mixto conserva el seguimiento físico del reemplazo y la devolución", () => {
  const mixed = claim({
    resolution: "mixta",
    order_claim_item_resolutions: [
      { order_item_id: 1, solution: "replacement", quantity: 1, return_quantity: 1 },
      { order_item_id: 2, solution: "refund", quantity: 1, return_quantity: 1 },
    ],
  })
  assert.equal(getCustomerClaimSummary({ ...mixed, order_claim_shipments: [leg("devolucion", "generada")] }).title,
    "Llevá el producto a Andreani")
  assert.equal(getCustomerClaimSummary({ ...mixed, order_claim_shipments: [leg("reemplazo", "en_sucursal")] }).title,
    "Retirá tu reemplazo en Andreani")
})

test("acción: llevar el producto a Andreani con etiqueta y seguimiento; la sucursal sólo cuando hay que ir a una", () => {
  const dropoff = getCustomerClaimSummary(claim({
    order_claim_shipments: [leg("devolucion", "generada", { andreani_tracking: " 360003134242400 ", branch_name: "Sucursal Once" })],
  }))
  assert.deepEqual([dropoff.tone, dropoff.title, dropoff.returnLabel, dropoff.tracking, dropoff.branch],
    ["action", "Llevá el producto a Andreani", true, "360003134242400", null])

  const pickup = getCustomerClaimSummary(claim({
    order_claim_shipments: [leg("reemplazo", "en_sucursal", { branch_name: "ROSARIO", branch_address: "Av. Eva Perón 6243" })],
  }))
  assert.deepEqual([pickup.tone, pickup.branch, pickup.returnLabel], ["action", "ROSARIO · Av. Eva Perón 6243", false])
})

test("terminado: 'Reclamo resuelto' con la solución en palabras simples", () => {
  const replacement = getCustomerClaimSummary(claim({
    status: "cerrado",
    closed_at: "2026-10-20T10:00:00Z",
    resolution_summary: { kind: "cambio_producto", label: "Reemplazo del producto", detail: "Se registró el reemplazo correspondiente.", amount: null, notice: null },
    order_claim_shipments: [leg("reemplazo", "entregada", { closed_at: "x" })],
  }))
  assert.deepEqual([replacement.tone, replacement.title, replacement.lines],
    ["done", "Reclamo resuelto", ["Te enviamos un producto nuevo.", "El reemplazo fue entregado."]])
  assert.doesNotMatch(JSON.stringify(replacement), /Se registró|Resolución/)

  const refund = getCustomerClaimSummary(claim({
    status: "cerrado", resolution: "reintegro_total",
    resolution_summary: { kind: "reintegro_total", label: "Reintegro total", detail: "x", amount: 27900, notice: null },
  }))
  assert.equal(refund.lines[0], "Tu reintegro fue realizado.")
  assert.match(refund.lines[1] ?? "", /^Monto: \$\s?27\.900$/)

  const credit = getCustomerClaimSummary(claim({ status: "cerrado", resolution: "saldo_a_favor" }))
  assert.deepEqual(credit.lines, ["Tu saldo a favor ya está disponible."])

  const rejected = getCustomerClaimSummary(claim({
    status: "rechazado", resolution: "rechazado",
    resolution_summary: { kind: "rechazado", label: "Reclamo no aprobado", detail: "Motivo: Daño por mal uso.", amount: null, notice: null },
  }))
  assert.deepEqual([rejected.tone, rejected.title, rejected.lines], ["rejected", "Tu reclamo no fue aprobado", ["Motivo: Daño por mal uso."]])
})

test("el cliente nunca ve estados forzados, simulaciones ni datos internos", () => {
  const internal = {
    manual_status_override: "entregada", manual_status_override_kind: "admin_override", environment: "QA",
    contract: "400042106", cost_amount: 4500, andreani_estado: "Pendiente de ingreso", creation_error: "HTTP 500",
  }
  const states = ["pendiente", "generada", "en_transito", "en_sucursal", "entregada"].flatMap((status) =>
    ["devolucion", "cambio", "reemplazo"].map((direction) =>
      getCustomerClaimSummary(claim({ order_claim_shipments: [leg(direction, status, internal)] }))))
  assert.doesNotMatch(JSON.stringify(states), /forzad|simula|QA|override|super ?admin|400042|4500|HTTP|Pendiente de ingreso|domicilio/i)
})

test("historial: hitos cumplidos en orden, sin repetir y sin IDs técnicos", () => {
  const history = getCustomerClaimHistory(claim({
    status: "cerrado",
    closed_at: "2026-10-20T23:00:00Z",
    order_claim_messages: [
      message(1, "cliente", "El producto llegó fallado"),
      message(2, "admin", "BEYONIX aceptó el cambio del producto.", "change_accepted"),
      message(3, "admin", "Prepará el producto…", "change_packing_instructions"),
      message(4, "admin", "Generamos la devolución…", "return_generated:2"),
      message(5, "admin", "Andreani informó que llegó.", "return_delivered:2"),
      message(6, "admin", "Recibimos tu producto en BEYONIX.", "original_received"),
      message(7, "admin", "Revisamos tu producto y te enviamos el reemplazo.", "replacement_dispatched:3"),
      message(8, "admin", "Seguimiento Andreani: 360003134242400", "replacement_dispatch_details:3"),
      message(9, "admin", "Registramos la entrega de tu producto de reemplazo.", "replacement_delivered:3"),
    ],
  }))
  assert.deepEqual(history.map((step) => step.label), [
    "Reclamo recibido",
    "Reclamo aprobado",
    "Devolución lista para llevar a Andreani",
    "Producto recibido",
    "Reemplazo enviado",
    "Reemplazo entregado",
    "Reclamo resuelto",
  ])
  assert.ok(history.every((step) => /^\d{2}\/\d{2}\/\d{4}$/.test(step.date ?? "")))
  assert.doesNotMatch(JSON.stringify(history), /360003|:\d|Andreani informó|Registramos/)
  assert.equal(getCustomerClaimMilestone("replacement_dispatch_details:3"), null)
  assert.equal(getCustomerClaimMilestone("clave_desconocida"), null)
})

test("campana: los avisos del reclamo muestran 'Ver reclamo'; los de otros temas no", () => {
  assert.equal(getCustomerClaimNotificationCta("claim_update"), "Ver reclamo")
  assert.equal(getCustomerClaimNotificationCta("claim_resolved"), "Ver reclamo")
  assert.equal(getCustomerClaimNotificationCta("claim_response"), "Ver mensaje")
  assert.equal(getCustomerClaimNotificationCta("order_refunded"), null)
  assert.equal(getCustomerClaimNotificationCta("customer_credit"), null)
})

test("conversación: los mensajes automáticos no son burbujas; lo escrito por personas sigue visible", () => {
  const messages = [
    message(1, "cliente", "El producto llegó fallado"),
    message(2, "admin", "BEYONIX aceptó el cambio del producto.", "change_accepted"),
    message(3, "super_admin", "¿Nos mandás una foto de la caja?"),
    message(4, "cliente", "Listo, ahí va."),
    message(5, "admin", "Simulación QA: se marcó el producto de reemplazo como entregado al cliente.", "replacement_delivered:3"),
    message(6, "admin", "Registramos la entrega de tu producto de reemplazo.", "replacement_delivered:4"),
  ]
  const open = getCustomerClaimConversation(claim({ order_claim_messages: messages }))
  assert.deepEqual(open.map((row) => [row.fromCustomer, row.message]), [
    [true, "El producto llegó fallado"],
    [false, "¿Nos mandás una foto de la caja?"],
    [true, "Listo, ahí va."],
  ])

  const summary = { kind: "cambio_producto", label: "Reemplazo del producto", detail: "Se registró el reemplazo correspondiente.", amount: null, notice: null }
  const closing = "BEYONIX resolvió el reclamo.\nResolución: Reemplazo del producto.\nSe registró el reemplazo correspondiente."
  const closed = (text: string) => getCustomerClaimConversation(claim({
    status: "cerrado", resolution_summary: summary, order_claim_messages: [message(1, "cliente", "Hola"), message(7, "super_admin", text)],
  })).map((row) => row.message)
  assert.deepEqual(closed(closing), ["Hola"], "el cierre automático ya está en el estado")
  assert.deepEqual(closed(`${closing}\n\nGracias por tu paciencia.`), ["Hola", "Gracias por tu paciencia."], "queda el texto escrito a mano")
  assert.deepEqual(getCustomerClaimConversation(claim({
    status: "cerrado", order_claim_messages: [message(1, "admin", "BEYONIX finalizó el reclamo.")],
  })), [])
})
