import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

import { argentinaToday, type FiscalDocument, type FiscalKind } from "../../../../lib/arca/fiscal-history"

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  BroadcastChannel: undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fiscal-panel-test.invalid"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"

const day = argentinaToday()
const previous = new Date(`${day}T12:00:00Z`)
previous.setUTCDate(previous.getUTCDate() - 1)
const previousDay = previous.toISOString().slice(0, 10)

function fixtureDocument(kind: FiscalKind, id: string, date: string, number: number): FiscalDocument {
  return {
    kind, id, order_id: 18 + number, point: 1, number,
    display_number: `0001-${String(number).padStart(8, "0")}`,
    client: "Lucas Espinosa", document: "30111222", issued_at: `${date}T15:00:00Z`, day: date,
    amount: 100, cae: `CAE-${number}`, status: "authorized", environment: "production",
    reason: kind === "credit_note" ? "Devolución" : null,
    original_point: kind === "credit_note" ? 1 : null,
    original_number: kind === "credit_note" ? 2 : null,
  }
}

test("historial abre en hoy, navega por días, filtra, selecciona y descarga factura/NC", async () => {
  const { createElement } = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime")
  const { supabase } = await import("../../../../lib/supabase/client")
  const { FiscalHistoryPanel } = await import("./fiscal-history-panel")
  const session = mock.method(supabase.auth, "getSession", async () => ({ data: { session: { access_token: "test-token" } }, error: null }))
  const requests: URL[] = []
  const exports: Array<{ kind: string; scope: string; ids?: string[]; year?: number; month?: number }> = []
  let historyMode: "normal" | "empty" | "error" = "normal"
  const createUrl = URL.createObjectURL
  const revokeUrl = URL.revokeObjectURL
  const click = dom.window.HTMLAnchorElement.prototype.click
  const setTimeoutOriginal = dom.window.setTimeout
  URL.createObjectURL = () => "blob:test"
  URL.revokeObjectURL = () => undefined
  dom.window.HTMLAnchorElement.prototype.click = () => undefined
  dom.window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    delay === 60_000 ? 0 : setTimeoutOriginal.call(dom.window, handler, delay, ...args)) as typeof dom.window.setTimeout
  const fetchMock = mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost")
    requests.push(url)
    if (url.pathname === "/api/admin/facturacion/history") {
      if (historyMode === "error") return Response.json({ error: "No se pudo consultar el historial fiscal." }, { status: 503 })
      if (historyMode === "empty") return Response.json({ items: [], total: 0, page: 1, pageSize: 30 })
      const kind = url.searchParams.get("kind") as FiscalKind
      const rows = [fixtureDocument(kind, kind === "invoice" ? "19" : "00000000-0000-4000-8000-000000000019", day, 3),
        fixtureDocument(kind, kind === "invoice" ? "18" : "00000000-0000-4000-8000-000000000018", previousDay, 2)]
      if (url.searchParams.get("ids") === "1") return Response.json({ ids: rows.filter((row) => row.day === url.searchParams.get("day")).map((row) => row.id) })
      const items = url.searchParams.get("period") === "today" ? rows.slice(0, 1) : rows
      return Response.json({ items, total: items.length, page: 1, pageSize: 30 })
    }
    if (url.pathname === "/api/admin/facturacion/export") {
      const body = JSON.parse(String(init?.body)) as (typeof exports)[number]
      exports.push(body)
      return new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="Factura-test.pdf"' } })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  const root = createRoot(document.getElementById("root") as HTMLElement)
  const router = { bfcacheId: "test-router", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} }
  const render = (kind: FiscalKind) => act(async () => {
    root.render(createElement(AppRouterContext.Provider, { value: router }, createElement(FiscalHistoryPanel, { kind, key: kind })))
  })
  const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label) as HTMLButtonElement | undefined
  const clickButton = (label: string) => act(async () => { const target = button(label); assert.ok(target, label); target.click() })
  try {
    await render("invoice")
    assert.equal(requests.at(-1)?.searchParams.get("period"), "today")
    assert.equal(document.querySelectorAll("[data-fiscal-row]").length, 1)
    await clickButton("Historial")
    assert.equal(document.querySelectorAll("[data-fiscal-day]").length, 2)
    assert.deepEqual([...document.querySelectorAll("[data-fiscal-day]")].map((node) => node.getAttribute("data-fiscal-day")), [day, previousDay])
    await act(async () => { (document.querySelector('input[aria-label="Seleccionar todas las visibles"]') as HTMLInputElement).click() })
    assert.match(document.body.textContent ?? "", /2 facturas seleccionadas/)
    await clickButton("Descargar seleccionadas")
    assert.deepEqual(exports.at(-1)?.ids, ["19", "18"])
    await clickButton("Limpiar selección")
    await act(async () => { const target = button("Seleccionar todas las del día"); assert.ok(target); target.click() })
    assert.match(document.body.textContent ?? "", /1 factura seleccionada/)
    await clickButton("Descargar mes completo")
    assert.equal(exports.at(-1)?.scope, "month")

    await render("credit_note")
    assert.equal(requests.at(-1)?.searchParams.get("period"), "today")
    await clickButton("Historial")
    assert.equal(document.querySelectorAll("[data-fiscal-day]").length, 2)
    await act(async () => { (document.querySelector('input[aria-label="Seleccionar todas las visibles"]') as HTMLInputElement).click() })
    assert.match(document.body.textContent ?? "", /2 notas de crédito seleccionadas/)
    await clickButton("Descargar seleccionadas")
    assert.equal(exports.at(-1)?.kind, "credit_note")
    assert.equal(exports.at(-1)?.ids?.length, 2)

    historyMode = "empty"
    await render("invoice")
    assert.match(document.body.textContent ?? "", /No hay comprobantes para este período y filtros\./)
    assert.doesNotMatch(document.body.textContent ?? "", /No se pudo consultar el historial fiscal\./)

    historyMode = "error"
    await render("credit_note")
    assert.match(document.body.textContent ?? "", /No se pudo consultar el historial fiscal\./)
    assert.doesNotMatch(document.body.textContent ?? "", /No hay comprobantes para este período y filtros\./)
    assert.doesNotMatch(document.body.textContent ?? "", /Historial fiscal persistido · 0 comprobantes/)
  } finally {
    await act(async () => root.unmount())
    fetchMock.mock.restore(); session.mock.restore()
    URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl
    dom.window.HTMLAnchorElement.prototype.click = click
    dom.window.setTimeout = setTimeoutOriginal
    dom.window.close()
  }
})
