import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act, createElement } from "react"

import { buildMercadoLibreWorkbook, saleRow, textBuffer } from "../mercadolibre/fixtures/ml-report-fixture"

test("importación ML: analizar, revisar resumen, importar por lote, archivo equivocado y revertir", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    BroadcastChannel: undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const env = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ml-import.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"

  const { supabase } = await import("../supabase/client")
  const session = mock.method(supabase.auth, "getSession", async () => ({ data: { session: { access_token: "token" } }, error: null }))
  const { MercadoLibreImportPanel } = await import("../../app/admin/sections/dashboard/mercadolibre-import-panel")
  const { isMercadoLibreReturn } = await import("../mercadolibre/returns")
  const { createRoot } = await import("react-dom/client")

  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = []
  let batches: unknown[] = []
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ method, path, body })
    if (path === "/api/admin/mercadolibre-sales/import/batches" && method === "GET") return Response.json({ batches })
    if (path === "/api/admin/mercadolibre-sales/import/preview") {
      const rows = body?.rows as Array<{ operation_id: string }>
      return Response.json({
        statuses: rows.map((row) => (row.operation_id.endsWith("3") ? "unchanged" : "new")),
        previousImport: null,
      })
    }
    if (path === "/api/admin/mercadolibre-sales/import/batches" && method === "POST") return Response.json({ batchId: "6f1d1a62-6c55-4f43-9d55-3a4f1a2b7c10" })
    if (path === "/api/admin/mercadolibre-sales/import") {
      return Response.json({ inserted: (body?.rows as unknown[]).length, updated: 0, unchanged: 0, duplicateRows: 0, linked: 1 })
    }
    if (path === "/api/admin/mercadolibre-sales/import/batches" && method === "PATCH") return Response.json({ batch: { status: body?.status } })
    if (path.endsWith("/revert")) return Response.json({ result: { deleted: 2, kept_modified_later: 0, kept_with_return_review: 0, updated_not_reversible: 0, status: "reverted" } })
    throw new Error(`Petición inesperada: ${method} ${path}`)
  })

  const root = createRoot(document.getElementById("root")!)
  const text = () => document.body.textContent ?? ""
  const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent?.includes(label))
  const settle = async () => {
    for (let index = 0; index < 20; index += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
  }
  const choose = async (name: string, buffer: ArrayBuffer) => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new dom.window.File([new Uint8Array(buffer)], name)
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })) })
    await settle()
  }
  let imported = 0

  try {
    await act(async () => {
      root.render(createElement(MercadoLibreImportPanel, { onImported: () => { imported += 1 } }))
    })
    await settle()
    assert.match(text(), /Todavía no hay importaciones registradas/)
    assert.equal(document.querySelector('[aria-current="step"]')?.textContent, "1Seleccionar archivo")

    // Archivo equivocado: error claro, nada se envía al servidor.
    await choose("precios.csv", textBuffer("Producto;Precio\nMate;1000\n"))
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /No se pudo analizar “precios.csv”.*no parece un reporte de ventas de Mercado Libre/)
    assert.equal(calls.filter((call) => call.path.includes("/preview")).length, 0)

    // Archivo válido con una fila inválida, un duplicado y una venta ya cargada.
    await choose("ventas-octubre.xlsx", buildMercadoLibreWorkbook([
      saleRow({ sale_number: "2000000000000001" }),
      saleRow({ sale_number: "2000000000000002", units: 1, product_revenue: 10000, sale_fee: -1300, shipping_cost: 0, taxes: 0, total: 8700 }),
      saleRow({ sale_number: "2000000000000003" }),
      saleRow({ sale_number: "2000000000000001" }),
      saleRow({ sale_number: "2000000000000004", product_revenue: "veinte mil" }),
    ]))
    assert.equal(document.querySelector('[aria-current="step"]')?.textContent, "3Revisar resumen")
    const summary = text()
    assert.match(summary, /ventas-octubre\.xlsx · Excel \(\.xlsx\) · hoja “Ventas AR”/)
    assert.match(summary, /Filas leídas5/)
    assert.match(summary, /Ventas únicas3/)
    assert.match(summary, /Nuevas2/)
    assert.match(summary, /Ya cargadas11 sin cambios/)
    assert.match(summary, /Duplicadas en el archivo1/)
    assert.match(summary, /Filas inválidas1No se importan/)
    assert.match(summary, /Fila 11 \(venta 2000000000000004\): ‘Ingresos por productos’ no es un número válido \(“veinte mil”\)/)
    assert.match(summary, /Total bruto\$\s?50\.000/)
    assert.ok(button("Importar 2 líneas"), "sólo se envían las nuevas o con cambios")

    await act(async () => button("Importar 2 líneas")!.click())
    await settle()
    const sequence = calls.filter((call) => call.method !== "GET" && !call.path.includes("/preview")).map((call) => `${call.method} ${call.path}`)
    assert.deepEqual(sequence, [
      "POST /api/admin/mercadolibre-sales/import/batches",
      "POST /api/admin/mercadolibre-sales/import",
      "PATCH /api/admin/mercadolibre-sales/import/batches",
    ])
    const batchRequest = calls.find((call) => call.method === "POST" && call.path.endsWith("/import/batches"))!.body!
    assert.equal(batchRequest.rowsInvalid, 1)
    assert.equal(batchRequest.rowsRead, 5)
    assert.equal(typeof batchRequest.fileSha256, "string")
    const sent = calls.find((call) => call.path === "/api/admin/mercadolibre-sales/import")!.body!
    assert.deepEqual((sent.rows as Array<{ operation_id: string }>).map((row) => row.operation_id), ["2000000000000001", "2000000000000002"])
    assert.equal(calls.at(-2)?.body?.status ?? calls.find((call) => call.method === "PATCH")?.body?.status, "completed")
    assert.equal(document.querySelector('[aria-current="step"]')?.textContent, "5Resultado")
    assert.match(text(), /Importación completa: ventas-octubre\.xlsx2 ventas nuevas · 0 actualizadas · 1 sin cambios · 1 fila repetida ignorada · 1 fila inválida no importada · 1 vinculada al inventario\./)
    assert.equal(imported, 1)

    // Historial con reversión confirmada por cantidad.
    batches = [{
      id: "6f1d1a62-6c55-4f43-9d55-3a4f1a2b7c10", created_at: "2026-10-14T15:00:00.000Z", finished_at: "2026-10-14T15:00:05.000Z",
      imported_by_email: "admin@beyonix.test", source_file_name: "ventas-octubre.xlsx", file_kind: "xlsx",
      rows_read: 5, rows_valid: 3, rows_invalid: 1, rows_duplicate_in_file: 1, inserted: 2, updated: 0, unchanged: 0,
      status: "completed", error_message: null, invalid_rows: [], reverted_at: null, reverted_count: 0, reversible_sales: 2, kept_sales: 0,
    }]
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Actualizar historial de importaciones"]')!.click())
    await settle()
    assert.match(text(), /ventas-octubre\.xlsxCompleta.*admin@beyonix\.test · 5 filas · 2 nuevas/)
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label^="Revertir importación"]')!.click())
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? "", /Se van a eliminar 2 ventas que creó esta importación/)
    batches = []
    await act(async () => button("Eliminar 2 ventas")!.click())
    await settle()
    const revert = calls.find((call) => call.path.endsWith("/revert"))!
    assert.deepEqual(revert.body, { expectedCount: 2 })
    assert.match(text(), /2 ventas eliminadas de “ventas-octubre\.xlsx”/)

    // Una cancelación con reembolso no es una devolución física pendiente.
    assert.equal(isMercadoLibreReturn({ raw_data: { parsed: { status: "Cancelada por el comprador", cancellations_refunds: -10000 } } }), false)
    assert.equal(isMercadoLibreReturn({ raw_data: { parsed: { status: "Devolución en camino", cancellations_refunds: -10000 } } }), true)
  } finally {
    await act(async () => root.unmount())
    fetchMock.mock.restore()
    session.mock.restore()
    process.env = env
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
