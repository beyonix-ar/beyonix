import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  ADMIN_EXECUTIVE_STATUS,
  getAdminDispatchStatus,
  getAdminExecutiveStatusFromEstado,
} from "./admin-order-status-presentation.ts"

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

const adminPedidos = readSource("../../app/admin/sections/pedidos/admin-pedidos.tsx")
const globalsCss = readSource("../../app/globals.css")

function sliceFunction(source: string, signature: string) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `no se encontró ${signature}`)
  const end = source.indexOf("\n}\n", start)
  return source.slice(start, end + 2)
}

// ---------- DESPACHO ----------

test("DESPACHO: un pedido cancelado antes de salir muestra 'No enviado', nunca 'Cancelado'", () => {
  for (const order of [
    { estado: "cancelado" },
    { estado: "cancelado", andreani_envio_id: "ENV-1", andreani_creation_status: "created" },
  ]) {
    const dispatch = getAdminDispatchStatus(order, { awaitingDispatch: true })
    assert.equal(dispatch.key, "not_shipped")
    assert.equal(dispatch.label, "No enviado")
    assert.equal(dispatch.tone, "neutral")
  }
})

test("DESPACHO: todavía no salió -> 'No enviado' (ámbar sólo si ya está pago y espera despacho)", () => {
  assert.deepEqual(getAdminDispatchStatus({ estado: "pendiente" }), {
    key: "not_shipped",
    label: "No enviado",
    tone: "neutral",
  })
  assert.equal(getAdminDispatchStatus({ estado: "pagado" }, { awaitingDispatch: true }).tone, "warning")
  assert.equal(getAdminDispatchStatus({ estado: "pagado" }).tone, "neutral")
})

test("DESPACHO: preparación, salida, tránsito y entrega", () => {
  assert.deepEqual(getAdminDispatchStatus({ estado: "preparado" }), {
    key: "preparing",
    label: "En preparación",
    tone: "info",
  })
  // Envío Andreani ya creado/en curso sin despachar todavía.
  assert.equal(getAdminDispatchStatus({ estado: "pagado", andreani_envio_id: "ENV-9" }).key, "preparing")
  assert.equal(getAdminDispatchStatus({ estado: "pagado", andreani_creation_status: "claimed" }).key, "preparing")
  assert.equal(getAdminDispatchStatus({ estado: "pagado", andreani_creation_status: "failed" }).key, "not_shipped")
  assert.deepEqual(getAdminDispatchStatus({ estado: "enviado" }), { key: "shipped", label: "Enviado", tone: "info" })
  assert.equal(getAdminDispatchStatus({ estado: "en_camino" }).label, "En camino")
  assert.deepEqual(getAdminDispatchStatus({ estado: "entregado" }), {
    key: "delivered",
    label: "Entregado",
    tone: "success",
  })
  // delivered_at manda aunque el estado haya cambiado después (p. ej. cancelado tras la entrega).
  assert.equal(getAdminDispatchStatus({ estado: "cancelado", delivered_at: "2026-09-01T10:00:00Z" }).key, "delivered")
})

test("DESPACHO: incidencias logísticas con su propio tono", () => {
  assert.equal(getAdminDispatchStatus({ estado: "visita_fallida" }).tone, "warning")
  assert.equal(getAdminDispatchStatus({ estado: "retiro_vencido" }).tone, "warning")
  assert.equal(getAdminDispatchStatus({ estado: "en_devolucion" }).tone, "warning")
  assert.equal(getAdminDispatchStatus({ estado: "en_sucursal" }).tone, "info")
  assert.equal(getAdminDispatchStatus({ estado: "retiro_pendiente" }).tone, "info")
  assert.equal(getAdminDispatchStatus({ estado: "devuelto_beyonix" }).label, "Devuelto a BEYONIX")
})

