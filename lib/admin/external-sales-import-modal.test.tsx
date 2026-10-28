import assert from "node:assert/strict"
import { File as NodeFile } from "node:buffer"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act, createElement } from "react"

// Admin > Ventas externas > Pegar ventas / Importar archivo con el modal real:
// el preview queda atado a la entrada exacta que lo produjo. Cambiar texto o
// archivo lo invalida en el acto y una respuesta vieja nunca se aplica.

const HEADER = "Fecha\tCliente\tSKU\tCant.\tPrecio Final"
const TEXT_A = `${HEADER}\n01/03/2026\tAna\tAUR-1\t1\t1000`
const TEXT_B = `${HEADER}\n02/03/2026\tBeto\tAUR-1\t2\t5000`

type Deferred = { resolve: (value: Response) => void; rows: Array<Record<string, unknown>> }

async function setup(source: "paste" | "file") {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const env = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://external-sales-modal.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  const { supabase } = await import("../supabase/client")
  const session = mock.method(supabase.auth, "getSession", async () => ({ data: { session: { access_token: "token" } }, error: null }))
  const { ExternalSalesImportModal } = await import("../../app/admin/sections/dashboard/external-sales-import-modal")
  const { createRoot } = await import("react-dom/client")

  const previews: Deferred[] = []
  const imports: Array<Record<string, unknown>> = []
  const imported: string[] = []
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    if (path === "/api/admin/external-sales/import/preview") {
      return new Promise<Response>((resolve) => previews.push({ resolve, rows: body.rows as Array<Record<string, unknown>> }))
    }
    if (path === "/api/admin/external-sales/import") {
      imports.push(body)
      return Response.json({ result: { batch_id: "batch-1", imported: (body.rows as unknown[]).length, stock_mode: body.stockMode, replayed: false } }, { status: 201 })
    }
    throw new Error(`Petición inesperada: ${path}`)
  })

  const root = createRoot(document.getElementById("root")!)
  await act(async () => root.render(createElement(ExternalSalesImportModal, {
    source, onClose: () => {}, onImported: (message: string) => { imported.push(message) },
  })))

  const settle = async () => { for (let index = 0; index < 6; index += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5))) }
  const button = (label: RegExp) => [...document.querySelectorAll("button")].find((node) => label.test(node.textContent?.trim() ?? ""))
  const click = async (node: Element | undefined) => { assert.ok(node); await act(async () => (node as HTMLElement).click()) }
  const dialogText = () => document.body.textContent ?? ""
  const importButton = () => button(/^Importar \d+ ventas?$/)

  return {
    previews, imports, imported, settle, button, click, dialogText, importButton,
    type: async (value: string) => {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Filas copiadas desde Excel"]')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value)
        textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
      })
    },
    upload: async (name: string, content: string) => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Archivo de ventas externas"]')!
      Object.defineProperty(input, "files", { configurable: true, value: [new NodeFile([content], name, { type: "text/csv" })] })
      await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })) })
      await settle()
    },
    respond: async (deferred: Deferred, overrides: Record<string, unknown> = {}) => {
      await act(async () => deferred.resolve(Response.json({
        preview: {
          rows: deferred.rows.map((_, index) => ({
            index, resolution: "ok", product_id: 1, variant_id: null, product_name: "Auricular Ñandú", variant_name: null,
            available_units: 10, duplicate_sale_numbers: [], ...overrides,
          })),
          previous_batch: null,
        },
      })))
      await settle()
    },
    chooseHistorical: async () => {
      const radio = document.querySelector<HTMLInputElement>('input[name="external-sales-import-mode"]')!
      await act(async () => radio.click())
    },
    chooseNew: async () => {
      const radio = document.querySelectorAll<HTMLInputElement>('input[name="external-sales-import-mode"]')[1]
      await act(async () => radio.click())
    },
    async cleanup() {
      await act(async () => root.unmount())
      fetchMock.mock.restore()
      session.mock.restore()
      process.env = env
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test("A. preview de A y después el texto cambia a B: Confirmar queda bloqueado hasta un preview nuevo", async () => {
  const ui = await setup("paste")
  try {
    await ui.type(TEXT_A)
    await ui.click(ui.button(/^Previsualizar$/))
    await ui.respond(ui.previews[0])
    await ui.chooseHistorical()
    assert.match(ui.dialogText(), /Ana/)
    assert.equal(ui.importButton()?.hasAttribute("disabled"), false, "preview vigente de A: se puede confirmar")

    await ui.type(TEXT_B)
    assert.equal(ui.importButton(), undefined, "el texto cambió: no hay confirmación posible")
    assert.doesNotMatch(ui.dialogText(), /Ana/, "el preview de A desaparece en el acto")
    assert.equal(ui.imports.length, 0)

    await ui.click(ui.button(/^Previsualizar$/))
    assert.equal(ui.importButton(), undefined, "mientras se verifica B tampoco")
    await ui.respond(ui.previews[1])
    assert.match(ui.dialogText(), /Beto/)
    await ui.click(ui.importButton())
    await ui.settle()
    assert.equal(ui.imports.length, 1)
    const rows = ui.imports[0].rows as Array<Record<string, unknown>>
    assert.deepEqual(rows.map((row) => [row.customer_name, row.sale_date, row.quantity, row.gross_amount]), [["Beto", "2026-03-02", 2, 5000]])
    assert.equal(ui.imports[0].stockMode, "none")
  } finally {
    await ui.cleanup()
  }
})

test("B. preview A lento y preview B rápido: llega B, después A, y A se ignora", async () => {
  const ui = await setup("paste")
  try {
    await ui.type(TEXT_A)
    await ui.click(ui.button(/^Previsualizar$/))
    await ui.type(TEXT_B)
    await ui.click(ui.button(/^Previsualizar$/))
    assert.equal(ui.previews.length, 2)

    await ui.respond(ui.previews[1])
    assert.match(ui.dialogText(), /Beto/)
    // A llega tarde y con datos que se notarían (posible duplicada VE-000077).
    await ui.respond(ui.previews[0], { duplicate_sale_numbers: [77], product_name: "Producto viejo de A" })
    assert.match(ui.dialogText(), /Beto/)
    assert.doesNotMatch(ui.dialogText(), /Ana|VE-000077|Producto viejo de A/, "la respuesta vieja no pisa el preview vigente")
    assert.ok(ui.button(/^Previsualizar$/), "no queda un 'Verificando…' colgado")

    await ui.chooseHistorical()
    await ui.click(ui.importButton())
    await ui.settle()
    assert.deepEqual((ui.imports[0].rows as Array<Record<string, unknown>>).map((row) => row.customer_name), ["Beto"])
  } finally {
    await ui.cleanup()
  }
})

test("C. archivo reemplazado: el preview anterior se elimina antes de verificar el nuevo", async () => {
  const ui = await setup("file")
  try {
    await ui.upload("ventas-1.csv", "Fecha,Cliente,SKU,Cant.,Precio Final\n01/03/2026,Ana,AUR-1,1,1000")
    await ui.respond(ui.previews[0])
    await ui.chooseHistorical()
    assert.match(ui.dialogText(), /Ana/)
    assert.ok(ui.importButton())

    await ui.upload("ventas-2.csv", "Fecha,Cliente,SKU,Cant.,Precio Final\n02/03/2026,Beto,AUR-1,2,5000")
    assert.equal(ui.previews.length, 2)
    assert.doesNotMatch(ui.dialogText(), /Ana/, "el preview del archivo anterior ya no se ve")
    assert.equal(ui.importButton(), undefined, "ni se puede confirmar")
    assert.match(ui.dialogText(), /ventas-2\.csv/)

    await ui.respond(ui.previews[1])
    assert.match(ui.dialogText(), /Beto/)
    await ui.click(ui.importButton())
    await ui.settle()
    assert.equal(ui.imports[0].fileName, "ventas-2.csv")
    assert.deepEqual((ui.imports[0].rows as Array<Record<string, unknown>>).map((row) => row.customer_name), ["Beto"])
  } finally {
    await ui.cleanup()
  }
})

// Venta real vieja cuyo SKU ya no existe en el catálogo.
const CABLE_HEADER = "Fecha\tCliente\tSKU\tProducto\tCant.\tPrecio Final\tGanancia\tMedio de pago\tObservación"
const TEXT_CABLE = [
  CABLE_HEADER,
  "15/06/2024\tMarta Peña\tCBCU01\tCABLE USB A USBC\t1\t4500\t1200\tTransferencia\tVenta vieja",
  "16/06/2024\tBeto\tAUR-1\tAuricular Ñandú\t1\t9000\t\tEfectivo\t",
].join("\n")
const unlinked = { resolution: "missing", product_id: null, product_name: null, available_units: null }

/** Fila de la tabla de preview por número de fila del Excel. */
const previewRow = (sourceRow: number) =>
  [...document.querySelectorAll("tbody tr")].find((tr) => tr.querySelector("td")?.textContent === String(sourceRow))

async function previewCable(ui: Awaited<ReturnType<typeof setup>>) {
  await ui.type(TEXT_CABLE)
  await ui.click(ui.button(/^Previsualizar$/))
  const [request] = ui.previews
  await act(async () => request.resolve(Response.json({
    preview: {
      rows: request.rows.map((row, index) => ({
        index, resolution: "ok", product_id: 1, variant_id: null, product_name: "Auricular Ñandú", variant_name: null,
        available_units: 10, duplicate_sale_numbers: [], ...(row.sku === "CBCU01" ? unlinked : {}),
      })),
      previous_batch: null,
    },
  })))
  await ui.settle()
}

test("CBCU01: Nueva → error; Histórica → advertencia importable; el cambio de modo actualiza la fila en el acto", async () => {
  const ui = await setup("paste")
  try {
    await previewCable(ui)

    // A. Nueva + SKU inexistente → error, queda afuera.
    await ui.chooseNew()
    assert.match(previewRow(2)?.textContent ?? "", /Error/)
    assert.match(previewRow(2)?.textContent ?? "", /SKU no disponible para venta nueva/)
    assert.equal(ui.importButton()?.textContent, "Importar 1 venta")
    assert.match(ui.dialogText(), /1 de 2 filas listas · 1 fila quedará afuera/)

    // C + B. Nueva → Histórica: la misma fila pasa a advertencia sin volver a previsualizar.
    await ui.chooseHistorical()
    assert.equal(ui.previews.length, 1, "el modo se aplica sobre el preview vigente")
    const row = previewRow(2)?.textContent ?? ""
    assert.match(row, /Advertencia/)
    assert.match(row, /SKU histórico sin vínculo/)
    assert.doesNotMatch(row, /Error|no disponible para venta nueva/, "no queda el error del modo anterior")
    assert.equal(ui.importButton()?.textContent, "Importar 2 ventas")
    assert.match(ui.dialogText(), /2 de 2 filas listas/)
    assert.doesNotMatch(ui.dialogText(), /quedará afuera/)

    await ui.click(ui.importButton())
    await ui.settle()
    assert.equal(ui.imports[0].stockMode, "none")
    const cable = (ui.imports[0].rows as Array<Record<string, unknown>>).find((sale) => sale.sku === "CBCU01")
    assert.deepEqual(
      cable && [cable.product_name, cable.sale_date, cable.customer_name, cable.quantity, cable.gross_amount, cable.declared_profit, cable.payment_method, cable.notes],
      ["CABLE USB A USBC", "2024-06-15", "Marta Peña", 1, 4500, 1200, "Transferencia", "Venta vieja"],
    )
    assert.equal("product_id" in (cable ?? {}), false, "el producto lo resuelve el servidor por SKU, nunca el navegador")
  } finally {
    await ui.cleanup()
  }
})

test("E/F. validación corta con detalle completo desplegable, resumen compacto y cabecera sticky", async () => {
  const ui = await setup("paste")
  try {
    await previewCable(ui)
    await ui.chooseNew()
    const cell = previewRow(2)?.querySelector("td:last-child")
    const details = cell?.querySelector("details")
    assert.ok(details, "el detalle se despliega con mouse, teclado o touch")
    const summary = details.querySelector("summary")!
    assert.match(summary.textContent ?? "", /^SKU no disponible para venta nueva/)
    assert.match(summary.getAttribute("title") ?? "", /Una venta nueva necesita un producto válido para poder descontar stock/, "tooltip con el detalle")
    assert.match(details.querySelector("ul")?.textContent ?? "", /El SKU no está en el catálogo actual\. Una venta nueva necesita un producto válido/)

    await ui.chooseHistorical()
    const historical = previewRow(2)?.querySelector("td:last-child summary")
    assert.match(historical?.getAttribute("title") ?? "", /La venta se conservará con el SKU y el nombre del Excel, sin modificar stock/)

    const chips = [...document.querySelectorAll('ul[aria-label="Resumen de validación"] li')].map((li) => li.textContent)
    assert.deepEqual(chips, ["1 válida", "1 advertencia", "0 duplicadas", "0 errores"])

    const headers = [...document.querySelectorAll("thead th")]
    assert.deepEqual(headers.map((th) => th.textContent), ["Fila", "Estado", "Fecha", "Cliente", "SKU", "Producto", "Cant.", "Precio final", "Validación"])
    assert.ok(headers.every((th) => /\bsticky\b/.test(th.className) && /\btop-0\b/.test(th.className)), "la cabecera queda visible al scrollear")
    assert.match(document.querySelector("table")?.className ?? "", /\btable-fixed\b/)
  } finally {
    await ui.cleanup()
  }
})

test("cambiar Histórica/Nueva descarta confirmaciones de duplicadas: se confirma lo que se ve", async () => {
  const ui = await setup("paste")
  try {
    await ui.type(TEXT_A)
    await ui.click(ui.button(/^Previsualizar$/))
    await ui.respond(ui.previews[0], { duplicate_sale_numbers: [5] })
    await ui.chooseHistorical()
    assert.match(ui.dialogText(), /Posible duplicada/)
    assert.equal(ui.importButton()?.hasAttribute("disabled"), true, "duplicada sin confirmar: no hay nada para importar")
    const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((node) => /Es una venta distinta/.test(node.parentElement?.textContent ?? ""))!
    await ui.click(checkbox)
    assert.equal(ui.importButton()?.hasAttribute("disabled"), false)

    const fresh = document.querySelectorAll<HTMLInputElement>('input[name="external-sales-import-mode"]')[1]
    await ui.click(fresh)
    assert.equal(checkbox.checked, false, "el cambio de modo pide volver a confirmar")
    assert.equal(ui.importButton()?.hasAttribute("disabled"), true)
    assert.equal(ui.imports.length, 0)
  } finally {
    await ui.cleanup()
  }
})
