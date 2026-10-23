import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { chromium } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

import { CancellationJourneyPanel } from "../../app/admin/sections/pedidos/cancellation-journey-panel"
import type { CancellationJourneyOrder } from "../orders/cancellation-journey"

// T/U/V: asistente de cancelación con globals.css real, en teléfono y
// escritorio, Light y Dark: paso actual legible, acción visible y sin
// scroll horizontal.


const order: CancellationJourneyOrder = {
  id: 32, estado: "cancelado", financial_status: "refund_pending", payment_method_id: "mercadopago", payment_status: "approved",
  paid_at: "2026-10-22T10:00:00Z", payment_confirmed_amount: 899, total: 899, invoice_status: "authorized", invoice_cae: "CAE-1",
  credit_note_required: true, order_credit_notes: [], mercadopago_order_refunds: [], cancelled_at: "2026-10-22T11:00:00Z",
  admin_pending_facts: { financial: { mode: "none", resolutionStatus: null, hasOptions: false },
    dispatch: { batchId: 41, batchNumber: 8, batchStatus: "closed", packageStatus: "prepared", blocked: true, physicalHold: true, manualRefundRequired: true } },
}

type Rgba = [number, number, number, number]
const parse = (value: string): Rgba => {
  const match = value.match(/rgba?\(([^)]+)\)/)
  assert.ok(match, `color no RGB: ${value}`)
  const [r, g, b, a = "1"] = match[1].split(",").map((part) => part.trim())
  return [Number(r), Number(g), Number(b), Number(a)]
}
const luminance = ([r, g, b]: Rgba) => {
  const channel = (value: number) => { const scaled = value / 255; return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
const contrast = (a: Rgba, b: Rgba) => { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (light + 0.05) / (dark + 0.05) }

test("asistente de cancelación: teléfono y escritorio, Light/Dark, paso actual legible y sin desborde", async () => {
  // globals.css con Tailwind compilado: mismas utilidades que el panel en producción.
  const globalsCss = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const full = renderToStaticMarkup(<CancellationJourneyPanel pedido={order} compact={false} onOpen={() => {}} />)
  const compact = renderToStaticMarkup(<CancellationJourneyPanel pedido={order} compact onOpen={() => {}} />)
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    for (const theme of ["light", "dark"] as const) for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<!doctype html><html data-admin-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${globalsCss}</style></head>
        <body><div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div class="admin-order-detail-scope"><div class="admin-order-detail-content">${compact}${full}</div></div></main></div></body></html>`)
      const label = `${theme} ${width}px`
      // Mismo criterio que el wizard: el contenedor del detalle es del arnés; se mide que cada panel no desborde su propio ancho.
      for (const selector of ["[data-testid='cancellation-journey']", "[data-testid='cancellation-journey-compact']"]) {
        const overflow = await page.locator(selector).evaluate((panel) => {
          const right = panel.getBoundingClientRect().right
          const widest = Math.max(...[...panel.querySelectorAll("*")].map((child) => child.getBoundingClientRect().right))
          return Math.max(panel.scrollWidth - panel.clientWidth, widest - right)
        })
        assert.ok(overflow <= 1, `${label}: desborde horizontal de ${selector} (${overflow}px)`)
      }
      assert.equal(await page.locator("[data-testid='cancellation-journey'] ol li").count(), 6, label)
      const current = page.locator("[data-testid='cancellation-journey'] li.is-current")
      assert.equal(await current.innerText(), "2\nMercadería", label)
      const [color, background] = await current.evaluate((element) => [getComputedStyle(element).color, getComputedStyle(element).backgroundColor])
      assert.equal(parse(background)[3], 1, `${label}: el paso actual no puede ser transparente`)
      assert.ok(contrast(parse(color), parse(background)) >= 4.5, `${label}: contraste del paso actual ${color} / ${background}`)
      const journeyText = await page.locator("[data-testid='cancellation-journey']").innerText()
      assert.match(journeyText, /Bulto 0008: retiralo antes de entregarlo/)
      assert.doesNotMatch(journeyText, /Continuá abajo/, "sin bloques que sólo ocupan espacio")
      // El texto del paso sobre la superficie del panel también se lee.
      const [detailColor, panelBackground] = await page.locator("[data-testid='cancellation-journey']").evaluate((panel) => {
        const detail = panel.querySelector("[data-step] p")!
        // Primer fondo opaco hacia arriba (las capas transparentes no cuentan).
        let node: Element | null = detail
        while (node && /rgba\([^)]*,\s*0\)$|transparent/.test(getComputedStyle(node).backgroundColor)) node = node.parentElement
        return [getComputedStyle(detail).color, node ? getComputedStyle(node).backgroundColor : "rgb(255, 255, 255)"]
      })
      assert.ok(contrast(parse(detailColor), parse(panelBackground)) >= 4.5, `${label}: contraste del detalle ${detailColor} / ${panelBackground}`)
      const action = page.getByRole("link", { name: /Resolver mercadería/ })
      assert.ok(await action.isVisible(), `${label}: acción visible`)
      assert.equal(await action.getAttribute("href"), "/admin/despachos?resolve=32&return=%2Fadmin%2Fpedidos%2F32%3Ftab%3Dcancelacion")
      assert.match(await page.locator("[data-testid='cancellation-journey-compact']").innerText(), /Paso 2 de 6: Mercadería/)
      if (process.env.CANCELLATION_JOURNEY_SCREENSHOTS) await page.screenshot({ path: `${process.env.CANCELLATION_JOURNEY_SCREENSHOTS}/journey-${theme}-${width}.png`, fullPage: true })
    }
  } finally { await browser.close() }
})