test("DESPACHO: ninguna etiqueta logística repite el estado general del pedido", () => {
  const estados = [
    "pendiente", "pagado", "preparado", "enviado", "en_camino", "visita_fallida", "en_sucursal",
    "retiro_pendiente", "retiro_vencido", "en_devolucion", "devuelto_beyonix", "entregado", "cancelado", "rechazado",
  ]
  for (const estado of estados) {
    const { label } = getAdminDispatchStatus({ estado }, { awaitingDispatch: true })
    assert.doesNotMatch(label, /cancel|rechaz|pendiente de pago|pago/i, estado)
  }

  const dispatchAlert = sliceFunction(adminPedidos, "function getDispatchAlert(")
  assert.match(dispatchAlert, /getAdminDispatchStatus\(pedido,/)
  assert.doesNotMatch(dispatchAlert, /"Cancelado"/)
  assert.doesNotMatch(dispatchAlert, /"Pendiente"/)
})

test("DESPACHO: el badge conserva su tono (sin rounded-full/border que dispare el catch-all)", () => {
  const badges = [...adminPedidos.matchAll(/admin-order-dispatch-badge inline-flex[^"`]*/g)].map((match) => match[0])
  assert.equal(badges.length, 3)
  for (const badge of badges) assert.doesNotMatch(badge, /rounded-full|\bborder\b/, badge)
  assert.match(globalsCss, /\n\.admin-order-dispatch-badge \{\n  border: 1px solid transparent;\n  border-radius: 9999px;\n\}/)
  // La card del listado es oscura también en Light: sus tonos oscuros ganan
  // sobre la variante Light genérica del badge de despacho.
  for (const tone of ["danger", "success", "warning", "info", "muted"]) {
    const listRow = globalsCss.indexOf(
      `html[data-admin-theme="light"] .beyonix-admin-main .admin-orders-list-row .admin-order-tone-${tone} {`,
    )
    const generic = globalsCss.indexOf(
      `html[data-admin-theme="light"] .beyonix-admin-main .admin-order-dispatch-badge.admin-order-tone-${tone},`,
    )
    assert.ok(listRow > generic && generic > 0, tone)
  }
})

// ---------- RESUMEN ----------

test("RESUMEN: cancelado rojo, entregado y pago confirmado verde", () => {
  assert.deepEqual(getAdminExecutiveStatusFromEstado("cancelado"), { label: "Cancelado", tone: "danger" })
  assert.equal(ADMIN_EXECUTIVE_STATUS.cancelled_refunded.tone, "danger")
  assert.equal(ADMIN_EXECUTIVE_STATUS.cancelled_refund_pending.tone, "danger")
  assert.deepEqual(getAdminExecutiveStatusFromEstado("entregado"), { label: "Entregado", tone: "success" })
  // "pagado" es lo que devuelve getDisplayedOrderStatus para una transferencia confirmada.
  assert.deepEqual(getAdminExecutiveStatusFromEstado("pagado"), { label: "Pago confirmado", tone: "success" })
  assert.equal(ADMIN_EXECUTIVE_STATUS.payment_confirmed.tone, "success")
})

test("RESUMEN: reclamos e incidencias en rojo o ámbar según severidad", () => {
  assert.equal(ADMIN_EXECUTIVE_STATUS.claim_open.tone, "danger")
  assert.equal(ADMIN_EXECUTIVE_STATUS.cancellation_requested.tone, "danger")
  assert.equal(ADMIN_EXECUTIVE_STATUS.refund_pending.tone, "danger")
  assert.equal(ADMIN_EXECUTIVE_STATUS.payment_rejected.tone, "danger")
  assert.equal(ADMIN_EXECUTIVE_STATUS.help_message.tone, "warning")
  assert.equal(getAdminExecutiveStatusFromEstado("visita_fallida").tone, "warning")
  assert.equal(getAdminExecutiveStatusFromEstado("en_devolucion").tone, "warning")
})

test("RESUMEN: pendientes en ámbar, en curso en azul, sin guiones bajos crudos", () => {
  assert.deepEqual(getAdminExecutiveStatusFromEstado("pendiente"), { label: "Pendiente de pago", tone: "warning" })
  assert.equal(ADMIN_EXECUTIVE_STATUS.invoice_pending.tone, "warning")
  assert.equal(ADMIN_EXECUTIVE_STATUS.shipping_pending.tone, "warning")
  assert.equal(ADMIN_EXECUTIVE_STATUS.credit_note_missing.tone, "warning")
  assert.deepEqual(getAdminExecutiveStatusFromEstado("en_camino"), { label: "En camino", tone: "info" })
  assert.deepEqual(getAdminExecutiveStatusFromEstado("estado_nuevo_raro"), {
    label: "Estado nuevo raro",
    tone: "neutral",
  })
  for (const estado of ["preparado", "enviado", "en_sucursal", "retiro_pendiente", "retiro_vencido", "devuelto_beyonix"]) {
    assert.doesNotMatch(getAdminExecutiveStatusFromEstado(estado).label, /_/, estado)
  }
})

test("RESUMEN: el badge usa el tono del helper (sin heurística por texto)", () => {
  const executive = sliceFunction(adminPedidos, "function getExecutiveOrderStatus(")
  assert.match(executive, /: AdminOrderStatusPresentation \{/)
  assert.match(executive, /return getAdminExecutiveStatusFromEstado\(getDisplayedOrderStatus\(pedido\)\)/)
  // Sin rounded-full/border: el catch-all de badges del admin
  // (span[class*="rounded-full"][class*="border"]) pisaba el tono.
  assert.match(
    adminPedidos,
    /className=\{`admin-order-status-badge admin-order-status-badge-\$\{mainStatus\.tone\} px-2\.5 py-0\.5 text-10px/,
  )
  assert.match(globalsCss, /\.admin-order-detail-scope \.admin-order-status-badge \{\n  display: inline-flex;[\s\S]*?border-radius: 9999px;/)
  assert.match(adminPedidos, /\{mainStatus\.label\}/)
  assert.doesNotMatch(adminPedidos, /isAdminSensitiveStatus\(mainStatus\)/)

  for (const tone of ["danger", "success", "warning", "info", "neutral"]) {
    assert.match(globalsCss, new RegExp(`\\.admin-order-detail-scope \\.admin-order-status-badge-${tone} \\{`), tone)
    assert.match(
      globalsCss,
      new RegExp(`html\\[data-admin-theme="light"\\] \\.admin-order-detail-scope \\.admin-order-status-badge-${tone} \\{`),
      `light ${tone}`,
    )
  }
})

// ---------- MODAL RECHAZAR PEDIDO ----------

function relativeLuminance(hex: string) {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)!
    .map((part) => {
      const value = parseInt(part, 16) / 255
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(foreground: string, background: string) {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

function cssRule(selectorSuffix: string) {
  const selector = `:is(html, html[data-admin-theme="light"]) ${selectorSuffix} {`
  const start = globalsCss.indexOf(selector)
  assert.ok(start >= 0, `falta la regla ${selectorSuffix}`)
  return globalsCss.slice(start, globalsCss.indexOf("}", start))
}

function cssColor(rule: string, property: string) {
  const match = rule.match(new RegExp(`\\n\\s*${property}: (#[0-9a-f]{6}) !important;`, "i"))
  assert.ok(match, `sin ${property} hex en ${rule.slice(0, 80)}`)
  return match[1]
}

test("modal Rechazar pedido: textos y botón destructivo con contraste AA en ambos temas", () => {
  const modalBg = cssColor(cssRule(".admin-cancel-reject-modal"), "background")
  const headerDarkest = "#3b1218"
  const title = cssColor(cssRule(".admin-cancel-reject-modal .admin-cancel-reject-modal__title"), "color")
  const subtitle = cssColor(cssRule(".admin-cancel-reject-modal .admin-cancel-reject-modal__subtitle"), "color")
  const label = cssColor(cssRule(".admin-cancel-reject-modal .admin-cancel-reject-modal__label"), "color")
  const alert = cssColor(cssRule(".admin-cancel-reject-modal .admin-cancel-reject-modal__alert"), "color")
  const back = cssColor(cssRule(".admin-cancel-reject-modal .admin-cancel-reject-modal__back"), "color")
  const confirmRule = cssRule(".admin-cancel-reject-modal .admin-cancel-reject-modal__confirm")
  const confirmHover = cssRule(".admin-cancel-reject-modal .admin-cancel-reject-modal__confirm:not(:disabled):hover")

  assert.ok(contrastRatio(title, headerDarkest) >= 7)
  assert.ok(contrastRatio(subtitle, headerDarkest) >= 7)
  assert.ok(contrastRatio(label, modalBg) >= 7)
  assert.ok(contrastRatio(alert, modalBg) >= 7)
  assert.ok(contrastRatio(back, modalBg) >= 7)
  assert.ok(contrastRatio(cssColor(confirmRule, "color"), cssColor(confirmRule, "background-color")) >= 4.5)
  assert.ok(contrastRatio("#ffffff", cssColor(confirmHover, "background-color")) >= 4.5)
  // Rojo sólido real, no un rojo translúcido "lavado".
  assert.equal(cssColor(confirmRule, "background-color"), "#dc2626")

  // Sin las utilidades que el catch-all de Light reescribe.
  const modal = sliceFunction(adminPedidos, "function AdminOrderCancelRejectModal(")
  assert.doesNotMatch(modal, /text-white\/\d+|text-red-100|text-amber-100|bg-red-500\/15|bg-\[#101010\]/)
  assert.match(modal, /admin-cancel-reject-modal__confirm/)
  assert.match(modal, /admin-cancel-reject-modal__back/)
  // Sin rounded-*+border en el contenedor ni en la advertencia: el catch-all
  // de superficies del admin (div[class*="rounded"][class*="border"]) les
  // ponía fondo blanco en Light y la advertencia ámbar quedaba invisible.
  assert.match(modal, /className="admin-cancel-reject-modal w-full max-w-md overflow-hidden shadow-2xl shadow-black\/80"/)
  assert.match(modal, /className="admin-cancel-reject-modal__alert p-3 text-xs font-semibold leading-5"/)
  assert.match(cssRule(".admin-cancel-reject-modal .admin-cancel-reject-modal__alert"), /border-radius: 1rem !important;/)
  assert.doesNotMatch(globalsCss, /\.admin-cancel-reject-modal \.text-white\\\/48/)
})

test("modal Rechazar pedido: select compacto y contenido dentro del modal", () => {
  const modal = sliceFunction(adminPedidos, "function AdminOrderCancelRejectModal(")
  assert.match(modal, /admin-cancel-reject-modal__reason max-w-\[18rem\]/)
  assert.match(modal, /triggerClassName="admin-cancel-reject-modal__select"/)
  assert.match(modal, /menuClassName="admin-cancel-reject-modal__menu"/)
  const menuRule = cssRule(".admin-cancel-reject-modal__menu.admin-ds-select-menu")
  const option = cssRule(".admin-cancel-reject-modal__menu :is(.admin-ds-select-option, .admin-ds-select-option-selected)")
  assert.ok(contrastRatio(cssColor(option, "color"), cssColor(menuRule, "background-color")) >= 7)

  // El menú del AdminSelect se porta dentro del diálogo y copia el ancho del trigger.
  const controls = readSource("../../app/admin/components/admin-controls.tsx")
  assert.match(controls, /wrapperRef\.current\?\.closest\('\[role="dialog"\]'\) \?\? document\.body/)
})
