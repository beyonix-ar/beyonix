import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

const ENTRY = `
import { createElement as h, useState } from "react"
import { createRoot } from "react-dom/client"
import { CreditCard, Landmark, Wallet } from "lucide-react"
import { CheckoutPaymentMediaPanel, CheckoutPaymentOptionCard } from "@/components/checkout/checkout-payment-media-panel"

function Fixture() {
  const [option, setOption] = useState("mercadopago_cash")
  const [policy, setPolicy] = useState("same")
  const [brands, setBrands] = useState(["visa", "master"])
  return h("div", { className: "checkout-page", "data-checkout-step": "3" },
    h("main", { className: "checkout-main-panel", style: { maxWidth: 760, margin: "24px auto", padding: 20 } },
      h("h2", { style: { marginBottom: 16 } }, "Método de pago"),
      h("div", { className: "checkout-payment-layout grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]" },
        h("fieldset", { className: "grid gap-2 min-w-0", "data-payment-options": true },
          h(CheckoutPaymentOptionCard, { option: "transferencia", checked: option === "transferencia", onSelect: setOption, icon: Landmark, title: "Transferencia bancaria", description: "Datos bancarios al confirmar", badge: h("span", { className: "checkout-badge checkout-badge-success" }, "10% OFF"), amountLabel: "Total transferencia", amount: option === "transferencia" ? "$90.000" : undefined }),
          h(CheckoutPaymentOptionCard, { option: "mercadopago_cash", checked: option === "mercadopago_cash", onSelect: setOption, icon: Wallet, title: "Mercado Pago · 1 pago", description: "Precio contado", amountLabel: "Total", amount: "$100.000" }),
          h(CheckoutPaymentOptionCard, { option: "mercadopago_installments", checked: option === "mercadopago_installments", onSelect: setOption, icon: CreditCard, title: "Mercado Pago · Cuotas sin interés", description: "Hasta 6 cuotas sin interés", amountLabel: "Total financiado", amount: policy === "same" ? "$100.000" : "$118.000" }),
        ),
        h(CheckoutPaymentMediaPanel, { option, installmentBrands: brands }),
      ),
      h("div", { style: { marginTop: 16 } },
        h("button", { type: "button", "data-policy": "same", onClick: () => setPolicy("same") }, "Mismo precio que contado"),
        h("button", { type: "button", "data-policy": "cover", onClick: () => setPolicy("cover") }, "Cubrir costos de Mercado Pago"),
        h("button", { type: "button", "data-brands": "none", onClick: () => setBrands([]) }, "Sin marcas confirmadas"),
      ),
    ),
  )
}
createRoot(document.getElementById("root")).render(h(Fixture))
`

const html = (theme: string, css: string, bundle: string) => `<!doctype html><html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-beyonix-page"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script>${bundle}</script></body></html>`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "checkout-payment-fixture.tsx" },
    bundle: true,
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
    plugins: [{
      name: "browser-image",
      setup(buildContext) {
        buildContext.onResolve({ filter: /^next\/image$/ }, () => ({ path: "next/image", namespace: "browser-image" }))
        buildContext.onLoad({ filter: /.*/, namespace: "browser-image" }, () => ({ contents: 'import React from "react"; export default function Image(props) { return React.createElement("img", props) }', loader: "js", resolveDir: process.cwd() }))
      },
    }],
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(theme: "light" | "dark", width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html(theme, css, bundle) })
    if (/^\/payment-methods\/[a-z]+\.svg$/.test(url.pathname)) {
      return route.fulfill({ contentType: "image/svg+xml", body: readFileSync(`public${url.pathname}`) })
    }
    return route.abort()
  })
  await page.goto("http://checkout-payment.test/")
  try { await page.waitForSelector("[data-payment-media=mercadopago_cash]", { timeout: 10_000 }) }
  catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return page
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 768, 390]) {
    test(`${theme} ${width}px: tres opciones, logos, selección y panel sin overflow`, async () => {
      const page = await open(theme, width)
      try {
        const cards = page.locator("[data-payment-options] [data-payment-option]")
        assert.equal(await cards.count(), 3)
        assert.equal(await page.locator('[data-payment-option="mercadopago_installments"]').count(), 1)
        assert.equal(await page.locator("[data-payment-options] input:checked").count(), 1)
        assert.equal(await page.locator("[data-payment-media=mercadopago_cash] [data-media-group]").count(), 3)
        assert.equal(await page.locator('[data-media-brand="American Express"]').count(), 1)
        assert.equal(await page.locator("[data-payment-media] img").count(), 6)
        assert.equal(await page.locator("[data-payment-media] img").evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)), true)
        await page.locator('[data-payment-option="transferencia"]').click()
        assert.equal(await page.locator("[data-media-transfer]").count(), 1)
        assert.match(await page.locator('[data-payment-option="transferencia"]').innerText(), /10% OFF[\s\S]*\$90\.000/)
        await page.locator('[data-payment-option="mercadopago_installments"]').click()
        assert.equal(await page.locator("[data-media-installments] [data-confirmed]").count(), 2)
        assert.equal(await page.locator("[data-media-installments] [data-media-brand='American Express']").count(), 0)
        assert.equal(await page.locator("[data-payment-options] input:checked").inputValue(), "mercadopago_installments")
        await page.locator('[data-policy="cover"]').click()
        assert.match(await page.locator('[data-payment-option="mercadopago_installments"]').innerText(), /\$118\.000/)
        await page.locator('[data-policy="same"]').click()
        assert.match(await page.locator('[data-payment-option="mercadopago_installments"]').innerText(), /\$100\.000/)
        await page.locator('[data-brands="none"]').click()
        assert.equal(await page.locator("[data-media-installments] [data-media-brand]").count(), 0)
        const layout = await page.evaluate(() => {
          const cards = document.querySelector("[data-payment-options]")!.getBoundingClientRect()
          const panel = document.querySelector("[data-payment-media]")!.getBoundingClientRect()
          return { cards, panel, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }
        })
        assert.equal(layout.overflow, false)
        if (width === 1280) assert.ok(layout.panel.left > layout.cards.right - 2, "panel a la derecha")
        else assert.ok(layout.panel.top >= layout.cards.bottom - 2, "panel debajo")
        if (process.env.CHECKOUT_PAYMENT_SHOTS) await page.screenshot({ path: `${process.env.CHECKOUT_PAYMENT_SHOTS}/checkout-${theme}-${width}.png`, fullPage: true })
      } finally { await page.close() }
    })
  }
}
