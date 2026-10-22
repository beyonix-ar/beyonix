import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { chromium } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import type { BatchDispatchDetail } from "./dispatch"
import type { DispatchRecord } from "./dispatch-records"

const channels = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number)
const luminance = (rgb: number[]) => rgb.slice(0, 3).map((channel) => { const value = channel / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4 })
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
/** Contraste WCAG del texto contra el primer fondo opaco de sus ancestros. */
function contrast(color: string, backgrounds: string[]) {
  const background = backgrounds.map(channels).find((rgba) => (rgba[3] ?? 255) > 230) ?? [255, 255, 255]
  const [fore, back] = [luminance(channels(color)), luminance(background)]
  return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05)
}

const record = (value: Partial<DispatchRecord> & Pick<DispatchRecord, "kind" | "id" | "state">): DispatchRecord =>
  ({ code: null, displayNumber: null, at: "2026-10-22T16:54:00Z", actorId: "u", actorName: "María José Peña", units: 3, total: 50000, orderCount: 1, selectable: false, ...value })

test("Despachos: tabla única, filtros y picking a 390/430/768/1024/1440 px en light/dark", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-queue.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-queue-key"
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const { DispatchRecordsTable } = await import("../../app/admin/sections/despachos/dispatch-records-table")
  const { ProductLine } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  const { GeneralBundlePanel } = await import("../../app/admin/sections/despachos/general-bundle-panel")
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const rows = [
    record({ kind: "order", id: 12, state: "P" }),
    record({ kind: "order", id: 7, state: "C", selectable: true, total: 20000 }),
    record({ kind: "batch", id: 2, displayNumber: 2, state: "P", orderCount: 10, units: 30, total: 100000 }),
    record({ kind: "batch", id: 3, displayNumber: 3, state: "E", orderCount: 2, units: 7, total: 10000 }),
    record({ kind: "order", id: 30, state: "X", actorName: null }),
  ]
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
  const table = renderToStaticMarkup(<DispatchRecordsTable rows={rows} cancelledByBatch={new Map([[2, 1]])} selected={new Set()} onToggle={() => {}} onOpen={() => {}} />)
  const markup = `<div class="beyonix-admin-shell min-h-screen text-white"><main class="beyonix-admin-main bg-beyonix-page"><div class="dispatch-page">${shell}<div class="admin-ds-surface dispatch-surface">${table}</div><div class="dispatch-surface"><table class="dispatch-product-table"><tbody>${renderToStaticMarkup(<><ProductLine item={product} line={line} adjusted={false} /><ProductLine item={product} line={{ ...line, scanned_quantity: 2 }} adjusted={false} /></>)}</tbody></table></div><div class="dispatch-surface">${renderToStaticMarkup(<GeneralBundlePanel detail={bundle} {...bundleProps} />)}${renderToStaticMarkup(<GeneralBundlePanel detail={readyBundle} {...bundleProps} />)}</div></div></main></div>`
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    const badgeColors: Record<string, string[]> = {}
    for (const theme of ["light", "dark"]) for (const width of [390, 430, 768, 1024, 1440]) {
      const label = `${theme} ${width}`
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>${markup}</body></html>`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: la página no se ensancha`)
      const tableRows = page.locator(".dispatch-record-row")
      assert.equal(await tableRows.count(), 5)
      const first = tableRows.first()
      assert.match(await first.innerText(), /BX-1012[\s\S]*Pendiente[\s\S]*\$\s?50\.000/i)
      assert.match(await tableRows.nth(2).innerText(), /Bulto - 0002[\s\S]*10 pedidos[\s\S]*1 pedido cancelado[\s\S]*\$\s?100\.000/i)
      // Mobile: prioriza fecha, Pedido/Bulto, estado e importe; sin "—" ni Equipo.
      const visible = async (selector: string) => first.locator(selector).isVisible()
      for (const selector of [".dispatch-order-date", ".dispatch-record-order", ".dispatch-order-status", ".dispatch-order-total"]) assert.ok(await visible(selector), `${label}: ${selector}`)
      assert.equal(await visible(".dispatch-record-batch"), width >= 640, `${label}: "—" de Bulto sólo en tabla`)
      assert.equal(await visible(".dispatch-record-device"), width >= 640, `${label}: Equipo es secundario`)
      assert.equal(await page.locator(".dispatch-records-table thead").isVisible(), width >= 640)
      if (width >= 1024) {
        const scroll = await page.locator(".dispatch-records-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
        assert.ok(scroll, `${label}: la tabla entra completa`)
        // Siete filtros en una sola fila.
        const boxes = await Promise.all(["input[aria-label=FECHA]", 'input[aria-label="N° PEDIDO"]', 'input[aria-label="N° BULTO"]', "button[aria-label=USUARIO]", "button[aria-label=EQUIPO]", "button[aria-label=ESTADO]", ".dispatch-filter-clear"].map((selector) => page.locator(`.dispatch-filters ${selector}`).boundingBox()))
        assert.ok(boxes.every((box) => box && boxes[0] && Math.abs(box.y - boxes[0].y) < 3), `${label}: filtros alineados`)
      }
      if (width === 768) assert.ok(await page.locator(".dispatch-records-scroll").evaluate((element) => getComputedStyle(element).overflowX === "auto"), `${label}: scroll interno sólo en la tabla`)
      const filterBackground = await page.locator(".dispatch-filter-row").evaluate((element) => getComputedStyle(element).backgroundColor)
      assert.equal(filterBackground, theme === "light" ? "rgb(238, 243, 248)" : "rgb(28, 41, 53)", `${label}: filtros azul/gris suave`)
      const color = await page.locator(".dispatch-record-order").first().evaluate((element) => getComputedStyle(element).color)
      assert.equal(color, theme === "light" ? "rgb(23, 36, 51)" : "rgb(248, 250, 252)")
      // Estados: una tonalidad por letra, legible en cada tema.
      const states = await page.locator(".dispatch-state-badge").evaluateAll((badges) => badges.map((badge) => [badge.getAttribute("data-state"), getComputedStyle(badge).color]))
      badgeColors[label] = [...new Set(states.map(([, value]) => value as string))]
      assert.equal(badgeColors[label].length, 4, `${label}: P, C, E y X con colores distintos`)
      for (const target of [page.locator(".dispatch-state-badge").first(), page.locator(".dispatch-record-row .dispatch-order-total").first(), page.locator(".dispatch-record-alert")]) {
        const [fore, ...backgrounds] = await target.evaluate((element) => {
          const values = [getComputedStyle(element).color]
          for (let node: Element | null = element; node; node = node.parentElement) values.push(getComputedStyle(node).backgroundColor)
          const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!
          return values.map((value) => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].join(",") })
        })
        const ratio = contrast(fore, backgrounds)
        assert.ok(ratio >= 4.5, `${label}: contraste ${ratio.toFixed(2)} (${fore} sobre ${backgrounds.join(" | ")})`)
      }
      assert.equal(await page.locator(".dispatch-pick-count.is-missing").innerText(), "1/2")
      assert.equal(await page.locator(".dispatch-pick-count.is-complete").innerText(), "2/2")
      const [problem, ready] = [page.locator('section[aria-label="Bulto - 0001"]').first(), page.locator('section[aria-label="Bulto - 0001"]').last()]
      assert.match(await problem.getByRole("alert").innerText(), /Sacá este pedido del Bulto para continuar\./)
      assert.equal(await problem.getByRole("button", { name: "Retirar pedido" }).count(), 1)
      assert.match(await ready.innerText(), /1 de 1 pedidos · Bulto finalizado ✓/)
    }
    assert.notDeepEqual(badgeColors["light 1440"], badgeColors["dark 1440"], "cada tema usa su variante de la paleta")
  } finally { await browser.close() }
})
