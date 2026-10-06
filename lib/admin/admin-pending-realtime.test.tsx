import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import type { Root } from "react-dom/client"

type Listener = { table: string; callback: () => void }

async function setup() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://pending-realtime.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "pending-realtime-key"
  // Igual que dispatch-realtime: el cliente se crea antes de exponer window.
  const { supabase } = await import("../supabase/client")
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/pedidos" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "t" } }, error: null }) })
  const listeners: Listener[] = []
  const removed: unknown[] = []
  const channel = {
    on(_event: string, filter: { table: string }, callback: () => void) { listeners.push({ table: filter.table, callback }); return channel },
    subscribe() { return channel },
  }
  Object.defineProperty(supabase, "channel", { configurable: true, value: () => channel })
  Object.defineProperty(supabase, "removeChannel", { configurable: true, value: async (value: unknown) => { removed.push(value) } })
  const { createRoot } = await import("react-dom/client")
  const root: Root = createRoot(dom.window.document.getElementById("root")!)
  return { dom, supabase, listeners, removed, root, channel }
}

test("E/L. el contador baja sin refrescar cuando se resuelve el bloqueo y el canal se limpia al desmontar", async () => {
  const ui = await setup()
  const { usePedidos } = await import("../../hooks/use-pedidos")
  const { getAdminPendingOrderActions } = await import("../orders/admin-pending-actions")
  let blocked = true
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    return Response.json({ total: 1, pedidos: [{
      id: 31, estado: "pagado", financial_status: "payment_confirmed", payment_method_id: "mercadopago",
      payment_status: "approved", paid_at: "2026-10-05T10:00:00Z", total: 1000, invoice_status: "authorized",
      invoice_cae: "1", shipping_provider: "andreani", order_claims: [],
      admin_pending_facts: { financial: null, dispatch: { batchId: 7, batchStatus: "closed", packageStatus: "prepared", blocked } },
    }] })
  }) as typeof fetch
  let labels: string[] = []
  function Probe() {
    const { pedidos } = usePedidos()
    labels = pedidos.flatMap((pedido) => getAdminPendingOrderActions(pedido).map((action) => action.label))
    return <span>{labels.length}</span>
  }
  try {
    await act(async () => { ui.root.render(<Probe />); await new Promise((resolve) => setTimeout(resolve, 20)) })
    assert.deepEqual(labels, ["Retirar del despacho"])
    const dispatchListener = ui.listeners.find((listener) => listener.table === "dispatch_blocks")
    assert.ok(dispatchListener, "el listado escucha los bloqueos de despacho")
    blocked = false
    await act(async () => { dispatchListener.callback(); await new Promise((resolve) => setTimeout(resolve, 260)) })
    // Sin bloqueo la tanda cerrada sólo espera su entrega: es una acción de la tanda, no del pedido.
    assert.deepEqual(labels, [])
    assert.equal(requests, 2)
    await act(async () => ui.root.unmount())
    assert.deepEqual(ui.removed, [ui.channel], "el canal Realtime suscripto se elimina al desmontar")
  } finally {
    ui.supabase.auth.stopAutoRefresh()
    ui.dom.window.close()
  }
})

