import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"

test("bloqueo, alerta única, resolución y cleanup sin refrescar la página", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-realtime.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-test-key"
  const { supabase } = await import("../../lib/supabase/client")
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const { useDispatchAlerts } = await import("../../hooks/use-dispatch-alerts")
  const { ADMIN_DISPATCH_CHANGED_EVENT } = await import("../../hooks/use-admin-notifications")
  let blocked = false
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ batches: blocked ? [{ id: 1, code: "DSP-20261005-001", status: "closed", blockedOrders: [{ orderId: 31, reason: "Cancelación solicitada", createdAt: "2026-10-05T12:00:00Z" }] }] : [] })
  }
  let seen = { reviewCount: 0, notifications: [] as ReturnType<typeof useDispatchAlerts>["notifications"] }
  function Probe() { seen = useDispatchAlerts(true); return <span>{seen.reviewCount}</span> }
  const root = createRoot(dom.window.document.getElementById("root")!)
  try {
    await act(async () => { root.render(<Probe />) })
    assert.equal(seen.reviewCount, 0)
    blocked = true
    await act(async () => { dom.window.dispatchEvent(new dom.window.CustomEvent(ADMIN_DISPATCH_CHANGED_EVENT, { detail: "dispatch_blocks" })); await new Promise((resolve) => setTimeout(resolve, 230)) })
    assert.equal(seen.reviewCount, 1)
    assert.equal(seen.notifications.length, 1)
    const beforeUnrelatedOrder = calls
    await act(async () => { dom.window.dispatchEvent(new dom.window.CustomEvent(ADMIN_DISPATCH_CHANGED_EVENT, { detail: "ordenes" })); await new Promise((resolve) => setTimeout(resolve, 230)) })
    assert.equal(calls, beforeUnrelatedOrder)
    assert.equal(seen.notifications[0].title, "Pedido BX-1031 bloqueado")
    assert.match(seen.notifications[0].body, /DSP-20261005-001.*Retiralo antes del despacho/)
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event(ADMIN_DISPATCH_CHANGED_EVENT)); await new Promise((resolve) => setTimeout(resolve, 230)) })
    assert.equal(seen.notifications.length, 1)
    blocked = false
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event(ADMIN_DISPATCH_CHANGED_EVENT)); await new Promise((resolve) => setTimeout(resolve, 230)) })
    assert.equal(seen.reviewCount, 0)
    assert.equal(seen.notifications.length, 0)
    await act(async () => root.unmount())
    const count = calls
    dom.window.dispatchEvent(new dom.window.Event(ADMIN_DISPATCH_CHANGED_EVENT))
    await new Promise((resolve) => setTimeout(resolve, 230))
    assert.equal(calls, count)
  } finally { supabase.auth.stopAutoRefresh(); await supabase.removeAllChannels(); supabase.realtime.disconnect(); dom.window.close() }
})

test("tanda preparada cambia a revisión y recupera la entrega al resolver o retirar", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-realtime.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-test-key"
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const { ADMIN_DISPATCH_CHANGED_EVENT } = await import("../../hooks/use-admin-notifications")
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos?batch=1" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  let blocked = false
  let removed = false
  const batch = { id: 1, code: "DSP-20261005-001", status: "closed", created_at: "2026-10-05T12:00:00Z", closed_at: "2026-10-05T13:00:00Z", prepared_at: "2026-10-05T13:00:00Z", handed_over_at: null, handed_over_by: null }
  const member = { id: 9, batch_id: 1, order_id: 31, package_id: 7, added_at: "2026-10-05T12:00:00Z", removed_at: null, blocked: false, blockReason: null as string | null }
  globalThis.fetch = async (input) => {
    const path = String(input)
    if (path.endsWith("/barcode")) return new Response(new Blob(), { status: 500 })
    if (path.endsWith("/batches/1")) return Response.json({ batch, items: removed ? [] : [{ ...member, blocked, blockReason: blocked ? "Cancelación solicitada" : null }], blockedCount: blocked && !removed ? 1 : 0, operatorName: null })
    return Response.json({ orders: [], batches: [{ ...batch, orderCount: removed ? 0 : 1, packageCount: removed ? 0 : 1, blockedCount: blocked && !removed ? 1 : 0 }] })
  }
  const root = createRoot(dom.window.document.getElementById("root")!)
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 270)) }) }
  try {
    await act(async () => { root.render(<AdminDispatches initialBatchId="1" />) })
    await settle()
    const handover = () => [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent?.includes("Confirmar entrega a Andreani"))
    assert.equal(handover()?.disabled, false)
    blocked = true
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event(ADMIN_DISPATCH_CHANGED_EVENT)) })
    await settle()
    assert.match(dom.window.document.body.textContent ?? "", /Requiere revisión/)
    assert.match(dom.window.document.body.textContent ?? "", /BX-1031.*Pedido bloqueado.*Cancelación solicitada/)
    assert.equal(handover()?.disabled, true)
    blocked = false
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event(ADMIN_DISPATCH_CHANGED_EVENT)) })
    await settle()
    assert.match(dom.window.document.body.textContent ?? "", /0 bloqueados/)
    assert.equal(handover()?.disabled, false)
    removed = true
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event(ADMIN_DISPATCH_CHANGED_EVENT)) })
    await settle()
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /BX-1031/)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})
