import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { chromium, type Browser } from "playwright-core"

import { Button } from "@/components/ui/button"
import { cartCheckoutButtonState } from "./cart-checkout-button"

// "Finalizar compra" del carrito con el Button real, las MISMAS props que usa
// CartSummary y el CSS compilado del proyecto (Tailwind incluido), medido en
// Edge/Chrome: deshabilitado sigue sin clicks pero el texto se lee en Light y
// Dark; habilitado no cambia.

let browser: Browser
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })])
    .process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

const button = (blocked: boolean) =>
  renderToStaticMarkup(createElement(Button, { type: "button", size: "lg", ...cartCheckoutButtonState(blocked) }, "Finalizar compra"))

async function measure(theme: "light" | "dark", blocked: boolean) {
  const page = await browser.newPage()
  try {
    await page.route("**/*", (route) => route.abort())
    await page.setContent(`<!doctype html>
<html data-account-theme="${theme}" data-account-scope="tienda"><head><style>${css}</style></head>
<body><div class="beyonix-cart-summary bx-surface bx-surface-card" style="padding:16px;width:360px">${button(blocked)}</div></body></html>`)
    // String (no función): tsx inyecta helpers que no existen en el navegador.
    return (await page.evaluate(`(() => {
      const element = document.querySelector("button")
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const context = canvas.getContext("2d", { willReadFrequently: true })
      const rgba = (value) => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = value
        context.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
        return [r, g, b, a / 255]
      }
      const channel = (value) => {
        const scaled = value / 255
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
      }
      const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
      const over = (top, bottom) => top.slice(0, 3).map((value, index) => value * top[3] + bottom[index] * (1 - top[3]))
      // Fondo efectivo: el del botón sobre el del panel.
      const style = getComputedStyle(element)
      const panelColor = rgba(getComputedStyle(element.parentElement).backgroundColor)
      const panel = panelColor[3] ? panelColor : [255, 255, 255, 1]
      const background = over(rgba(style.backgroundColor), panel)
      const text = over(rgba(style.color), background)
      // La opacidad del botón apaga texto y fondo a la vez sobre el panel.
      const opacity = Number(style.opacity)
      const shown = (color) => color.map((value, index) => value * opacity + panel[index] * (1 - opacity))
      const [a, b] = [luminance(shown(text)), luminance(shown(background))].sort((x, y) => y - x)
      return {
        disabled: element.disabled,
        pointerEvents: style.pointerEvents,
        background: style.backgroundColor,
        contrast: (a + 0.05) / (b + 0.05),
      }
    })()`)) as { disabled: boolean; pointerEvents: string; background: string; contrast: number }
  } finally {
    await page.close()
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: deshabilitado sigue sin clicks, se ve inactivo y el texto se lee`, async () => {
    const disabled = await measure(theme, true)
    const enabled = await measure(theme, false)
    assert.equal(disabled.disabled, true)
    assert.equal(disabled.pointerEvents, "none", "no clickeable")
    assert.ok(disabled.contrast >= 7, `texto legible (${disabled.contrast.toFixed(2)}:1)`)
    assert.notEqual(disabled.background, enabled.background, "se distingue del botón habilitado")
    assert.equal(enabled.disabled, false)
    assert.equal(enabled.background, "rgb(17, 42, 67)", "habilitado sigue navy")
    assert.ok(enabled.contrast >= 7, `habilitado legible (${enabled.contrast.toFixed(2)}:1)`)
  })
}
