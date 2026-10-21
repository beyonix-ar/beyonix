import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { chromium } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import type { BatchDispatchDetail } from "./dispatch"

const channels = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number)
const luminance = (rgb: number[]) => rgb.slice(0, 3).map((channel) => { const value = channel / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4 })
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
/** Contraste WCAG del texto contra el primer fondo opaco de sus ancestros. */
function contrast(color: string, backgrounds: string[]) {
  const background = backgrounds.map(channels).find((rgba) => (rgba[3] ?? 255) > 230) ?? [255, 255, 255]
  const [fore, back] = [luminance(channels(color)), luminance(background)]
  return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05)
}

test("Despachos: tablas, filtros y picking compactos a 390/430/1024/1440 px en light/dark", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-queue.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-queue-key"
  const { AdminDispatches, OrderQueueCard } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const { ProductLine } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  const { GeneralBundlePanel } = await import("../../app/admin/sections/despachos/general-bundle-panel")
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const base = { id: 6, created_at: "2026-10-16T15:32:00-03:00", cliente_nombre: "María José Peña", estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized", total: 50000, shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, andreani_envio_id: "ENV-6", andreani_tracking: "360000001006", andreani_creation_status: "created", package: { id: 6, order_id: 6, status: "prepared" as const, attempt_number: 1, prepared_at: "2026-10-16T15:30:00Z", prepared_by: null, identification_method: "andreani" as const }, membership: null, itemCount: 2, units: 3 }
  const product = { orderItemId: 1, sku: "MT01", productName: "Mate", variantName: "Negro", orderedQuantity: 2, unitPrice: 10000 }
  const line = { order_item_id: 1, expected_sku: "MT01", expected_barcode: "7790000000001", expected_quantity: 2, scanned_quantity: 1, product_id: 1, variant_id: 1, conditioned_stock_id: null, orderedQuantity: 2, unitPrice: 10000, name: "Mate · Negro" }
  const bundle: BatchDispatchDetail = {
    batch: { id: 8, code: "DSP-20261017-001", display_number: 1, status: "closed", created_at: "2026-10-17T12:00:00Z", closed_at: "2026-10-17T13:00:00Z", handed_over_at: null, handed_over_by: null },
    items: [{ id: 1, batch_id: 8, order_id: 6, package_id: 1, added_at: "2026-10-17T12:00:00Z", removed_at: null, blocked: true, blockReason: "Pedido cancelado", cancellationHold: true, labelCode: "360000001006", verified: true, verifiedAt: "2026-10-17T12:30:00Z", verificationMethod: "scanner", parcelCount: 1, parcels: [] }],
    blockedCount: 1, cancelledCount: 1, expectedCount: 1, verifiedCount: 1, missingCount: 0, verificationRequired: true, requiresRevalidation: false, parcelCount: 1, operatorName: null,
  }
  const readyBundle: BatchDispatchDetail = { ...bundle, items: bundle.items.map((item) => ({ ...item, blocked: false, blockReason: null, cancellationHold: false })), blockedCount: 0, cancelledCount: 0 }
  const bundleProps = { holds: [], liveUpdating: false, boardError: false, onChange: () => {}, onOpenResolution: () => {}, onRefresh: () => {} }
  const shell = renderToStaticMarkup(<AdminDispatches />)
  const markup = `<div class="beyonix-admin-shell min-h-screen text-white"><main class="beyonix-admin-main bg-beyonix-page">${shell}<div class="dispatch-surface"><table class="dispatch-orders-table"><tbody>${renderToStaticMarkup(<><OrderQueueCard item={{ ...base, package: null }} tab="armado" checked={false} onToggle={() => {}} onOpen={() => {}} /><OrderQueueCard item={base} tab="ready" checked={false} onToggle={() => {}} onOpen={() => {}} /></>)}</tbody></table><table class="dispatch-product-table"><tbody>${renderToStaticMarkup(<><ProductLine item={product} line={line} adjusted={false} /><ProductLine item={product} line={{ ...line, scanned_quantity: 2 }} adjusted={false} /></>)}</tbody></table></div><div class="dispatch-surface">${renderToStaticMarkup(<GeneralBundlePanel detail={bundle} {...bundleProps} />)}${renderToStaticMarkup(<GeneralBundlePanel detail={readyBundle} {...bundleProps} />)}</div></main></div>`
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    for (const theme of ["light", "dark"]) for (const width of [390, 430, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>${markup}</body></html>`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}: sin desborde`)
      assert.equal(await page.locator(".dispatch-order-row").count(), 2)
      assert.match(await page.locator(".dispatch-order-row").first().innerText(), /BX-1006[\s\S]*Pendiente[\s\S]*\$\s?50\.000/i)
      assert.match(await page.locator(".dispatch-order-row").last().innerText(), /Listo para Bulto/i)
      assert.equal(await page.locator(".dispatch-pick-count.is-missing").innerText(), "1/2")
      assert.equal(await page.locator(".dispatch-pick-count.is-complete").innerText(), "2/2")
      assert.match(await page.locator(".dispatch-product-row").first().innerText(), /\$\s?10\.000[\s\S]*\$\s?20\.000/)
      const color = await page.locator(".dispatch-order-code").first().evaluate((element) => getComputedStyle(element).color)
      assert.equal(color, theme === "light" ? "rgb(23, 36, 51)" : "rgb(248, 250, 252)")
      const pickingColor = await page.locator(".dispatch-pick-count.is-missing").evaluate((element) => getComputedStyle(element).color)
      assert.equal(pickingColor, theme === "light" ? "rgb(185, 28, 28)" : "rgb(252, 165, 165)")
      // Bulto con un pedido cancelado: alerta + pedido a retirar en la misma tarjeta; el resto queda oculto.
      const [problem, ready] = [page.locator('section[aria-label="Bulto - 0001"]').first(), page.locator('section[aria-label="Bulto - 0001"]').last()]
      assert.match(await problem.getByRole("alert").innerText(), /Sacá este pedido del Bulto para continuar\./)
      assert.match(await problem.innerText(), /BX-1006 · Cancelado/)
      assert.equal(await problem.getByRole("button", { name: "Retirar pedido" }).count(), 1)
      assert.equal(await problem.getByRole("button", { name: "Imprimir etiqueta" }).count(), 0, `${theme} ${width}: con problema no se imprime el DSP`)
      // Bulto cerrado y controlado: finalizado, con su etiqueta.
      assert.match(await ready.innerText(), /1 de 1 pedidos · Bulto finalizado ✓/)
      assert.equal(await ready.getByRole("button", { name: "Imprimir etiqueta" }).count(), 1)
      assert.equal(await ready.getByRole("alert").count(), 0)
      // Textos legibles en cada tema (WCAG AA) sobre el fondo real de la tarjeta.
      for (const target of [problem.getByRole("alert"), problem.locator("li span.font-bold").first(), ready.locator("p.font-bold")]) {
        // En el navegador sólo se leen colores (tsx agrega __name a funciones nombradas dentro de evaluate).
        const [color, ...backgrounds] = await target.evaluate((element) => {
          const values = [getComputedStyle(element).color]
          for (let node: Element | null = element; node; node = node.parentElement) values.push(getComputedStyle(node).backgroundColor)
          // Canvas normaliza oklch/lab/rgba a sRGB ("r,g,b,a" con a de 0 a 255).
          const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!
          return values.map((value) => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].join(",") })
        })
        const ratio = contrast(color, backgrounds)
        assert.ok(ratio >= 4.5, `${theme} ${width}: contraste ${ratio.toFixed(2)} (${color} sobre ${backgrounds.join(" | ")})`)
      }
      if (width >= 640) {
        // Pedido, Bulto, fecha y usuario en una sola fila.
        const boxes = await Promise.all(["NRO PEDIDO", "NRO BULTO", "FECHA", "USUARIO"].map((label) => page.locator(`.dispatch-filters input[aria-label="${label}"]`).boundingBox()))
        assert.ok(boxes.every((box) => box && boxes[0] && Math.abs(box.y - boxes[0].y) < 2), `${theme} ${width}: filtros alineados`)
      }
    }
  } finally { await browser.close() }
})
