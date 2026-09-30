import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

import { MERCADOPAGO_CASH_MEDIA_GROUPS } from "./mercadopago-cash-media.ts"

// "Mercado Pago al contado → Ver medios" con el PaymentInfoModal y el
// contenido REALES (bundle esbuild) y el CSS del proyecto, en Light/Dark y en
// desktop, tablet y mobile: marcas agrupadas en chips compactos, sin bancos,
// con la aclaración de disponibilidad, legible (AA) y sin desbordes.

const SHOTS = process.env.CASH_MEDIA_SHOTS

const ENTRY = `
import { createElement as h } from "react"
import { createRoot } from "react-dom/client"
import { PaymentInfoModal } from "@/components/checkout/payment-info-modal"
import { MercadoPagoCashMedia } from "@/components/checkout/mercadopago-cash-media"
createRoot(document.getElementById("root")).render(
  h(PaymentInfoModal, { title: "Mercado Pago al contado", onClose() {} }, h(MercadoPagoCashMedia)),
)
`

const BANKS = /ICBC|HSBC|Galicia|Santander|BBVA|Macro|Naci[oó]n|Provincia|Patagonia|Supervielle|Ciudad|Credicoop|Hipotecario|Comafi|Brubank|Ual[aá]|Banco/i

const pageHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head>
<body class="bg-beyonix-page"><div id="root"></div>
<script>window.process = { env: { NODE_ENV: "production" } }</script>
<script>${bundle}</script></body></html>`

const MEASURE = `(() => {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const parse = (v) => { if (!v || v === "transparent") return [0,0,0,0]; ctx.clearRect(0,0,1,1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = v; ctx.fillRect(0,0,1,1); const d = ctx.getImageData(0,0,1,1).data; return [d[0], d[1], d[2], d[3] / 255] }
  const lum = (c) => { const ch = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]) }
  const over = (t, b) => { const a = t[3]; return [t[0]*a + b[0]*(1-a), t[1]*a + b[1]*(1-a), t[2]*a + b[2]*(1-a), 1] }
  const background = (el) => { const layers = []; for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 0.95) break } } let r = [255,255,255,1]; for (let i = layers.length - 1; i >= 0; i--) r = over(layers[i], r); return r }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const dialog = document.querySelector("[role=dialog]")
  const failures = []
  for (const el of dialog.querySelectorAll("*")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim()
    if (!own) continue
    const bg = background(el); const r = ratio(over(parse(getComputedStyle(el).color), bg), bg)
    if (r < 4.5) failures.push(own.slice(0, 30) + " -> " + r.toFixed(2))
  }
  const box = dialog.getBoundingClientRect()
  const chips = [...dialog.querySelectorAll("[data-media-group] li")]
  return {
    title: dialog.querySelector("h2").textContent.trim(),
    text: dialog.innerText.replace(/\\s+/g, " ").trim(),
    groups: [...dialog.querySelectorAll("[data-media-group]")].map((g) => ({ id: g.getAttribute("data-media-group"), items: [...g.querySelectorAll("li")].map((li) => li.textContent.trim()) })),
    chipFont: Math.min(...chips.map((c) => parseFloat(getComputedStyle(c).fontSize))),
    chipOverflow: chips.some((c) => c.getBoundingClientRect().right > box.right - 8 || c.scrollWidth > c.clientWidth + 1),
    dialogHeight: Math.round(box.height), dialogWidth: Math.round(box.width),
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    images: dialog.querySelectorAll("img").length,
    failures,
  }
})()`

type Measure = {
  title: string; text: string; groups: Array<{ id: string; items: string[] }>; chipFont: number; chipOverflow: boolean
  dialogHeight: number; dialogWidth: number; pageOverflow: boolean; images: number; failures: string[]
}

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "cash-media-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light", width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) =>
    route.request().url() === "http://media.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml(theme, css, bundle) })
      : route.abort(),
  )
  await page.goto("http://media.test/")
  try {
    await page.waitForSelector("[data-mercadopago-cash-media]", { timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 768, 360]) {
    test(`H/I/J. ${theme} ${width}px: marcas agrupadas, sin bancos, compacto, legible y sin desbordes`, async () => {
      const page = await open(theme, width)
      try {
        const data = (await page.evaluate(MEASURE)) as Measure
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/cash-media-${theme}-${width}.png` })

        assert.equal(data.title, "Mercado Pago al contado")
        assert.match(data.text, /^Mercado Pago al contado Podés pagar con:/)
        assert.deepEqual(data.groups, MERCADOPAGO_CASH_MEDIA_GROUPS.map((group) => ({ id: group.id, items: [...group.items] })))
        assert.match(data.text, /Los medios disponibles pueden variar según tu cuenta, tarjeta y las condiciones de Mercado Pago\. Entendido$/)
        assert.doesNotMatch(data.text, BANKS, "sin bancos emisores")
        assert.equal(data.images, 0, "sin logos que no sean oficiales")

        assert.ok(data.chipFont >= 12, `chips legibles (${data.chipFont}px)`)
        assert.equal(data.chipOverflow, false, "los chips envuelven dentro del modal")
        assert.equal(data.pageOverflow, false, "sin scroll horizontal")
        assert.ok(data.dialogWidth <= Math.min(400, width - 32), `ancho ${data.dialogWidth}px`)
        // Compacto: no más de ~media pantalla (viewport de 800px) ni 420px.
        assert.ok(data.dialogHeight <= 420, `compacto: ${data.dialogHeight}px de alto`)
        assert.deepEqual(data.failures, [])
      } finally {
        await page.close()
      }
    })
  }
}

test("I. la lista central no incluye bancos ni Mercado Crédito sin confirmar", () => {
  const all = MERCADOPAGO_CASH_MEDIA_GROUPS.flatMap((group) => group.items).join(" | ")
  assert.doesNotMatch(all, BANKS)
  assert.doesNotMatch(all, /Mercado Crédito/)
  const source = readFileSync("lib/payments/mercadopago-cash-media.ts", "utf8")
  assert.match(source, /Nunca bancos emisores/)
})
