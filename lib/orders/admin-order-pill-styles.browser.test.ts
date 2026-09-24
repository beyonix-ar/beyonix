import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import postcss from "postcss"
import tailwind from "@tailwindcss/postcss"
import { chromium } from "playwright-core"
import { renderToStaticMarkup } from "react-dom/server"
import { getOrderEyeBadge } from "./admin-order-eye-badge.test-helper.ts"

// Prueba aislada de cascada real: no inicia Next ni accede a pedidos o servicios.
const compiledCss = postcss([tailwind()]).process(readFileSync("app/globals.css", "utf8"), {
  from: "app/globals.css",
})

for (const theme of ["dark", "light"]) {
  test(`contador del ojo ${theme}: rojo y ámbar con contraste AA sin interferencia global`, async () => {
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
    })
    try {
      const page = await browser.newPage()
      await page.route("**/*", (route) => route.abort())
      const badges = [true, false].map((urgent) => renderToStaticMarkup(getOrderEyeBadge([
        { kind: "invoice", label: "Emitir factura", urgent: false },
        { kind: "claim", label: "Revisar acción", urgent },
      ]))).join("")
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${(await compiledCss).css}</style></head><body>
        <div class="beyonix-admin-shell"><main class="beyonix-admin-main">
          <article class="admin-orders-list-row rounded-2xl border border-white/8 bg-zinc-900/75">
            <span class="relative inline-flex">
              <button class="admin-orders-action-button flex size-8 cursor-pointer items-center justify-center rounded-lg border text-white/68 transition-colors hover:text-beyonix-sky" aria-label="Ver pedido">Ver</button>
              ${badges}
            </span>
          </article>
        </main></div></body></html>`)
      const styles = await page.locator(".admin-order-eye-attention-badge").evaluateAll((elements) => elements.map((element) => {
        const style = getComputedStyle(element)
        return {
          background: style.backgroundColor, color: style.color, border: style.borderColor,
          width: style.borderWidth, radius: style.borderRadius, count: element.textContent,
          exposed: element.matches('.beyonix-admin-main :where(span, button):not([style*="background"])[class*="rounded-full"][class*="border"]'),
        }
      }))
      assert.equal(styles.length, 2)
      assert.deepEqual(styles.map((style) => style.background), ["rgb(220, 38, 38)", "rgb(251, 191, 36)"])
      assert.deepEqual(styles.map((style) => style.color), ["rgb(255, 255, 255)", "rgb(58, 37, 4)"])
      assert.deepEqual(styles.map((style) => style.border), ["rgba(252, 165, 165, 0.6)", "rgba(253, 230, 138, 0.6)"])
      for (const style of styles) {
        assert.equal(style.exposed, false)
        assert.equal(style.count, "2")
        assert.equal(style.width, "1px")
        assert.equal(style.radius, "9999px")
        const luminance = (color: string) => {
          const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map((value) => {
            const channel = Number(value) / 255
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
          })
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
        }
        const values = [luminance(style.color), luminance(style.background)].sort((a, b) => b - a)
        assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 4.5)
      }
    } finally {
      await browser.close()
    }
  })

  test(`cascada ${theme}: estado, despacho y pills conservan sus tonos`, async () => {
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
    })
    try {
      const page = await browser.newPage()
      await page.route("**/*", (route) => route.abort())
      const tones = ["danger", "success", "warning", "info", "muted"]
      const badges = tones.map((tone) => `<span class="admin-order-pill admin-order-tone-${tone}">Estado</span>`).join("")
      const dispatch = tones.map((tone) => `<span class="admin-order-dispatch-badge admin-order-tone-${tone}">Despacho</span>`).join("")
      const summary = tones.map((tone) => `<span class="admin-order-status-badge admin-order-status-badge-${tone === "muted" ? "neutral" : tone}">Resumen</span>`).join("")
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${(await compiledCss).css}</style></head><body>
        <div class="beyonix-admin-shell"><main class="beyonix-admin-main">
          <section class="admin-order-detail-scope">${badges}${dispatch}${summary}</section>
          <article class="admin-orders-list-row rounded-2xl border border-white/8 bg-zinc-900/75">
            ${badges}${dispatch}<span class="admin-order-pill admin-order-pending-claim-badge">Reclamo pendiente</span>
            <span class="admin-order-pill admin-order-shipping-reminder">Despacho pendiente</span>
          </article>
        </main></div></body></html>`)
      for (const scope of [".admin-order-detail-scope", ".admin-orders-list-row"]) {
        for (const kind of [".admin-order-pill", ".admin-order-dispatch-badge"]) {
          const styles = await page.locator(`${scope} ${kind}`).evaluateAll((elements) => elements.map((element) => {
            const style = getComputedStyle(element)
            return {
              color: style.color, background: style.backgroundColor, border: style.borderColor,
              width: style.borderWidth, radius: style.borderRadius,
              exposed: element.matches('[class*="rounded-full"][class*="border"]'),
            }
          }))
          assert.equal(new Set(styles.slice(0, 5).map((style) => style.color)).size, 5)
          assert.equal(new Set(styles.slice(0, 5).map((style) => style.background)).size, 5)
          assert.equal(new Set(styles.slice(0, 5).map((style) => style.border)).size, 5)
          for (const style of styles) {
            assert.equal(style.exposed, false)
            assert.equal(style.width, "1px")
            assert.equal(style.radius, "9999px")
          }
        }
      }
      const summaryColors = await page.locator(".admin-order-status-badge").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color))
      assert.equal(new Set(summaryColors).size, 5)
      assert.equal(await page.locator(".admin-order-pending-claim-badge").evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(127, 29, 29, 0.72)")
      const reminder = page.locator(".admin-order-shipping-reminder")
      const before = await reminder.evaluate((element) => getComputedStyle(element).borderColor)
      await reminder.hover()
      assert.notEqual(await reminder.evaluate((element) => getComputedStyle(element).borderColor), before)
    } finally {
      await browser.close()
    }
  })
}
