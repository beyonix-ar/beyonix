import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import postcss from "postcss"
import tailwind from "@tailwindcss/postcss"
import { chromium, type Browser, type Page } from "playwright-core"
import { renderToStaticMarkup } from "react-dom/server"

import { OrderPendingActionChips } from "../../app/admin/sections/pedidos/order-pending-actions"
import { getAdminPendingOrderActions } from "../orders/admin-pending-actions"

// Etiquetas de acciones humanas en la fila real del listado: CSS compilado
// del proyecto, Light/Dark, escritorio (2 etiquetas + resumen) y teléfono (1).
const compiledCss = postcss([tailwind()]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })

const actions = getAdminPendingOrderActions({
  id: 31,
  estado: "cancelado",
  financial_status: "refund_pending",
  payment_method_id: "transferencia",
  payment_status: "confirmado",
  paid_at: "2026-10-05T10:00:00Z",
  payment_confirmed_amount: 1000,
  total: 1000,
  order_claims: [{ id: 1, admin_needs_action: true }],
  return_status: "solicitada",
  admin_pending_facts: {
    financial: { mode: "resolution", resolutionStatus: "manual_pending", hasOptions: false },
    dispatch: { batchId: 7, batchStatus: "closed", packageStatus: "prepared", blocked: true },
  },
})

type Rgba = [number, number, number, number]
const parse = (value: string): Rgba => {
  const match = value.match(/rgba?\(([^)]+)\)/)
  assert.ok(match, `color no RGB: ${value}`)
  const [r, g, b, a = "1"] = match[1].split(",").map((part) => part.trim())
  return [Number(r), Number(g), Number(b), Number(a)]
}
const luminance = ([r, g, b]: Rgba) => [r, g, b].map((value) => {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
const contrast = (a: Rgba, b: Rgba) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}
const over = (top: Rgba, bottom: Rgba): Rgba => [0, 1, 2].map((index) =>
  Math.round(top[index] * top[3] + bottom[index] * (1 - top[3]))).concat(1) as Rgba

let browser: Browser
let css: string

test.before(async () => {
  css = (await compiledCss).css
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})
test.after(async () => { await browser?.close() })

async function mount(theme: "dark" | "light", width: number, visible: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 700 } })
  await page.route("**/*", (route) => route.abort())
  await page.setContent(`<html data-admin-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>
    <div class="beyonix-admin-shell"><main class="beyonix-admin-main" style="padding:16px">
      <article class="admin-orders-list-row min-w-0 overflow-hidden rounded-2xl border border-white/8 bg-zinc-900/75 p-4">
        <p>#BX-1031</p>
        ${renderToStaticMarkup(<OrderPendingActionChips actions={actions} visible={visible} />)}
      </article>
    </main></div></body></html>`)
  return page
}

for (const theme of ["dark", "light"] as const) {
  test(`K. ${theme}: etiquetas legibles sobre la fila, prioridad 1 en rojo`, async () => {
    const page = await mount(theme, 1440, 2)
    try {
      assert.deepEqual(actions.map((action) => action.label),
        ["Retirar del despacho", "Registrar reintegro", "Resolver reclamo", "Revisar devolución"])
      const chips = await page.locator(".admin-order-action-chip").evaluateAll((elements) => elements.map((element) => {
        const style = getComputedStyle(element)
        const row = getComputedStyle(element.closest(".admin-orders-list-row")!)
        return { text: element.textContent, tag: element.tagName, href: element.getAttribute("href"), color: style.color,
          background: style.backgroundColor, row: row.backgroundColor, rowImage: row.backgroundImage, height: element.getBoundingClientRect().height }
      }))
      assert.deepEqual(chips.map((chip) => [chip.text, chip.tag, chip.href]), [
        ["Retirar del despacho", "A", "/admin/despachos?batch=7"],
        ["Registrar reintegro", "A", "/admin/pedidos/31?tab=cancelacion"],
        ["+2 pendientes", "SPAN", null],
      ])
      for (const chip of chips) {
        const rowColor = parse(chip.row)[3] === 1 ? parse(chip.row) : parse(chip.rowImage.match(/rgba?\([^)]+\)/)?.[0] ?? "rgb(0, 0, 0)")
        const background = over(parse(chip.background), [rowColor[0], rowColor[1], rowColor[2], 1])
        assert.ok(contrast(parse(chip.color), background) >= 4.5, `${theme} ${chip.text}: contraste ${contrast(parse(chip.color), background).toFixed(2)}`)
        assert.ok(chip.height <= 24, `${chip.text}: etiqueta compacta (${chip.height}px)`)
      }
      assert.notEqual(chips[0].color, chips[2].color, "la prioridad se distingue del resumen")
    } finally { await page.close() }
  })

  test(`J. ${theme}: teléfono compacto, una etiqueta y sin desbordar la fila`, async () => {
    const page = await mount(theme, 375, 1)
    try {
      assert.deepEqual(await page.locator(".admin-order-action-chip").allTextContents(), ["Retirar del despacho", "+3 pendientes"])
      const overflow = await page.locator(".admin-orders-list-row").evaluate((row) => {
        const right = row.getBoundingClientRect().right
        return Math.max(row.scrollWidth - row.clientWidth, ...[...row.querySelectorAll(".admin-order-action-chip")].map((chip) => chip.getBoundingClientRect().right - right))
      })
      assert.ok(overflow <= 0, `desborde ${overflow}px`)
      const rowHeight = await page.locator("[data-testid='order-pending-actions']").evaluate((element) => element.getBoundingClientRect().height)
      assert.ok(rowHeight <= 26, `una sola línea (${rowHeight}px)`)
    } finally { await page.close() }
  })
}
