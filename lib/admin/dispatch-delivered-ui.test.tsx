import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { dispatchToday } from "./dispatch-records"

test("Bulto entregado en la tabla única: historial con actores, paquetes y retirados; fecha y Limpiar conservan hoy", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-delivered.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-delivered-key"
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const { createRoot } = await import("react-dom/client")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const root = createRoot(dom.window.document.getElementById("root")!)
  const today = dispatchToday()
  const batch = { id: 7, code: "DSP-20261018-007", display_number: 7, status: "handed_over", created_at: `${today}T09:00:00-03:00`, closed_at: `${today}T12:00:00-03:00`, handed_over_at: `${today}T16:00:00-03:00`, handed_over_by: "actor-c", verification_round: 1 }
  const record = { kind: "batch", id: 7, code: batch.code, displayNumber: 7, state: "E", at: batch.handed_over_at, actorId: "actor-c", actorName: "María", units: 3, total: 9000, orderCount: 1, selectable: false }
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.includes("/batches/7?history")) return Response.json({ batch, orderCount: 1, parcelCount: 3, pickingBy: ["Pedro"], preparedBy: ["Lucía"], assembledBy: "Juan", controlledBy: ["Lucía"], deliveredBy: "María", items: [
      { orderId: 12, parcelCount: 3, removedAt: null, removalReason: null, cancelled: false, preparedBy: "Lucía", controlledBy: "Lucía", removedBy: null },
      { orderId: 13, parcelCount: 1, removedAt: `${today}T13:00:00-03:00`, removalReason: "Pedido cancelado", cancelled: true, preparedBy: "Juan", controlledBy: null, removedBy: "María" },
    ] })
    if (url.endsWith("/batches/7")) return Response.json({ batch, items: [], blockedCount: 0, cancelledCount: 0, expectedCount: 1, verifiedCount: 1, missingCount: 0, verificationRequired: true, requiresRevalidation: false, parcelCount: 3, operatorName: "María" })
    const params = new URL(url, "https://beyonix.test").searchParams
    const rows = params.get("date") === today ? [record] : []
    return Response.json({ rows, holds: [], users: [], total: rows.length, page: 1 })
  }
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }) }
  try {
    await act(async () => { root.render(<AdminDispatches />) })
    await settle()
    assert.ok(requests.some((url) => url.includes(`date=${today}`)))
    const row = dom.window.document.querySelector<HTMLTableRowElement>('tr[aria-label="Ver Bulto - 0007"]')!
    assert.match(row.textContent ?? "", /Bulto - 0007[\s\S]*María[\s\S]*EEntregado/)
    await act(async () => { row.click() })
    await settle()
    const content = dom.window.document.body.textContent ?? ""
    assert.match(content, /3 paquetes/)
    assert.equal((content.match(/Bulto - 0007/g) ?? []).length, 1)
    assert.match(content, /Picking: Pedro[\s\S]*Armado: Juan[\s\S]*Confirmación: María[\s\S]*Control del bulto: Lucía[\s\S]*Entregado:/)
    const [year, month, day] = today.split("-")
    assert.ok(content.includes(`Entregado: ${day}/${month}/${year} - 16:00`))
    assert.match(content, /BX-1012/)
    assert.match(content, /BX-1013/)
    assert.match(content, /Cancelado y retirado/)
    await act(async () => { [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Volver")!.click() })
    await settle()
    const date = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="FECHA"]')!
    const inputSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { inputSetter.call(date, "15/10/2026"); date.dispatchEvent(new dom.window.Event("input", { bubbles: true })); date.dispatchEvent(new dom.window.Event("change", { bubbles: true })) })
    await settle()
    assert.ok(requests.some((url) => url.includes("date=2026-10-15")))
    assert.match(dom.window.document.body.textContent ?? "", /No hay registros con estos filtros/)
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".dispatch-filter-clear")!.click() })
    await settle()
    assert.ok(requests.at(-1)?.includes(`date=${today}`))
  } finally {
    await act(async () => root.unmount())
    supabase.auth.stopAutoRefresh()
    await supabase.removeAllChannels()
    supabase.realtime.disconnect()
    const channel: unknown = Reflect.get(supabase.auth, "broadcastChannel")
    if (channel instanceof BroadcastChannel) channel.close()
    dom.window.close()
  }
})
