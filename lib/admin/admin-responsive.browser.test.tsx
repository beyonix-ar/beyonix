import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { chromium } from "playwright-core"
import { AdminResponsiveTable } from "../../app/admin/components/admin-responsive-table"

test("notebook/celular: tablas operativas reales se convierten en tarjetas sin perder columnas", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    await page.route("**/*", (route) => route.abort())
    const labels = ["Fecha", "Producto", "SKU", "Costo", "Cantidad", "Precio", "Envío", "Comisión", "Otros gastos", "Medio de pago", "Referencia", "Cliente", "Notas", "Total", "Ganancia", "Acciones"]
    const markup = renderToStaticMarkup(<main>{[labels, labels.slice(0, 14), labels.slice(0, 9)].map((columns, index) => <section key={index}><AdminResponsiveTable labels={columns}><table style={{ minWidth: 1980 }}><thead><tr>{columns.map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody><tr>{columns.map((label) => <td key={label}>{label === "Acciones" ? <button>Revisar operación</button> : `${label}: información completa del artículo Ñandú`}</td>)}</tr></tbody></table></AdminResponsiveTable></section>)}</main>)
    for (const width of [1366, 1024, 390]) {
      await page.setViewportSize({ width, height: 768 })
      await page.setContent(`<html><head><style>body { margin: 0; } main { padding: 16px; } * { box-sizing: border-box; }</style></head><body>${markup}</body></html>`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `overflow con ancho ${width}`)
      assert.equal(await page.locator("tbody td").count(), 39)
      assert.equal(await page.locator("tbody tr").first().evaluate((row) => getComputedStyle(row).display), "grid")
      assert.equal(await page.locator("tbody td").first().evaluate((cell) => getComputedStyle(cell, "::before").content), '"Fecha"')
    }
    // The product layout already has responsive cards; verify its real stylesheet.
    const css = readFileSync("app/globals.css", "utf8")
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.setContent(`<html><head><style>${css}</style><style>body {margin:0} * {box-sizing:border-box}</style></head><body><main class="beyonix-admin-main"><div class="admin-products-table"><div class="admin-products-table-header">Encabezado</div><div class="admin-product-row"><div class="admin-product-row-grid" style="display:grid;min-width:1600px"><div>Producto con nombre extenso</div><span data-label="SKU">SKU-1</span><span data-label="Cantidad">5</span><span data-label="Precio">50000</span><button data-label="Estado">Activo</button><div class="admin-product-actions"><button>Editar</button></div></div></div></div></main></body></html>`)
    assert.equal(await page.locator(".admin-products-table-header").isVisible(), false)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  } finally { await browser.close() }
})
