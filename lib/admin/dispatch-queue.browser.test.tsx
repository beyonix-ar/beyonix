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

test("Despachos: tabla única, filtros y picking a 390/430/768/1024/1280/1440 px en light/dark", async () => {
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
  const table = renderToStaticMarkup(<DispatchRecordsTable rows={rows} selected={new Set()} onToggle={() => {}} onOpen={() => {}} />)
  const markup = `<div class="beyonix-admin-shell min-h-screen text-white"><main class="beyonix-admin-main bg-beyonix-page"><div class="dispatch-page">${shell}<div class="admin-ds-surface dispatch-surface">${table}</div><div class="dispatch-surface"><table class="dispatch-product-table"><tbody>${renderToStaticMarkup(<><ProductLine item={product} line={line} adjusted={false} /><ProductLine item={product} line={{ ...line, scanned_quantity: 2 }} adjusted={false} /></>)}</tbody></table></div><div class="dispatch-surface">${renderToStaticMarkup(<GeneralBundlePanel detail={bundle} {...bundleProps} />)}${renderToStaticMarkup(<GeneralBundlePanel detail={readyBundle} {...bundleProps} />)}</div></div></main></div>`
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    const badgeColors: Record<string, string[]> = {}
    // Columnas de datos equilibradas (sin hueco entre Usuario y Estado); Acciones angosta.
    const assertBalancedTable = async (label: string) => {
      const scroll = await page.locator(".dispatch-records-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      assert.ok(scroll, `${label}: la tabla entra completa`)
      const columns = await page.locator(".dispatch-records-table thead th").evaluateAll((cells) => cells.map((cell) => [cell.textContent ?? "", cell.getBoundingClientRect().width] as const))
      const data = columns.filter(([text]) => text && !/Seleccionar|Acciones/.test(text)).map(([, size]) => size)
      assert.equal(data.length, 7)
      assert.ok(Math.max(...data) - Math.min(...data) <= 1.5, `${label}: columnas parejas ${JSON.stringify(columns)}`)
      assert.ok(columns.at(-1)![1] <= 60 && columns.at(-1)![1] < Math.min(...data) / 2, `${label}: acciones compacta`)
      const clipped = await page.locator(".dispatch-record-row").first().evaluate((row) => [".dispatch-order-date", ".dispatch-state-badge", ".dispatch-order-total"].filter((selector) => {
        const cell = row.querySelector<HTMLElement>(selector)!.closest("td")!
        return cell.scrollWidth > cell.clientWidth + 1
      }))
      assert.deepEqual(clipped, [], `${label}: fecha, estado e importe sin recortar`)
    }
    for (const theme of ["light", "dark"]) for (const width of [390, 430, 768, 1024, 1280, 1440]) {
      const label = `${theme} ${width}`
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>${markup}</body></html>`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: la página no se ensancha`)
      const tableRows = page.locator(".dispatch-record-row")
      assert.equal(await tableRows.count(), 5)
      const first = tableRows.first()
      assert.match(await first.innerText(), /BX-1012[\s\S]*Pendiente[\s\S]*\$\s?50\.000/i)
      // Bulto: sólo su nombre y la cantidad de pedidos; pedido: sus unidades (siempre con su unidad).
      const bundleRow = tableRows.nth(2)
      assert.equal((await bundleRow.locator(".dispatch-record-batch").innerText()).trim(), "Bulto - 0002")
      assert.match((await bundleRow.locator(".dispatch-order-units").innerText()).trim(), /^10 pedidos$/)
      assert.match((await first.locator(".dispatch-order-units").innerText()).trim(), /^3 unidades$/)
      assert.match(await bundleRow.innerText(), /\$\s?100\.000/)
      // Sin Equipo: ni columna ni filtro.
      assert.equal(await page.locator(".dispatch-record-device, .dispatch-col-device, button[aria-label=EQUIPO]").count(), 0)
      assert.doesNotMatch(await page.locator(".dispatch-records-table").innerText(), /Equipo/i)
      // Mobile: prioriza fecha, Pedido/Bulto, estado e importe; sin "—".
      const visible = async (selector: string) => first.locator(selector).isVisible()
      for (const selector of [".dispatch-order-date", ".dispatch-record-order", ".dispatch-order-status", ".dispatch-order-total"]) assert.ok(await visible(selector), `${label}: ${selector}`)
      assert.equal(await visible(".dispatch-record-batch"), width >= 640, `${label}: "—" de Bulto sólo en tabla`)
      assert.equal(await page.locator(".dispatch-records-table thead").isVisible(), width >= 640)
      if (width < 640) {
        // El checkbox del confirmado no pisa su número.
        const [check, code] = await Promise.all([tableRows.nth(1).locator("input[type=checkbox]").boundingBox(), tableRows.nth(1).locator(".dispatch-record-order").boundingBox()])
        assert.ok(check && code && check.x + check.width <= code.x, `${label}: checkbox separado del número`)
      }
      // Filtros: Fecha | N° Pedido | N° Bulto | Usuario | Estado | Tipo | Limpiar, misma altura y texto centrado.
      const filters = ["input[aria-label=FECHA]", 'input[aria-label="N° PEDIDO"]', 'input[aria-label="N° BULTO"]', "button[aria-label=USUARIO]", "button[aria-label=ESTADO]", "button[aria-label=TIPO]", ".dispatch-filter-clear"]
      const boxes = await Promise.all(filters.map((selector) => page.locator(`.dispatch-filters ${selector}`).boundingBox()))
      assert.ok(boxes.every((box) => box && Math.abs(box.height - boxes[0]!.height) < 1), `${label}: altura uniforme (${boxes.map((box) => box?.height).join(", ")})`)
      const rowsOf = new Set(boxes.map((box) => Math.round(box!.y)))
      assert.equal(rowsOf.size, width >= 1024 ? 1 : width >= 640 ? 2 : 4, `${label}: filas de filtros`)
      const [tipoBox, clearBox, rowBox] = [boxes[5]!, boxes[6]!, (await page.locator(".dispatch-filter-row").boundingBox())!]
      assert.ok(Math.abs(tipoBox.y - clearBox.y) < 1, `${label}: Tipo y Limpiar en la misma fila`)
      assert.ok(tipoBox.width >= 60 && clearBox.x + clearBox.width <= rowBox.x + rowBox.width + 1, `${label}: Tipo legible y Limpiar dentro de la barra`)
      const row = await page.locator(".dispatch-filter-row").evaluate((element) => [element.scrollWidth, element.clientWidth])
      assert.ok(row[0] <= row[1] + 1, `${label}: ningún filtro queda escondido con scroll`)
      const tipoClipped = await page.locator(".dispatch-filters button[aria-label=TIPO] span.truncate").first().evaluate((element) => element.scrollWidth > element.clientWidth + 1)
      assert.equal(tipoClipped, false, `${label}: "TIPO" sin recortar`)
      const centers = await page.locator(".dispatch-filters").evaluate((element) => ["button[aria-label=USUARIO]", "button[aria-label=ESTADO]", "button[aria-label=TIPO]"].map((selector) => {
        const button = element.querySelector(selector)!.getBoundingClientRect(), text = element.querySelector(`${selector} span.truncate`)!.getBoundingClientRect()
        return [button.top + button.height / 2, text.top + text.height / 2]
      }))
      assert.ok(centers.every(([button, text]) => Math.abs(button - text) <= 1), `${label}: texto de los selects centrado (${JSON.stringify(centers)})`)
      if (width >= 1024) assert.ok(Math.abs(centers[0][0] - (boxes[1]!.y + boxes[1]!.height / 2)) <= 1, `${label}: selects e inputs en la misma línea`)
      if (width >= 1024) {
        await assertBalancedTable(label)
        // Unidades centradas e importe a la derecha; menú alineado en el centro de la fila.
        const align = await bundleRow.evaluate((element) => ["dispatch-order-units", "dispatch-order-total", "dispatch-actions-cell"].map((name) => getComputedStyle(element.querySelector(`.${name}`)!).textAlign))
        assert.deepEqual(align, ["center", "right", "center"])
        const [menuBox, rowBox] = await Promise.all([bundleRow.locator("button[aria-haspopup=menu]").boundingBox(), bundleRow.boundingBox()])
        assert.ok(menuBox && rowBox && Math.abs(menuBox.y + menuBox.height / 2 - (rowBox.y + rowBox.height / 2)) <= 1.5, `${label}: menú centrado`)
      }
      if (width === 768) assert.ok(await page.locator(".dispatch-records-scroll").evaluate((element) => getComputedStyle(element).overflowX === "auto"), `${label}: scroll interno sólo en la tabla`)
      const filterBackground = await page.locator(".dispatch-filter-row").evaluate((element) => getComputedStyle(element).backgroundColor)
      assert.equal(filterBackground, theme === "light" ? "rgb(238, 243, 248)" : "rgb(28, 41, 53)", `${label}: filtros azul/gris suave`)
      const color = await page.locator(".dispatch-record-order").first().evaluate((element) => getComputedStyle(element).color)
      assert.equal(color, theme === "light" ? "rgb(23, 36, 51)" : "rgb(248, 250, 252)")
      // Estados: sólo texto (sin letra), amarillo/verde/azul/rojo, legibles en cada tema.
      const states = await page.locator(".dispatch-state-badge").evaluateAll((badges) => badges.map((badge) => [badge.getAttribute("data-state") ?? "", getComputedStyle(badge).color, badge.textContent ?? ""]))
      assert.deepEqual(Object.fromEntries(states.map(([state, , text]) => [state, text])), { P: "Pendiente", C: "Confirmado", E: "Despachado", X: "Cancelado" })
      assert.equal(await page.locator(".dispatch-state-letter").count(), 0)
      badgeColors[label] = [...new Set(states.map(([, value]) => value))]
      assert.equal(badgeColors[label].length, 4, `${label}: cuatro colores distintos`)
      const hue = Object.fromEntries(states.map(([state, value]) => { const [red, green, blue] = channels(value); return [state, red > blue && green > blue && Math.abs(red - green) < 110 ? "amarillo" : green > red && green >= blue ? "verde" : blue > red && blue >= green ? "azul" : red > green && red > blue ? "rojo" : "otro"] }))
      assert.deepEqual(hue, { P: "amarillo", C: "verde", E: "azul", X: "rojo" }, `${label}: paleta ${JSON.stringify(states)}`)
      for (const target of [...["P", "C", "E", "X"].map((state) => page.locator(`.dispatch-state-badge[data-state="${state}"]`).first()), page.locator(".dispatch-record-row .dispatch-order-total").first()]) {
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
      assert.match(await problem.getByRole("alert").innerText(), /Hay pedidos que tenés que retirar antes de entregar este Bulto\./)
      assert.equal(await problem.getByRole("button", { name: "Retirar del Bulto" }).count(), 1)
      assert.match(await ready.innerText(), /1 de 1 pedidos · Bulto finalizado ✓/)
      if (width >= 1280) {
        // Con el menú lateral real del admin, el área de la tabla es más angosta.
        await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>${markup.replace('<main class="beyonix-admin-main', '<div class="hidden lg:block"><aside class="beyonix-admin-sidebar admin-ds-sidebar flex h-full flex-col border-r"></aside></div><main class="beyonix-admin-main min-w-0 flex-1').replace('beyonix-admin-shell min-h-screen text-white', 'beyonix-admin-shell min-h-screen text-white lg:flex')}</body></html>`)
        assert.ok(((await page.locator(".beyonix-admin-sidebar").boundingBox())?.width ?? 0) >= 250, `${label}: menú lateral visible`)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} con menú lateral: la página no se ensancha`)
        await assertBalancedTable(`${label} con menú lateral`)
      }
    }
    assert.notDeepEqual(badgeColors["light 1440"], badgeColors["dark 1440"], "cada tema usa su variante de la paleta")
  } finally { await browser.close() }
})
