import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

import { adminConfigStubs, adminPageHtml } from "./admin-config-browser-harness.ts"

// Admin > Ventas externas con el panel REAL (bundle esbuild) en Chromium,
// contra una API simulada en memoria: pegar ventas, preview que se invalida
// al cambiar el texto, Histórica/Nueva, posible duplicada, confirmación,
// anulación por error, devoluciones vendible/dañada e historial de tandas.
// No se conecta con Supabase ni con ningún proveedor externo.

const ENTRY = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { AdminExternalSales } from "@/app/admin/sections/dashboard/admin-external-sales"

const state = { sales: [], batches: [], previews: [], imports: [], cancels: [], nextNumber: 1 }
window.__state = state
const key = (row) => [row.sale_date, String(row.sku).trim().toUpperCase(), String(row.customer_name ?? "").trim().toLowerCase(), row.quantity, Number(row.gross_amount).toFixed(2)].join("|")
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const listItem = (sale) => ({ ...sale, profit_amount: sale.declared_profit, profit_source: sale.declared_profit == null ? null : "declared", cost_amount: null, cost_status: sale.declared_profit == null ? "undeterminable" : "known" })

window.fetch = async (input, init) => {
  const url = new URL(String(input), "http://admin.test")
  const method = (init && init.method) || "GET"
  const body = init && init.body ? JSON.parse(init.body) : null
  const path = url.pathname
  if (path === "/api/admin/external-sales" && method === "GET") {
    return json({ sales: [...state.sales].reverse().map(listItem), truncated: false })
  }
  if (path === "/api/admin/external-sales/import/preview") {
    state.previews.push(body.rows)
    return json({ preview: { previous_batch: null, rows: body.rows.map((row, index) => ({
      index, resolution: "ok", product_id: 1, variant_id: null, product_name: "Auricular Ñandú", variant_name: null, available_units: 50,
      duplicate_sale_numbers: state.sales.filter((sale) => sale.status !== "reversed" && key(sale) === key(row)).map((sale) => sale.sale_number),
      // SKU de una venta vieja que ya no existe en el catálogo.
      ...(row.sku === "CBCU01" ? { resolution: "missing", product_id: null, product_name: null, available_units: null } : {}),
    })) } })
  }
  if (path === "/api/admin/external-sales/import") {
    state.imports.push(body)
    const duplicate = body.rows.find((row) => !row.confirm_duplicate && state.sales.some((sale) => sale.status !== "reversed" && key(sale) === key(row)))
    if (duplicate) return json({ error: "La fila " + duplicate.source_row_number + " parece repetida. Confirmá que es una venta distinta." }, 409)
    const batch = { id: "batch-" + (state.batches.length + 1), created_at: "2026-10-28T12:00:00.000Z", created_by: "admin", created_by_name: "Lucía Admin",
      source: body.source, file_name: body.fileName, stock_mode: body.stockMode, rows_read: body.rowsRead, rows_valid: body.rows.length,
      rows_imported: body.rows.length, status: "completed", reverted_at: null, reverted_by_name: null, revert_reason: null, modified_sales: 0 }
    state.batches.push(batch)
    for (const row of body.rows) {
      const number = state.nextNumber++
      state.sales.push({
        id: "sale-" + number, sale_number: number, sale_date: row.sale_date, product_id: 1, variant_id: null, product_name: row.product_name ?? "Auricular Ñandú",
        sku: row.sku, quantity: row.quantity, unit_price: row.gross_amount / row.quantity, unit_cost: 0, gross_amount: row.gross_amount, fee_amount: 0,
        shipping_amount: row.shipping_amount, other_expense_amount: 0, net_amount: row.gross_amount, payment_method: row.payment_method,
        payment_method_code: row.payment_method_code, customer_name: row.customer_name, channel: row.channel, channel_label: row.channel_label,
        notes: row.notes, reference: null, status: row.status, stock_effect: body.stockMode, origin: body.source, import_batch_id: batch.id,
        source_row_number: row.source_row_number, source_values: row.source_values, declared_profit: row.declared_profit, costo_unitario_historico: null,
        version: 1, modified_after_import_at: null, reversal_kind: null, return_condition: null, reversal_reason: null, reversal_amount: null,
        reversed_at: null, reversed_by: null, created_at: "2026-10-28T12:00:00.000Z", updated_at: "2026-10-28T12:00:00.000Z",
      })
    }
    return json({ result: { batch_id: batch.id, imported: body.rows.length, stock_mode: body.stockMode, replayed: false } }, 201)
  }
  if (path === "/api/admin/external-sales/import-batches") return json({ batches: [...state.batches].reverse() })
  const cancel = /^\\/api\\/admin\\/external-sales\\/([^/]+)\\/cancel$/.exec(path)
  if (cancel) {
    state.cancels.push(body)
    const sale = state.sales.find((item) => item.id === decodeURIComponent(cancel[1]))
    if (sale.version !== body.version) return json({ error: "Otro administrador modificó esta venta." }, 409)
    Object.assign(sale, { status: "reversed", reversal_kind: body.kind, return_condition: body.returnCondition, reversal_reason: body.reason,
      reversed_at: "2026-10-28T13:00:00.000Z", version: sale.version + 1, modified_after_import_at: "2026-10-28T13:00:00.000Z" })
    const batch = state.batches.find((item) => item.id === sale.import_batch_id)
    if (batch) batch.modified_sales += 1
    return json({ sale: listItem(sale) })
  }
  const detail = /^\\/api\\/admin\\/external-sales\\/([^/]+)$/.exec(path)
  if (detail && method === "GET") {
    const sale = state.sales.find((item) => item.id === decodeURIComponent(detail[1]))
    const batch = state.batches.find((item) => item.id === sale.import_batch_id)
    return json({
      sale: { ...listItem(sale), created_by_name: "Lucía Admin", reversed_by_name: sale.reversed_at ? "Lucía Admin" : null },
      batch: batch && { id: batch.id, created_at: batch.created_at, source: batch.source, file_name: batch.file_name, stock_mode: batch.stock_mode, rows_imported: batch.rows_imported, status: batch.status },
      catalog: { product: { id: 1, nombre: "Auricular Ñandú", sku: "AUR-1", activo: true }, variant: null },
      history: [],
    })
  }
  return json({ error: "No simulado: " + method + " " + path }, 404)
}