test("campana: acciones con CTA separadas de la información; la información no se cuenta", async () => {
  const ui = await setup()
  const { AdminNotificationsPopover } = await import("../../components/admin-notifications-popover")
  const action = { id: "a", type: "cancellation" as const, eventKey: "cancellation:refund_manual:31", eventAt: "2026-10-05T10:00:00Z",
    title: "Registrar reintegro", body: "#BX-1031 — Registrá el reintegro.", actionLabel: "Registrar reintegro",
    actionUrl: "/admin/pedidos/31?tab=cancelacion", orderId: 31, isRead: false, priority: "attention" as const, kind: "action" as const }
  const info = { id: "o", type: "order" as const, eventKey: "order:32", eventAt: "2026-10-05T11:00:00Z", title: "Pedido nuevo",
    body: "Ingresó el pedido #BX-1032.", actionUrl: "/admin/pedidos/32", orderId: 32, isRead: false, kind: "info" as const }
  try {
    await act(async () => { ui.root.render(<AdminNotificationsPopover notifications={[info, action]} onNotificationClick={() => {}} />) })
    const doc = ui.dom.window.document
    assert.match(doc.body.textContent ?? "", /1 acción pendiente/)
    const sections = [...doc.querySelectorAll("[data-notification-section]")].map((section) => section.getAttribute("data-notification-section"))
    assert.deepEqual(sections, ["actions", "info"])
    assert.match(doc.querySelector("[data-notification-section='actions']")?.textContent ?? "", /Registrar reintegro/)
    assert.match(doc.querySelector("[data-notification-section='info']")?.textContent ?? "", /Pedido nuevo/)
    await act(async () => { ui.root.render(<AdminNotificationsPopover notifications={[info]} onNotificationClick={() => {}} />) })
    assert.match(doc.body.textContent ?? "", /Sin acciones pendientes/)
    assert.doesNotMatch(doc.body.textContent ?? "", /reconciliation|settlement|conciliaci|RPC/i)
    await act(async () => ui.root.unmount())
  } finally {
    ui.supabase.auth.stopAutoRefresh()
    ui.dom.window.close()
  }
})

test("tanda cerrada: UNA acción 'Confirmar entrega' por tanda; con bloqueados sólo se pide retirarlos; entregada no cuenta", async () => {
  const ui = await setup()
  const { useDispatchAlerts } = await import("../../hooks/use-dispatch-alerts")
  const { ADMIN_DISPATCH_CHANGED_EVENT } = await import("../../hooks/use-admin-notifications")
  let batches: unknown[] = [{ id: 4, code: "DSP-20261005-004", status: "closed", closed_at: "2026-10-05T12:00:00Z", orderCount: 30, blockedOrders: [] }]
  globalThis.fetch = (async () => Response.json({ batches })) as typeof fetch
  let seen: ReturnType<typeof useDispatchAlerts> | null = null
  function Probe() { seen = useDispatchAlerts(true); return null }
  const refresh = async () => {
    await act(async () => {
      ui.dom.window.dispatchEvent(new ui.dom.window.CustomEvent(ADMIN_DISPATCH_CHANGED_EVENT, { detail: "dispatch_batches" }))
      await new Promise((resolve) => setTimeout(resolve, 230))
    })
  }
  try {
    await act(async () => { ui.root.render(<Probe />); await new Promise((resolve) => setTimeout(resolve, 20)) })
    assert.equal(seen!.notifications.length, 1, "30 pedidos = 1 acción")
    assert.equal(seen!.notifications[0].title, "Confirmar entrega de DSP-20261005-004 a Andreani")
    assert.equal(seen!.notifications[0].actionUrl, "/admin/despachos?batch=4")
    assert.equal(seen!.notifications[0].kind, "action")
    assert.equal(seen!.handoverCount, 1)
    assert.equal(seen!.reviewCount, 0)

    batches = [{ id: 4, code: "DSP-20261005-004", status: "closed", orderCount: 30,
      blockedOrders: [{ orderId: 31, reason: "Cancelación solicitada", createdAt: "2026-10-05T12:30:00Z" }] }]
    await refresh()
    assert.deepEqual(seen!.notifications.map((item) => item.actionLabel), ["Retirar del despacho"], "con bloqueados no se ofrece la entrega")
    assert.equal(seen!.handoverCount, 0)
    assert.equal(seen!.reviewCount, 1)

    batches = []
    await refresh()
    assert.equal(seen!.notifications.length, 0, "tanda entregada: 0 acciones")
    assert.equal(seen!.handoverCount, 0)
    await act(async () => ui.root.unmount())
  } finally {
    ui.supabase.auth.stopAutoRefresh()
    ui.dom.window.close()
  }
})
