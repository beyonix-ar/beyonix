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
  const importButton = () => button(/^Importar \d+ ventas$/)

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
