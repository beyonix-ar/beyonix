import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act, useState } from "react"
import { defaultDispatchFilters } from "./dispatch-board-filters"

test("la barra muestra cuatro campos, combina filtros y Limpiar restaura la fecha de la pestaña", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos" })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import("react-dom/client")
  const { DispatchFilterBar } = await import("../../app/admin/sections/despachos/dispatch-filter-bar")
  const root = createRoot(dom.window.document.getElementById("root")!)
  let filters = defaultDispatchFilters("delivered", "2026-10-18")
  function Wrapper() {
    const [current, setCurrent] = useState(filters)
    filters = current
    return <DispatchFilterBar filters={current} onChange={(patch) => setCurrent((value) => ({ ...value, ...patch }))} onClear={() => setCurrent(defaultDispatchFilters("delivered", "2026-10-18"))} />
  }
  const change = async (label: string, value: string) => {
    const input = dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.dispatchEvent(new dom.window.Event("change", { bubbles: true })) })
  }
  try {
    await act(async () => root.render(<Wrapper />))
    assert.deepEqual([...dom.window.document.querySelectorAll("[role=search] input")].map((input) => input.getAttribute("aria-label")), ["NRO PEDIDO", "NRO BULTO", "FECHA", "USUARIO"])
    assert.equal(dom.window.document.querySelectorAll("[role=search] details, [role=search] select").length, 0)
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="FECHA"]')?.value, "2026-10-18")
    await change("NRO PEDIDO", "1009")
    await change("NRO BULTO", "0007")
    await change("FECHA", "2026-10-15")
    await change("USUARIO", "María")
    assert.deepEqual([filters.search, filters.batch, filters.dateFrom, filters.dateTo, filters.operator], ["1009", "0007", "2026-10-15", "2026-10-15", "María"])
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".dispatch-filter-clear")!.click())
    assert.deepEqual(filters, defaultDispatchFilters("delivered", "2026-10-18"))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
