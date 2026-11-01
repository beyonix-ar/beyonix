import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

import { buildMercadoLibreWorkbook, saleRow } from "../mercadolibre/fixtures/ml-report-fixture"
import { parseMercadoLibreSalesReport } from "../mercadolibre/sales-report"

const CARDS = [
  "Líneas de venta",
  "Unidades informadas",
  "Ingresos por productos",
  "Resultado comercial ML",
  "Cargos por venta",
  "Costo fijo",
  "Costo por cuotas",
  "Envío acreditado por ML",
  "Envío descontado por ML",
  "Reembolsos",
  "Del envío descontado: devoluciones",
  "Reclamos",
]

const devolucion = { status: "Devolución finalizada con reembolso al comprador", units: 2, cancellations_refunds: -41_670, total: -16_570 }

function storedRows(lines: Array<Record<string, unknown>>, reviews: Array<{ received_quantity: number } | null>) {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook(lines.map((line) => saleRow(line))), "ventas.xlsx")
  return report.rows.map((row, index) => ({
    ...row,
    id: `sale-${index}`,
    product_id: null,
    unit_cost: null,
    source_file_name: "ventas.xlsx",
    imported_at: "2026-10-31T12:00:00.000Z",
    return_review: reviews[index]
      ? { id: `review-${index}`, mercadolibre_sale_id: `sale-${index}`, sellable_quantity: reviews[index]!.received_quantity, discounted_quantity: 0, non_sellable_quantity: 0, discount_percent: null, discount_reason: null, non_sellable_reason: null, review_notes: null, occurred_at: "2026-10-31T12:00:00.000Z", approved_at: "2026-10-31T12:00:00.000Z", updated_at: "2026-10-31T12:00:00.000Z", ...reviews[index] }
      : null,
    costing: { match_key: `sku:${row.sku}`, product_id: null, variant_id: null, catalog_sku: null, standalone_key: null, costable_units: row.quantity, unit_cost: null, merchandise_cost: null },
  }))
}

test("Ventas ML: ayuda en las 12 tarjetas, nombres, singular/plural y evidencia física vigente", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const env = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ml-summary.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  const { supabase } = await import("../supabase/client")
  const auth = mock.method(supabase.auth, "getSession", async () => ({ data: { session: { access_token: "test-token" } }, error: null }))
  const { AdminMercadoLibreSales } = await import("../../app/admin/sections/dashboard/admin-mercadolibre-sales")
  const { SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime")
  const { createRoot } = await import("react-dom/client")

  let rows: ReturnType<typeof storedRows> = []
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = String(input)
    if (path === "/api/admin/mercadolibre-sales") return Response.json({ rows, catalog: [] })
    if (path === "/api/admin/mercadolibre-sales/import/batches") return Response.json({ batches: [] })
    throw new Error(`Petición inesperada: ${path}`)
  })
  const card = (label: string) => document.querySelector(`button[aria-label="Ayuda: ${label}"]`)?.closest("div")
  const helperOf = (label: string) => card(label)?.querySelector("p[title]")?.textContent ?? ""
  const tooltipOf = async (label: string) => {
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="Ayuda: ${label}"]`)!
    await act(async () => trigger.focus())
    const text = document.querySelector('[role="tooltip"]')?.textContent
    await act(async () => trigger.blur())
    return text
  }
  const render = async () => {
    const root = createRoot(document.getElementById("root")!)
    await act(async () => root.render(<SearchParamsContext.Provider value={new URLSearchParams()}><AdminMercadoLibreSales /></SearchParamsContext.Provider>))
    for (let index = 0; index < 10; index += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    return root
  }

  try {
    // Caso real: devolución con "Unidades devueltas" vacía y revisión física posterior de 2 unidades.
    rows = storedRows([
      { sale_number: "2000012958302463", ...devolucion },
      { sale_number: "2000012958300001" },
    ], [{ received_quantity: 2 }, null])
    let root = await render()

    // A/B: las 12 tarjetas tienen ayuda accesible y los nombres nuevos.
    const helpLabels = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Ayuda: "]')].map((node) => node.getAttribute("aria-label")!.slice("Ayuda: ".length))
    for (const label of CARDS) assert.ok(helpLabels.includes(label), `falta la ayuda de “${label}”`)
    const pageText = document.body.textContent ?? ""
    for (const old of ["Unidades vendidas", "Ganancia obtenida", "Envío descontado en devoluciones"]) assert.doesNotMatch(pageText, new RegExp(old))

    // C: tooltips de las métricas sensibles (se abren con foco de teclado).
    assert.equal(await tooltipOf("Resultado comercial ML"), "Neto de Mercado Libre menos costo de mercadería; excluye gastos generales.")
    assert.equal(await tooltipOf("Envío descontado por ML"), "Costos logísticos descontados por ML, incluidos los de devoluciones.")
    assert.equal(await tooltipOf("Del envío descontado: devoluciones"), "Parte del envío descontado correspondiente a devoluciones; no se suma aparte.")
    assert.equal(await tooltipOf("Reembolsos"), "Importes reembolsados, mostrados positivos y ya incluidos en el neto ML.")
    assert.equal(await tooltipOf("Líneas de venta"), "Líneas importadas del reporte, incluidas devoluciones y cancelaciones.")

    // D: singular.
    assert.equal(helperOf("Reembolsos"), "1 devolución")
    // F: la revisión física posterior reemplaza el "desconocido" del reporte.
    assert.equal(helperOf("Unidades informadas"), "2 devueltas confirmadas · 2 netas")
    await act(async () => root.unmount())

    // E + G: dos devoluciones sin revisión física: plural y cantidad física desconocida.
    rows = storedRows([
      { sale_number: "2000012958302463", ...devolucion },
      { sale_number: "2000012958302464", ...devolucion },
    ], [null, null])
    root = await render()
    assert.equal(helperOf("Reembolsos"), "2 devoluciones")
    assert.equal(helperOf("Unidades informadas"), "0 devueltas confirmadas · devoluciones físicas desconocidas en 2 líneas")
    await act(async () => root.unmount())

    // Revisión parcial: 4 vendidas, XLSX sin cantidad, 2 recibidas → sigue la incertidumbre y no hay netas.
    rows = storedRows([
      { sale_number: "2000012958302465", ...devolucion, units: 4 },
      { sale_number: "2000012958300002" },
    ], [{ received_quantity: 2 }, null])
    root = await render()
    assert.equal(helperOf("Unidades informadas"), "2 devueltas confirmadas · devolución física parcial en 1 línea")
    await act(async () => root.unmount())
  } finally {
    fetchMock.mock.restore()
    auth.mock.restore()
    await supabase.auth.stopAutoRefresh()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
    dom.window.close()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
