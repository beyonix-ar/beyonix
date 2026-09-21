import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { AdminModal } from "../../app/admin/components/admin-controls"
import { getAdminCapabilities, hasAdminCapability } from "./admin-capabilities"
import { AdminRequestError, describeAdminLoadError } from "./request-error"
import { buildReturnReviewRequest } from "../mercadolibre/return-review-client"
import { canConfirmDestructiveOperation, type DestructiveImpact } from "./destructive-operations"
import { keepDistinctOperationalTasks } from "./admin-notification-rules"
import { humanizeBillingError } from "./billing-errors"

test("ML: primera revisión envía null; corrección envía versión y motivo", () => {
  const payload = { receivedQuantity: 2, sellableQuantity: 1, discountedQuantity: 0, nonSellableQuantity: 1, discountPercent: null, discountReason: "", nonSellableReason: "Roto", notes: "", expectedApprovedAt: null }
  const first = buildReturnReviewRequest("venta/1", payload)
  assert.equal(first.path, "/api/admin/mercadolibre-sales/venta%2F1/return-review")
  assert.equal(JSON.parse(first.init.body).expectedApprovedAt, null)
  const corrected = buildReturnReviewRequest("1", { ...payload, expectedApprovedAt: "2026-09-20T12:00:00Z", correctionReason: " Revisado nuevamente " })
  assert.equal(JSON.parse(corrected.init.body).expectedApprovedAt, "2026-09-20T12:00:00Z")
  assert.equal(JSON.parse(corrected.init.body).correctionReason, "Revisado nuevamente")
  assert.throws(() => buildReturnReviewRequest("1", { ...payload, expectedApprovedAt: "2026-09-20T12:00:00Z" }), /motivo/)
})

test("capacidades: operador no puede gestionar dinero, catálogo, stock ni reemplazos", () => {
  const operator = getAdminCapabilities("operador")
  assert.equal(operator.canViewAdmin, true)
  for (const [key, value] of Object.entries(operator)) if (key !== "canViewAdmin") assert.equal(value, false, key)
  assert.equal(getAdminCapabilities("admin").canManageReplacements, true)
  assert.equal(getAdminCapabilities("admin").canForceDelete, false)
  assert.equal(getAdminCapabilities("super_admin").canForceDelete, true)
  assert.equal(hasAdminCapability("toString", "force_delete"), false)
})

test("pedido: sólo un 404 real muestra no encontrado; red/permisos/timeout no", () => {
  assert.match(describeAdminLoadError(new AdminRequestError(404, "")), /No encontramos/)
  assert.match(describeAdminLoadError(new AdminRequestError(403, "")), /permisos/)
  assert.match(describeAdminLoadError(new DOMException("", "TimeoutError")), /demoró/)
  assert.doesNotMatch(describeAdminLoadError(new TypeError("fetch failed")), /No encontramos/)
})

test("cierre operativo: tareas independientes coexisten y ARCA incierto no permite reemitir a ciegas", () => {
  const common = { orderId: 123, eventAt: "2026-09-20T12:00:00Z", isRead: false, title: "Pendiente", body: "Revisar" }
  const tasks = keepDistinctOperationalTasks([
    { ...common, id: "invoice:123", eventKey: "invoice:123", type: "invoice", actionUrl: "/admin/pedidos/123?tab=facturacion" },
    { ...common, id: "claim:1", eventKey: "claim:1", type: "claim", actionUrl: "/admin/pedidos/123?tab=reclamos" },
    { ...common, id: "claim:2", eventKey: "claim:2", type: "claim", actionUrl: "/admin/pedidos/123?tab=reclamos" },
  ])
  assert.equal(tasks.length, 3)
  for (const task of tasks) assert.match(task.actionUrl, /^\/admin\/pedidos\/123\?tab=/)
  for (const error of ["timeout", "network error", "estado incierto", "processing"]) {
    assert.match(humanizeBillingError(error), /No vuelvas a emitir todavía/)
  }
  assert.match(humanizeBillingError("DNI inválido"), /datos fiscales.*antes de reintentar/)
})

test("force-delete: confirmación exacta, sin permitir request duplicado", () => {
  for (const confirmation of ["ELIMINAR COMPRA 123", "ELIMINAR PRODUCTO SKU-1", "ELIMINAR VARIANTE SKU-2"]) {
    const impact = { confirmation } as DestructiveImpact
    assert.equal(canConfirmDestructiveOperation(impact, confirmation, false), true)
    assert.equal(canConfirmDestructiveOperation(impact, confirmation.toLowerCase(), false), false)
    assert.equal(canConfirmDestructiveOperation(impact, confirmation, true), false)
    assert.equal(canConfirmDestructiveOperation(null, confirmation, false), false)
  }
})

test("AdminModal real: diálogo, foco inicial, Tab, Escape y restauración", async () => {
  const dom = new JSDOM('<!doctype html><html><body><button id="opener">Abrir</button><div id="root"></div></body></html>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const opener = document.getElementById("opener") as HTMLButtonElement
  opener.focus()
  const { createRoot } = await import("react-dom/client")
  const root = createRoot(document.getElementById("root")!)
  let closed = 0
  try {
    await act(async () => root.render(<AdminModal open title="Confirmación" onClose={() => { closed++ }}><input data-autofocus aria-label="Motivo" /><div style={{ display: "none" }}><button>Oculto</button></div><fieldset disabled><button>Deshabilitado</button></fieldset></AdminModal>))
    const dialog = document.querySelector('[role="dialog"]')!
    assert.equal(dialog.getAttribute("aria-modal"), "true")
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Motivo")
    document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    assert.equal(dialog.contains(document.activeElement), true)
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Cerrar", "Tab omite controles ocultos y fieldsets deshabilitados")
    await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    assert.equal(closed, 1)
    await act(async () => root.unmount())
    assert.equal(document.activeElement, opener)
  } finally {
    dom.window.close()
    for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
  }
})