createRoot(document.getElementById("root")).render(createElement(AdminExternalSales))
`

const HEADER = ["Fecha", "Cliente", "Canal", "SKU", "Producto", "Cant.", "Envío", "Medio de pago", "Estado", "Precio Final", "Ganancia"].join("\t")
const tsv = (rows: string[][]) => [HEADER, ...rows.map((cells) => cells.join("\t"))].join("\n")
const ROW_ANA = ["01/03/2026", "Ana Núñez", "WhatsApp", "AUR-1", "Auricular Ñandú", "1", "$ 0", "Transferencia", "Entregada", "$ 15.000", "$ 4.000"]
const ROW_BETO = ["02/03/2026", "Beto", "Instagram", "AUR-1", "Auricular Ñandú", "2", "", "Efectivo", "Confirmada", "$ 28.000", "$ 7.000"]
const ROW_CARO = ["03/03/2026", "Caro", "Venta directa", "AUR-1", "Auricular Ñandú", "1", "$ 1.500", "MP", "", "$ 14.500,50", ""]

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-external-sales-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [adminConfigStubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  // http://admin.test no es contexto seguro: el admin real (HTTPS) sí tiene crypto.randomUUID.
  await page.addInitScript({
    content: `if (typeof crypto.randomUUID !== "function") {
      let n = 0
      Object.defineProperty(crypto, "randomUUID", { value: () => "10000000-1000-4000-8000-" + String(++n).padStart(12, "0") })
    }`,
  })
  await page.route("**/*", (route) =>
    route.request().url() === "http://admin.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml("dark", css, bundle) })
      : route.abort(),
  )
  await page.goto("http://admin.test/")
  await page.getByRole("heading", { name: "Ventas externas" }).waitFor()
  return { page, errors }
}

const appState = (page: Page) => page.evaluate(() => (window as unknown as { __state: {
  previews: unknown[]; imports: Array<{ stockMode: string; rows: Array<Record<string, unknown>> }>; cancels: Array<Record<string, unknown>>
} }).__state)
const importButton = (page: Page) => page.getByRole("button", { name: /^Importar \d+ ventas?$/ })

async function paste(page: Page, text: string) {
  await page.getByLabel("Filas copiadas desde Excel").fill(text)
  await page.getByRole("button", { name: "Previsualizar" }).click()
  await page.getByText("¿Qué ventas son?").waitFor()
}

async function cancelSale(page: Page, saleNumber: string, kind: RegExp, condition: RegExp | null, button: string) {
  await page.getByRole("button", { name: `Ver venta ${saleNumber}` }).click()
  await page.getByRole("button", { name: "Registrar devolución / Anular venta" }).click()
  await page.getByRole("radio", { name: kind }).check()
  if (condition) await page.getByRole("radio", { name: condition }).check()
  await page.getByLabel("Motivo").fill("Motivo suficientemente claro")
  await page.getByRole("button", { name: button }).click()
}

test("Ventas externas en Chromium: pegar, preview vigente, duplicada, anulación, devoluciones e historial", async () => {
  const { page, errors } = await open()
  try {
    // 1. Pegar ventas → preview.
    await page.getByRole("button", { name: "Pegar ventas" }).click()
    await paste(page, tsv([ROW_ANA, ROW_BETO]))
    await page.getByRole("radio", { name: /Históricas/ }).check()
    assert.equal(await importButton(page).isEnabled(), true)
    assert.match(await page.getByRole("dialog").textContent() ?? "", /Beto/)

    // 2. Cambiar el texto invalida el preview en el acto: no hay qué confirmar.
    await page.getByLabel("Filas copiadas desde Excel").fill(tsv([ROW_ANA, ROW_BETO, ROW_CARO]))
    assert.equal(await importButton(page).count(), 0, "el preview anterior no puede confirmarse")
    assert.doesNotMatch(await page.getByRole("dialog").textContent() ?? "", /Válida/)
    await page.getByRole("button", { name: "Previsualizar" }).click()
    await importButton(page).waitFor()
    assert.equal(await page.getByRole("radio", { name: /Históricas/ }).isChecked(), true)
    await importButton(page).click()
    await page.getByText("3 ventas históricas importadas. El stock no se modificó.").waitFor()
    let state = await appState(page)
    assert.equal(state.previews.length, 2)
    assert.deepEqual(state.imports[0].rows.map((row) => [row.customer_name, row.gross_amount, row.shipping_amount]), [
      ["Ana Núñez", 15000, 0], ["Beto", 28000, 0], ["Caro", 14500.5, 1500],
    ], "se importa exactamente lo último previsualizado; envío vacío = $0")
    assert.equal(state.imports[0].stockMode, "none")

    // 3. Posible duplicada: bloqueada hasta confirmar "Es una venta distinta"; Nueva.
    await page.getByRole("button", { name: "Pegar ventas" }).click()
    await paste(page, tsv([ROW_ANA]))
    await page.getByText("Posible duplicada").first().waitFor()
    await page.getByRole("radio", { name: /Nuevas/ }).check()
    assert.equal(await importButton(page).isEnabled(), false, "duplicada sin confirmar: nada para importar")
    await page.getByRole("checkbox", { name: /Es una venta distinta/ }).check()
    await importButton(page).click()
    await page.getByText("1 ventas nuevas importadas. El stock se descontó.").waitFor()
    state = await appState(page)
    assert.equal(state.imports[1].stockMode, "consume")
    assert.equal(state.imports[1].rows[0].confirm_duplicate, true)

    // 4. Anular por error y devoluciones vendible / dañada.
    await cancelSale(page, "VE-000001", /Venta cargada por error/, null, "Anular venta")
    await page.getByText("Venta anulada por error de carga.").waitFor()
    await cancelSale(page, "VE-000002", /Devolución real/, /Sí, vuelve a la venta/, "Registrar devolución")
    await page.getByText("Devolución registrada.").waitFor()
    await cancelSale(page, "VE-000004", /Devolución real/, /No, está dañado/, "Registrar devolución")
    await page.getByText("Devolución registrada.").waitFor()
    state = await appState(page)
    assert.deepEqual(state.cancels.map((body) => [body.kind, body.returnCondition, body.version]), [
      ["entry_error", null, 1], ["return", "sellable", 1], ["return", "damaged", 1],
    ])
    assert.equal(await page.getByText("Anulada", { exact: true }).count(), 3)

    // 5. Historial de importaciones: dos tandas, una con ventas modificadas.
    await page.getByRole("tab", { name: "Historial de importaciones" }).click()
    await page.getByText("Filas pegadas").first().waitFor()
    const history = await page.locator("table").first().textContent() ?? ""
    assert.match(history, /Lucía Admin/)
    assert.equal(await page.getByText("Filas pegadas").count(), 2)
    assert.match(history, /Histórica/)
    assert.match(history, /Nueva/)
    assert.match(history, /Esta tanda contiene ventas modificadas/)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

const ROW_CABLE = ["15/06/2024", "Marta Peña", "WhatsApp", "CBCU01", "CABLE USB A USBC", "1", "", "Transferencia", "", "$ 4.500", "$ 1.200"]

test("Pegar ventas en Chromium: CBCU01 Nueva/Histórica, detalle por teclado e importación histórica", async () => {
  const { page, errors } = await open()
  try {
    await page.getByRole("button", { name: "Pegar ventas" }).click()
    const many = Array.from({ length: 14 }, (_, index) => [`${String(index + 1).padStart(2, "0")}/04/2026`, `Cliente con un nombre bastante largo ${index}`,
      "WhatsApp", "AUR-1", "Auricular Ñandú con un nombre de producto realmente largo para probar el recorte", "1", "", "Efectivo", "", "$ 9.000", ""])
    await paste(page, tsv([ROW_CABLE, ...many]))
    const dialog = page.getByRole("dialog")
    const cableRow = dialog.locator("tbody tr").filter({ hasText: "CBCU01" })

    await page.getByRole("radio", { name: /Nuevas/ }).check()
    await cableRow.getByText("SKU no disponible para venta nueva").waitFor()
    assert.match(await cableRow.textContent() ?? "", /Error/)
    assert.match(await dialog.textContent() ?? "", /14 de 15 filas listas · 1 fila quedará afuera/)

    await page.getByRole("radio", { name: /Históricas/ }).check()
    await cableRow.getByText("SKU histórico sin vínculo", { exact: true }).waitFor()
    assert.match(await cableRow.textContent() ?? "", /Advertencia/)
    assert.doesNotMatch(await cableRow.textContent() ?? "", /Error/)
    assert.equal(await importButton(page).textContent(), "Importar 15 ventas")

    // Detalle completo con teclado: foco en el resumen y Enter lo despliega.
    await cableRow.locator("summary").focus()
    await page.keyboard.press("Enter")
    await cableRow.getByText(/La venta se conservará con el SKU y el nombre del Excel, sin modificar stock/).waitFor()

    await importButton(page).click()
    await page.getByText("15 ventas históricas importadas. El stock no se modificó.").waitFor()
    const state = await appState(page)
    const cable = state.imports[0].rows.find((row) => row.sku === "CBCU01")
    assert.equal(state.imports[0].stockMode, "none")
    assert.deepEqual(cable && [cable.product_name, cable.customer_name, cable.gross_amount, cable.declared_profit], ["CABLE USB A USBC", "Marta Peña", 4500, 1200])
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

const LAYOUT_ROWS = [ROW_CABLE, ...Array.from({ length: 14 }, (_, index) => [`${String(index + 1).padStart(2, "0")}/04/2026`,
  `Cliente con un nombre bastante largo ${index}`, "WhatsApp", "AUR-1", "Auricular Ñandú con un nombre de producto realmente largo para probar el recorte",
  "1", "", "Efectivo", "", "$ 9.000", ""])]

test("Pegar ventas: modal horizontal en desktop (1920/1440/1366) y vertical en mobile, con la tabla como único scroll", async () => {
  const viewports = [
    { width: 1920, height: 1080, desktop: true },
    { width: 1440, height: 900, desktop: true },
    { width: 1366, height: 768, desktop: true },
    { width: 390, height: 844, desktop: false },
  ]
  for (const { desktop, ...viewport } of viewports) {
    const { page, errors } = await open()
    const at = `${viewport.width}x${viewport.height}`
    try {
      await page.setViewportSize(viewport)
      await page.getByRole("button", { name: "Pegar ventas" }).click()
      await paste(page, tsv(LAYOUT_ROWS))
      await page.getByRole("radio", { name: /Históricas/ }).check()
      const metrics = await page.getByRole("dialog").evaluate((dialog) => {
        const table = dialog.querySelector("table")!
        const scroller = table.parentElement!
        const textarea = dialog.querySelector("textarea")!
        const modes = dialog.querySelector("fieldset")!.getBoundingClientRect()
        const chips = dialog.querySelector('ul[aria-label="Resumen de validación"]')!.getBoundingClientRect()
        const footerButton = [...dialog.querySelectorAll("button")].find((button) => /^Importar \d+ ventas?$/.test(button.textContent ?? ""))!
        const validation = dialog.querySelector("tbody tr td:last-child p, tbody tr td:last-child summary span")!
        scroller.scrollTop = scroller.scrollHeight
        const header = table.querySelector("th")!.getBoundingClientRect()
        const product = table.querySelector("tbody tr td:nth-child(6) span")!
        // Sin funciones con nombre: tsx inyecta __name, que no existe en la página.
        const [textareaLine, productLine, validationLine] = [textarea, product, validation].map((element) => parseFloat(getComputedStyle(element).lineHeight))
        return {
          modalWidth: Math.round(dialog.getBoundingClientRect().width),
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          dialogHorizontal: dialog.scrollWidth - dialog.clientWidth,
          dialogVertical: dialog.scrollHeight - dialog.clientHeight,
          tableHorizontal: scroller.scrollWidth - scroller.clientWidth,
          tableHeight: Math.round(scroller.clientHeight),
          tableScrolls: scroller.scrollTop > 0,
          headerPinned: Math.abs(header.top - scroller.getBoundingClientRect().top) < 2,
          // El tema fuerza un color de th semitransparente: la capa de imagen lo vuelve opaco.
          headerOpaque: /gradient\(rgb\(\d+, \d+, \d+\)/.test(getComputedStyle(table.querySelector("th")!).backgroundImage),
          footerVisible: footerButton.getBoundingClientRect().bottom <= window.innerHeight,
          textareaRows: (textarea.clientHeight - 24) / textareaLine,
          textareaScrolls: textarea.scrollHeight > textarea.clientHeight,
          modesBesideChips: Math.abs(modes.bottom - chips.bottom) < 24 && chips.left > modes.right,
          productLines: Math.round(product.getBoundingClientRect().height / productLine),
          validationLines: Math.round(validation.getBoundingClientRect().height / validationLine),
        }
      })
      assert.equal(metrics.pageOverflow, 0, `${at}: sin scroll horizontal de página`)
      assert.equal(metrics.dialogHorizontal, 0, `${at}: el modal no scrollea en horizontal`)
      assert.equal(metrics.headerPinned, true, `${at}: cabecera sticky`)
      assert.equal(metrics.headerOpaque, true, `${at}: la cabecera tapa las filas que pasan por debajo`)
      assert.equal(metrics.tableScrolls, true, `${at}: la tabla scrollea por dentro`)
      assert.equal(metrics.textareaScrolls, true, `${at}: el textarea scrollea por dentro`)
      assert.ok(metrics.productLines <= 2, `${at}: producto en máximo 2 líneas`)
      if (desktop) {
        assert.ok(metrics.modalWidth >= 1200 && metrics.modalWidth <= 1400, `${at}: modal ancho (${metrics.modalWidth}px)`)
        assert.ok(metrics.modalWidth <= viewport.width - 32, `${at}: respeta márgenes`)
        assert.equal(metrics.dialogVertical, 0, `${at}: el modal entra entero, sin scroll propio`)
        assert.equal(metrics.footerVisible, true, `${at}: footer visible`)
        assert.equal(metrics.tableHorizontal, 0, `${at}: la tabla entra completa`)
        assert.ok(metrics.tableHeight >= 190, `${at}: la tabla muestra varias filas (${metrics.tableHeight}px)`)
        assert.ok(metrics.textareaRows >= 4 && metrics.textareaRows <= 5.5, `${at}: textarea de 4–5 filas (${metrics.textareaRows.toFixed(1)})`)
        assert.equal(metrics.modesBesideChips, true, `${at}: Históricas/Nuevas y resumen en la misma franja`)
        assert.equal(metrics.validationLines, 1, `${at}: “SKU histórico sin vínculo” entra en una línea`)
      } else {
        assert.ok(metrics.tableHorizontal > 0, `${at}: en mobile la tabla scrollea en horizontal por dentro`)
      }
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  }
})
