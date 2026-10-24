import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { dispatchToday, type DispatchRecord } from "./dispatch-records"

// Tabla única de Despachos: pedidos sueltos y Bultos completos con filtros
// combinables. El servidor simulado aplica los mismos filtros que la RPC.
test("Despachos: una tabla, fecha de hoy, filtros combinados, Pedido/Bulto sin duplicar y acciones de consulta", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-records-ui.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-records-ui-key"
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const { createRoot } = await import("react-dom/client")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const root = createRoot(dom.window.document.getElementById("root")!)
  const today = dispatchToday()
  const yesterday = dispatchToday(new Date(Date.now() - 86_400_000))
  const users = [{ id: "u-maria", name: "María Ñúñez" }, { id: "u-pedro", name: "Pedro" }, { id: "u-juan", name: "Juan" }]
  const name = (id: string | null) => users.find((user) => user.id === id)?.name ?? null
  const record = (value: Omit<DispatchRecord, "actorName" | "code" | "displayNumber" | "selectable"> & Partial<DispatchRecord>): DispatchRecord =>
    ({ code: null, displayNumber: null, selectable: false, ...value, actorName: name(value.actorId) })
  const records: Array<DispatchRecord & { members?: number[] }> = [
    record({ kind: "batch", id: 3, code: "DSP-3", displayNumber: 3, state: "E", at: `${today}T13:54:00-03:00`, actorId: "u-maria", units: 7, total: 10000, orderCount: 2 }),
    // Entregado ayer: historial, sólo aparece con su fecha.
    { ...record({ kind: "batch", id: 4, code: "DSP-4", displayNumber: 4, state: "E", at: `${yesterday}T16:00:00-03:00`, actorId: "u-pedro", units: 2, total: 9000, orderCount: 1 }), members: [25] },
    record({ kind: "order", id: 30, state: "X", at: `${today}T12:00:00-03:00`, actorId: null, units: 1, total: 4000, orderCount: 1 }),
    // Diez pedidos de $10.000 con 3 unidades cada uno: una sola fila con la suma.
    { ...record({ kind: "batch", id: 2, code: "DSP-2", displayNumber: 2, state: "P", at: `${today}T11:00:00-03:00`, actorId: "u-juan", units: 30, total: 100000, orderCount: 10 }), members: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22] },
    record({ kind: "order", id: 7, state: "C", at: `${today}T10:00:00-03:00`, actorId: "u-pedro", units: 2, total: 20000, orderCount: 1, selectable: true }),
    record({ kind: "order", id: 12, state: "P", at: `${today}T09:00:00-03:00`, actorId: "u-maria", units: 3, total: 30000, orderCount: 1 }),
    // Pendiente de ayer: trabajo abierto, visible aunque la fecha por defecto sea hoy.
    record({ kind: "order", id: 9, state: "P", at: `${yesterday}T09:00:00-03:00`, actorId: "u-maria", units: 1, total: 5000, orderCount: 1 }),
  ]
  records[0].members = [23, 24]
  const requests: URLSearchParams[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/orders/")) return Response.json({ error: "No disponible en esta prueba." }, { status: 404 })
    if (url.endsWith("/batches/2")) return Response.json({ batch: { id: 2, code: "DSP-2", display_number: 2, status: "open", created_at: `${today}T11:00:00-03:00`, closed_at: null, handed_over_at: null, handed_over_by: null, verification_round: 1 }, items: [], blockedCount: 0, cancelledCount: 0, expectedCount: 10, verifiedCount: 0, missingCount: 10, requiresRevalidation: false, parcelCount: 10, operatorName: null })
    const params = new URL(url, "https://beyonix.test").searchParams
    requests.push(params)
    const order = params.get("order"), batch = params.get("batch")
    const openAll = params.get("openAllDates") === "true"
    const rows = records.filter((row) => (!params.get("date") || (openAll && (row.state === "P" || row.state === "C")) || row.at?.startsWith(params.get("date")!)) &&
      (!order || (row.kind === "order" ? `BX-${1000 + row.id}`.includes(order) : (row.members ?? []).some((id) => `BX-${1000 + id}`.includes(order)))) &&
      (!batch || (row.kind === "batch" && `Bulto - 000${row.displayNumber}`.replace(" - ", "-").includes(batch.replace(" - ", "-")))) &&
      (!params.get("user") || row.actorId === params.get("user")) && (!params.get("state") || row.state === params.get("state")))
      .map((row) => { const copy: Partial<typeof row> = { ...row }; delete copy.members; return copy })
    return Response.json({ rows, total: rows.length, page: 1, pageSize: 20, holds: [], users })
  }
  const document = dom.window.document
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)) }) }
  const change = async (label: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(`.dispatch-filters input[aria-label="${label}"]`)!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.dispatchEvent(new dom.window.Event("change", { bubbles: true })) })
    await settle()
  }
  const choose = async (label: string, option: string) => {
    await act(async () => document.querySelector<HTMLButtonElement>(`.dispatch-filters button[aria-label="${label}"]`)!.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((item) => item.textContent === option)!.click())
    await settle()
  }
  const clear = async () => { await act(async () => document.querySelector<HTMLButtonElement>(".dispatch-filter-clear")!.click()); await settle() }
  const rows = () => [...document.querySelectorAll<HTMLTableRowElement>('table[aria-label="Registros de despachos"] tbody tr')]
  const row = (label: string) => rows().find((item) => item.getAttribute("aria-label") === `Ver ${label}`)!
  const cells = (item: HTMLTableRowElement) => Object.fromEntries([...item.cells].filter((cell) => cell.dataset.label).map((cell) => [cell.dataset.label, cell.textContent?.replace(/\s/g, " ").trim()]))
  const menu = async (label: string) => {
    await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="Acciones de ${label}"]`)!.click())
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim())
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
    return items
  }
  try {
    await act(async () => { root.render(<AdminDispatches />) })
    await settle()
    // Sin pestañas; fecha de hoy por defecto, que sólo recorta lo resuelto.
    assert.equal(document.querySelector(".dispatch-tabs"), null)
    for (const removed of ["Pendientes", "Confirmados", "Entregados"]) assert.equal([...document.querySelectorAll("button")].some((item) => item.textContent === removed), false, removed)
    assert.ok([...document.querySelectorAll("button")].some((item) => item.textContent?.includes("Actualizar")))
    assert.deepEqual([requests[0].get("date"), requests[0].get("openAllDates")], [today, "true"])
    assert.deepEqual([...document.querySelectorAll('table[aria-label="Registros de despachos"] thead th')].map((th) => th.textContent).filter(Boolean),
      ["Seleccionar para Bulto", "Fecha y hora", "N° Pedido", "N° Bulto", "Usuario", "Estado", "Cantidad", "Importe total", "Acciones"], "sin columna Equipo")
    assert.deepEqual(rows().map((item) => item.getAttribute("aria-label")), ["Ver Bulto - 0003", "Ver BX-1030", "Ver Bulto - 0002", "Ver BX-1007", "Ver BX-1012", "Ver BX-1009"], "el pendiente de ayer sigue; el entregado de ayer no")

    // Pedido suelto: N° Pedido y "—" en Bulto. Bulto: "—" en Pedido, sumas del conjunto.
    const [day, month, year] = [today.slice(8, 10), today.slice(5, 7), today.slice(0, 4)]
    assert.deepEqual(cells(row("BX-1012")), { "Fecha y hora": `${day}/${month}/${year} 09:00`, "N° Pedido": "BX-1012", "N° Bulto": "—", Usuario: "María Ñúñez", Estado: "Pendiente", Cantidad: "3 unidades", "Importe total": "$ 30.000,00" })
    // B: un Bulto se mide en pedidos, nunca en "unidades" (el pedido sí, con su unidad explícita).
    const bundle = cells(row("Bulto - 0002"))
    assert.deepEqual([bundle["N° Pedido"], bundle["N° Bulto"], bundle.Cantidad, bundle["Importe total"], bundle.Usuario], ["—", "Bulto - 0002", "10 pedidos", "$ 100.000,00", "Juan"])
    assert.equal(row("Bulto - 0002").querySelector(".dispatch-order-units")?.textContent, "10 pedidos")
    const table = document.querySelector('table[aria-label="Registros de despachos"]')!.textContent ?? ""
    for (const member of [1013, 1015, 1022, 1023]) assert.doesNotMatch(table, new RegExp(`BX-${member}`), "los pedidos del Bulto no aparecen sueltos")

    // Estados: letra + texto con la paleta BEYONIX.
    const tones = Object.fromEntries([...document.querySelectorAll<HTMLElement>(".dispatch-state-badge")].map((badge) => [badge.dataset.state, [badge.textContent, [...badge.classList].find((name) => name.startsWith("admin-ds-tone-"))]]))
    assert.deepEqual(tones, { E: ["Despachado", "admin-ds-tone-info"], X: ["Cancelado", "admin-ds-tone-danger"], P: ["Pendiente", "admin-ds-tone-warning"], C: ["Confirmado", "admin-ds-tone-success"] }, "sin letras, misma paleta")

    // Acciones: sólo consulta.
    assert.deepEqual(await menu("BX-1012"), ["Ver pedido"])
    assert.deepEqual(await menu("Bulto - 0002"), ["Ver bulto"])
    assert.doesNotMatch(table, /Anular|Anulado|Eliminar|Cancelar pedido|Retirar/)

    // Filtros.
    await change("N° PEDIDO", "1012")
    assert.equal(requests.at(-1)?.get("order"), "1012")
    assert.deepEqual(rows().map((item) => item.getAttribute("aria-label")), ["Ver BX-1012"])
    await change("N° PEDIDO", "BX-1015")
    assert.deepEqual(rows().map((item) => item.getAttribute("aria-label")), ["Ver Bulto - 0002"], "un pedido dentro de un Bulto lleva a su Bulto")
    await clear()
    assert.equal(requests.at(-1)?.toString(), "page=1", "Limpiar vacía todo, incluida la fecha")
    await change("N° BULTO", "Bulto-0002")
    assert.deepEqual(rows().map((item) => item.getAttribute("aria-label")), ["Ver Bulto - 0002"])
    await clear()
    await choose("USUARIO", "María Ñúñez")
    assert.equal(requests.at(-1)?.get("user"), "u-maria")
    assert.deepEqual(rows().map((item) => item.getAttribute("aria-label")), ["Ver Bulto - 0003", "Ver BX-1012", "Ver BX-1009"])
    await choose("ESTADO", "Pendiente")
    assert.deepEqual([requests.at(-1)?.get("user"), requests.at(-1)?.get("state"), requests.at(-1)?.get("date")], ["u-maria", "P", null], "combinación")
    assert.deepEqual(rows().map((item) => item.getAttribute("aria-label")), ["Ver BX-1012", "Ver BX-1009"])
    const [yYear, yMonth, yDay] = yesterday.split("-")
    await change("FECHA", `${yDay}/${yMonth}/${yYear}`)
    assert.equal(requests.at(-1)?.get("openAllDates"), null, "fecha elegida a mano: filtra todo")
    assert.deepEqual(rows().map((item) => item.getAttribute("aria-label")), ["Ver BX-1009"], "otra fecha combinada con el resto")
    await clear()
    await change("FECHA", `${yDay}/${yMonth}/${yYear}`)
    assert.deepEqual(rows().map((item) => item.getAttribute("aria-label")), ["Ver Bulto - 0004", "Ver BX-1009"], "el entregado de ayer aparece con su fecha")
    const [tYear, tMonth, tDay] = today.split("-")
    await change("FECHA", `${tDay}/${tMonth}/${tYear}`)
    assert.ok(!rows().some((item) => item.getAttribute("aria-label") === "Ver BX-1009"), "hoy elegido a mano: también recorta lo abierto")
    assert.equal(document.querySelector('.dispatch-filters button[aria-label="EQUIPO"]'), null, "sin filtro Equipo")
    await clear()
    await choose("ESTADO", "Cancelado")
    assert.deepEqual(rows().map((item) => item.getAttribute("aria-label")), ["Ver BX-1030"])
    await clear()

    // Confirmado libre: se puede seleccionar para un Bulto nuevo.
    assert.equal(document.querySelectorAll('input[type="checkbox"]').length, 1)
    await act(async () => document.querySelector<HTMLInputElement>('input[aria-label="Seleccionar BX-1007 para un Bulto"]')!.click())
    assert.match(document.body.textContent ?? "", /1 seleccionados/)

    // Ver bulto abre el detalle con id oculto en la URL.
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Acciones de Bulto - 0002"]')][0].click() })
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Ver bulto")!.click() })
    await settle()
    assert.equal(dom.window.location.search, "?batch=2")
    assert.match(document.body.textContent ?? "", /Bulto general/)
    assert.equal(document.querySelector(".dispatch-filters"), null)
    await act(async () => { [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Volver"))!.click() })
    await settle()
    assert.equal(dom.window.location.search, "")
    assert.ok(document.querySelector('table[aria-label="Registros de despachos"]'))
    // Ver pedido: URL del pedido.
    await act(async () => { row("BX-1012").click() })
    await settle()
    assert.equal(dom.window.location.search, "?order=12")
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
