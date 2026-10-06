import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { deflateSync } from "node:zlib"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

const ENTRY = `
import { createElement as h, useState } from "react"
import { createRoot } from "react-dom/client"
import { CreditCard, Landmark, Wallet } from "lucide-react"
import { CheckoutPaymentMediaPanel, CheckoutPaymentOptionCard } from "@/components/checkout/checkout-payment-media-panel"
import { PaymentMethodLogoStrip } from "@/components/payments/payment-method-logo-tile"
import { usePaymentMethodLogos } from "@/lib/payments/use-payment-method-logos"

function Strip() {
  const logos = usePaymentMethodLogos() ?? []
  return h("div", { "data-strip-fixture": true, style: { marginTop: 16 } }, h(PaymentMethodLogoStrip, { logos }))
}

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
      h(Strip),
    ),
  )
}
createRoot(document.getElementById("root")).render(h(Fixture))
`

const html = (theme: string, css: string, bundle: string) => `<!doctype html><html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-beyonix-page"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script>${bundle}</script></body></html>`

// Logos de prueba con proporciones opuestas: un SVG muy ancho y un PNG alto.
const WIDE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 60"><rect width="300" height="60" fill="#1a1f71"/></svg>'

function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makePng(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set([255, 102, 0], y * (width * 3 + 1) + 1 + x * 3)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
const TALL_PNG = makePng(40, 120)

const STORAGE = "https://storage.test/payment-method-logos"
const CATALOG = {
  logos: [
    { key: "1", source: "mercadopago", providerMethodId: "visa", name: "Visa", paymentTypes: ["credit_card", "prepaid_card"], imageUrl: `${STORAGE}/visa.svg` },
    { key: "2", source: "mercadopago", providerMethodId: "naranja", name: "Naranja", paymentTypes: ["credit_card"], imageUrl: `${STORAGE}/naranja.png` },
    { key: "3", source: "mercadopago", providerMethodId: "debvisa", name: "Visa Débito", paymentTypes: ["debit_card"], imageUrl: `${STORAGE}/debvisa.svg` },
    { key: "4", source: "manual", providerMethodId: null, name: "MODO", paymentTypes: [], imageUrl: `${STORAGE}/modo.png` },
  ],
}

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
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

/** catalog: null = la API no responde (sin logos: referencia en texto). */
async function open(theme: "light" | "dark", width: number, catalog: typeof CATALOG | null): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.origin === "http://checkout-payment.test" && url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html(theme, css, bundle) })
    if (url.pathname === "/api/payment-methods") {
      return catalog ? route.fulfill({ contentType: "application/json", body: JSON.stringify(catalog) }) : route.abort()
    }
    if (url.origin === "https://storage.test") {
      return url.pathname.endsWith(".svg")
        ? route.fulfill({ contentType: "image/svg+xml", body: WIDE_SVG })
        : route.fulfill({ contentType: "image/png", body: TALL_PNG })
    }
    return route.abort()
  })
  await page.goto("http://checkout-payment.test/")
  try { await page.waitForSelector("[data-payment-media=mercadopago_cash]", { timeout: 10_000 }) }
  catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return page
}

async function assertUniformTiles(page: Page, scope: string, expected: number) {
  const tiles = page.locator(`${scope} [data-payment-logo-tile]`)
  assert.equal(await tiles.count(), expected, scope)
  // loading="lazy": se cargan al entrar en pantalla.
  await tiles.last().scrollIntoViewIfNeeded()
  await page.waitForFunction(
    (selector) => [...document.querySelectorAll(selector)].every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
    `${scope} [data-payment-logo-tile] img`,
    { timeout: 5_000 },
  )
  const measures = await tiles.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect()
    const image = element.querySelector("img")!
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      fit: getComputedStyle(image).objectFit,
      loaded: image.complete && image.naturalWidth > 0,
      background: getComputedStyle(element).backgroundColor,
      imageInside: image.getBoundingClientRect().width <= box.width && image.getBoundingClientRect().height <= box.height,
    }
  }))
  assert.equal(new Set(measures.map((measure) => `${measure.width}x${measure.height}`)).size, 1, `mismo tamaño: ${JSON.stringify(measures)}`)
  for (const measure of measures) {
    assert.equal(measure.fit, "contain", "nunca se deforma ni se recorta")
    assert.equal(measure.loaded, true, "SVG y PNG cargan")
    assert.equal(measure.background, "rgb(255, 255, 255)")
    assert.equal(measure.imageInside, true)
  }
}

