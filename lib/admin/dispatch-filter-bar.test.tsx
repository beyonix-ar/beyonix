import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act, useState } from "react"
import { clearedDispatchRecordFilters, defaultDispatchRecordFilters, dispatchRecordParams, restoreDispatchRecordsView } from "./dispatch-records"

test("filtros: fecha BEYONIX en hoy, Pedido/Bulto, selects compartidos (sin nativos), sin Equipo y Limpiar", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos" })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import("react-dom/client")
  const { DispatchFilterBar } = await import("../../app/admin/sections/despachos/dispatch-filter-bar")
  const root = createRoot(dom.window.document.getElementById("root")!)
  const today = "2026-10-22"
  let filters = defaultDispatchRecordFilters(today)
  const users = [{ id: "u-1", name: "María Ñúñez" }, { id: "u-2", name: "Pedro" }]
  function Wrapper() {
    const [current, setCurrent] = useState(filters)
    filters = current
    return <DispatchFilterBar filters={current} users={users} onChange={(patch) => setCurrent((value) => ({ ...value, ...patch }))} onClear={() => setCurrent(clearedDispatchRecordFilters())} />
  }
  const document = dom.window.document
  const change = async (label: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.dispatchEvent(new dom.window.Event("change", { bubbles: true })) })
  }
  const choose = async (label: string, option: string) => {
    await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((item) => item.textContent === option)!.click())
  }
  try {
    await act(async () => root.render(<Wrapper />))
    const search = document.querySelector("[role=search]")!
    assert.deepEqual([...search.querySelectorAll("input")].map((input) => input.getAttribute("aria-label")), ["FECHA", "N° PEDIDO", "N° BULTO"])
    assert.deepEqual([...search.querySelectorAll("button[aria-haspopup=listbox]")].map((button) => button.getAttribute("aria-label")), ["USUARIO", "ESTADO"])
    assert.deepEqual([...search.children].map((child) => (child.matches("input") ? child : child.querySelector("input, button"))?.getAttribute("aria-label") ?? child.textContent),
      ["FECHA", "N° PEDIDO", "N° BULTO", "USUARIO", "ESTADO", "Limpiar"], "orden: Fecha | N° Pedido | N° Bulto | Usuario | Estado | Limpiar")
    assert.doesNotMatch(search.textContent ?? "", /EQUIPO/i, "sin filtro Equipo")
    assert.equal(search.querySelectorAll("select, details, input[type=date]").length, 0, "nada de selects nativos")
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="FECHA"]')?.value, "22/10/2026", "fecha por defecto: hoy")
    assert.ok(document.querySelector('button[aria-label="Abrir calendario"]'), "selector de fecha BEYONIX")
    assert.ok(document.querySelector('button[aria-label="USUARIO"]')?.classList.contains("is-placeholder"), "sin valor: estilo de placeholder")

    await change("N° PEDIDO", "BX-1012")
    await change("N° BULTO", "Bulto-0002")
    await change("FECHA", "15/10/2026")
    await choose("USUARIO", "María Ñúñez")
    await choose("ESTADO", "Entregado")
    assert.deepEqual(filters, { date: "2026-10-15", manualDate: true, order: "BX-1012", batch: "Bulto-0002", user: "u-1", state: "E" }, "fecha elegida a mano")
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="ESTADO"]')!.click())
    assert.deepEqual([...document.querySelectorAll('[role="option"]')].map((item) => item.textContent),
      ["Todos los estados", "Pendiente", "Confirmado", "Entregado", "Cancelado"], "sin letras y sin Anulado")
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
    assert.equal(document.querySelector('button[aria-label="ESTADO"]')?.textContent, "Entregado")
    assert.equal(document.querySelector('button[aria-label="ESTADO"]')?.classList.contains("is-placeholder"), false)
    await act(async () => document.querySelector<HTMLButtonElement>(".dispatch-filter-clear")!.click())
    // "Limpiar" deja absolutamente todos los filtros vacíos, incluida fecha.
    assert.deepEqual(filters, clearedDispatchRecordFilters())
    assert.deepEqual([filters.date, filters.order, filters.batch, filters.user, filters.state], ["", "", "", "", ""])
    assert.deepEqual([...search.querySelectorAll("input")].map((input) => input.value), ["", "", ""], "Fecha, N° Pedido y N° Bulto vacíos")
    assert.deepEqual(["USUARIO", "ESTADO"].map((label) => {
      const button = document.querySelector(`button[aria-label="${label}"]`)!
      return [button.textContent, button.classList.contains("is-placeholder")]
    }), [["USUARIO", true], ["ESTADO", true]], "Usuario y Estado vacíos")
    assert.equal(dispatchRecordParams(filters, 1), "page=1", "sin fecha ni filtros ocultos")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test("Limpiar deja absolutamente todos los filtros vacíos, incluida fecha, y refrescar no la reinyecta", () => {
  const today = "2026-10-22"
  const cleared = clearedDispatchRecordFilters()
  assert.deepEqual([cleared.date, cleared.order, cleared.batch, cleared.user, cleared.state], ["", "", "", "", ""])
  assert.equal(dispatchRecordParams(cleared, 1), "page=1")
  const restored = restoreDispatchRecordsView(JSON.stringify({ filters: cleared, page: 1, today }), today)
  assert.deepEqual(restored.filters, cleared, "la sesión guardada conserva la fecha vacía")
  assert.notDeepEqual(restored.filters, defaultDispatchRecordFilters(today))
})