async function assertNoOverflow(page: Page, width: number) {
  const layout = await page.evaluate(() => {
    const cards = document.querySelector("[data-payment-options]")!.getBoundingClientRect()
    const panel = document.querySelector("[data-payment-media]")!.getBoundingClientRect()
    return { cards, panel, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }
  })
  assert.equal(layout.overflow, false)
  if (width === 1280) assert.ok(layout.panel.left > layout.cards.right - 2, "panel a la derecha")
  else assert.ok(layout.panel.top >= layout.cards.bottom - 2, "panel debajo")
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 768, 390]) {
    test(`${theme} ${width}px: sin logos cargados, referencia en texto sin imágenes inventadas`, async () => {
      const page = await open(theme, width, null)
      try {
        const cards = page.locator("[data-payment-options] [data-payment-option]")
        assert.equal(await cards.count(), 3)
        assert.equal(await page.locator("[data-payment-options] input:checked").count(), 1)
        await page.locator("[data-media-cash][data-media-source='reference']").waitFor()
        assert.equal(await page.locator("[data-payment-media=mercadopago_cash] [data-media-group]").count(), 3)
        assert.equal(await page.locator('[data-media-brand="American Express"]').count(), 1)
        assert.equal(await page.locator("[data-payment-media] img").count(), 0, "sin logos de Admin no se muestra ninguna imagen")
        assert.equal(await page.locator("[data-payment-logo-strip]").count(), 0, "la tira compacta no aparece vacía")
        await page.locator('[data-payment-option="transferencia"]').click()
        assert.equal(await page.locator("[data-media-transfer]").count(), 1)
        assert.match(await page.locator('[data-payment-option="transferencia"]').innerText(), /10% OFF[\s\S]*\$90\.000/)
        await page.locator('[data-payment-option="mercadopago_installments"]').click()
        assert.equal(await page.locator("[data-media-installments] [data-confirmed]").count(), 2)
        assert.equal(await page.locator("[data-media-installments] [data-has-logo]").count(), 0)
        assert.equal(await page.locator("[data-payment-options] input:checked").inputValue(), "mercadopago_installments")
        await page.locator('[data-policy="cover"]').click()
        assert.match(await page.locator('[data-payment-option="mercadopago_installments"]').innerText(), /\$118\.000/)
        await page.locator('[data-policy="same"]').click()
        assert.match(await page.locator('[data-payment-option="mercadopago_installments"]').innerText(), /\$100\.000/)
        await page.locator('[data-brands="none"]').click()
        assert.equal(await page.locator("[data-media-installments] [data-media-brand]").count(), 0)
        await assertNoOverflow(page, width)
      } finally { await page.close() }
    })

    test(`${theme} ${width}px: logos de Admin disponibles en MP, SVG y PNG en tarjetas uniformes`, async () => {
      const page = await open(theme, width, CATALOG)
      try {
        await page.locator("[data-media-cash][data-media-source='mercadopago']").waitFor()
        const groups = await page.locator("[data-media-cash] [data-media-group]").evaluateAll((elements) =>
          elements.map((element) => [element.getAttribute("data-media-group"), [...element.querySelectorAll("[data-media-logo]")].map((item) => item.getAttribute("data-media-logo"))]))
        assert.deepEqual(groups, [["credit", ["visa", "naranja"]], ["debit", ["debvisa"]]], "MODO (manual) nunca se presenta como medio de Mercado Pago")
        await assertUniformTiles(page, "[data-media-cash]", 3)

        // Tira compacta (PDP): todos los visibles, incluido el manual habilitado.
        await assertUniformTiles(page, "[data-payment-logo-strip]", 4)
        const strip = await page.locator("[data-payment-logo-strip]").boundingBox()
        assert.ok(strip && strip.height <= 80, `tira compacta (${strip?.height}px)`)

        await page.locator('[data-payment-option="mercadopago_installments"]').click()
        assert.equal(await page.locator("[data-media-installments] [data-media-brand='Visa'][data-has-logo]").count(), 1)
        assert.equal(await page.locator("[data-media-installments] [data-media-brand='Mastercard'][data-has-logo]").count(), 0, "Mastercard sin imagen: sólo texto")
        await page.locator('[data-payment-option="mercadopago_cash"]').click()
        await assertNoOverflow(page, width)
        if (process.env.CHECKOUT_PAYMENT_SHOTS) await page.screenshot({ path: `${process.env.CHECKOUT_PAYMENT_SHOTS}/checkout-logos-${theme}-${width}.png`, fullPage: true })
      } finally { await page.close() }
    })
  }
}
