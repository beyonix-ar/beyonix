import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

import type { MercadoPagoObservedCosts } from "../mercadopago/observed-costs.ts"

// Admin → Configuración con el componente REAL (AdminModificaciones, bundle
// esbuild) en claro y oscuro: Automático/Manual de costos de Mercado Pago,
// guardado por bloque y contraste AA. Stubs sólo de infraestructura (sesión
// y el editor de banners, que tiene sus propios tests).

const stubs: Plugin = {
  name: "admin-config-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: "supabase", namespace: "stub" }))
    pluginBuild.onResolve({ filter: /\/banners\/admin-banners$/ }, () => ({ path: "banners", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /^supabase$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `
        export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: "t" } }, error: null }) } }
        export async function getSafeSupabaseSession() { return { access_token: "t" } }`,
    }))
    pluginBuild.onLoad({ filter: /^banners$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `export function AdminBanners() { return null }`,
    }))
  },
}

const MANUAL = { baseProcessingPercent: 3.46, ivaPercent: 21, surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 } }
const CREDIT_OBSERVATION = {
  percentWithIva: 4.25,
  observedAt: "2026-09-30T20:48:46.000Z",
  paymentTypeId: "credit_card",
  paymentMethodId: "visa",
  installments: 1,
  releaseDays: 18,
  orderId: 18,
}
const OBSERVED: MercadoPagoObservedCosts = {
  base: CREDIT_OBSERVATION,
  surchargeByCount: { 2: null, 3: null, 6: null },
  singlePaymentByType: {
    credit_card: CREDIT_OBSERVATION,
    debit_card: null,
    account_money: { ...CREDIT_OBSERVATION, percentWithIva: 4.19, paymentTypeId: "account_money", paymentMethodId: "account_money", orderId: 17 },
  },
  analyzedPayments: 3,
}

function overview(mode: "automatic" | "manual", observed: MercadoPagoObservedCosts | null) {
  const observedBase = mode === "automatic" && observed?.base ? Math.round((observed.base.percentWithIva / 1.21) * 100) / 100 : null
  return {
    mode,
    manual: MANUAL,
    observed,
    effective: { ...MANUAL, baseProcessingPercent: observedBase ?? MANUAL.baseProcessingPercent },
    sources: { base: observedBase === null ? "manual" : "observed", surchargeByCount: { 2: "manual", 3: "manual", 6: "manual" } },
  }
}

const SETTINGS = {
  shipping: { defaultShippingCost: 9000, freeShippingMinAmount: 75000, shippingBonusMax: 12000, freeShippingMode: "full", logisticsBaseSubsidy: 3000 },
  customerCreditPayments: { mercadoPagoSurchargePercent: 0, mercadoPagoMinimumAmount: 10000 },
  stock: { criticalStockThreshold: 3, lowStockThreshold: 6, availableStockThreshold: 7 },
  pricing: { transferDiscountPercent: 10, nationalTaxesIncidencePercent: 21 },
  andreaniCommercial: { enabled: true },
  installmentsFinancing: MANUAL,
}

const entry = (costs: unknown) => `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { AdminModificaciones } from "@/app/admin/sections/modificaciones/admin-modificaciones"
window.__patches = []
const costs = ${JSON.stringify(costs)}
window.fetch = async (input, init) => {
  const path = String(input)
  if (path === "/api/admin/integrations/andreani/test") {
    return Response.json({ configured: true, environment: "QA", message: "Credenciales QA cargadas.", shipmentCreation: { configured: false, environment: "PROD", message: "Creación en PROD sin autorizar." } })
  }
  if (path === "/api/admin/settings") {
    if (init && init.method === "PATCH") {
      const body = JSON.parse(init.body)
      window.__patches.push(body)
      const next = body.installmentsFinancing
        ? { ...costs, mode: body.installmentsFinancing.mode }
        : costs
      return Response.json({ settings: ${JSON.stringify(SETTINGS)}, mercadoPagoCosts: next })
    }
    return Response.json({ settings: ${JSON.stringify(SETTINGS)}, mercadoPagoCosts: costs })
  }
  return Response.json({})
}
createRoot(document.getElementById("root")).render(createElement(AdminModificaciones))
`

const pageHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-admin-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div id="root"></div></main></div>
<script>window.process = { env: { NODE_ENV: "production" } }</script>
<script>${bundle}</script></body></html>`

// Se ejecuta en el navegador como string. Colores vía canvas (acepta
// lab/oklab/color-mix de Tailwind v4); fondo real componiendo capas.
const CONTRAST_AUDIT = `(() => {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  function parse(value) {
    if (!value || value === "transparent") return [0, 0, 0, 0]
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = "rgba(0,0,0,0)"
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  function firstStop(image) {
    const re = /(rgba?|lab|oklab|oklch|lch|hsla?|color)\\(/g
    const match = re.exec(image)
    if (!match) return null
    let i = match.index + match[0].length, level = 1
    while (i < image.length && level > 0) { if (image[i] === "(") level++; else if (image[i] === ")") level--; i++ }
    return image.slice(match.index, i)
  }
  function lum(c) {
    const ch = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
  }
  function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  function over(top, bottom) { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1] }
  function background(el) {
    const layers = []
    for (let node = el; node; node = node.parentElement) {
      const s = getComputedStyle(node)
      const stop = firstStop(s.backgroundImage)
      if (stop) { const c = parse(stop); layers.push(c); if (c[3] >= 0.95) break }
      const color = parse(s.backgroundColor)
      if (color[3] > 0) { layers.push(color); if (color[3] >= 0.95) break }
    }
    let result = document.documentElement.dataset.adminTheme === "light" ? [255, 255, 255, 1] : [2, 6, 10, 1]
    for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result)
    return result
  }
  const failures = []
  let audited = 0
  for (const el of document.querySelector(".admin-config-page").querySelectorAll("*")) {
    if (el.closest("details:not([open])") && el.tagName !== "SUMMARY") continue
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim()
    if (!own || el.closest("button:disabled, input:disabled")) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const s = getComputedStyle(el)
    if (s.visibility === "hidden" || parseFloat(s.opacity) === 0) continue
    let opacity = 1
    for (let node = el; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity)
    audited++
    const bg = background(el)
    const color = parse(s.color)
    const fg = over([color[0], color[1], color[2], color[3] * opacity], bg)
    const r = ratio(fg, bg)
    const size = parseFloat(s.fontSize)
    const large = size >= 18.66 || (size >= 14 && parseInt(s.fontWeight) >= 700)
    if (r < (large ? 3 : 4.5)) failures.push(own.slice(0, 40) + " -> " + r.toFixed(2) + " (" + s.color + " sobre rgb(" + bg.slice(0, 3).map(Math.round).join(",") + "), " + s.fontSize + ")")
  }
  return { audited, failures }
})()`

let browser: Browser
let css: string
const bundles = new Map<string, string>()

async function bundleFor(costs: unknown) {
  const key = JSON.stringify(costs)
  const cached = bundles.get(key)
  if (cached) return cached
  const result = await build({
    stdin: { contents: entry(costs), resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-config-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  const bundle = result.outputFiles[0].text
  bundles.set(key, bundle)
  return bundle
}

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light", costs: unknown, width = 1280): Promise<Page> {
  const bundle = await bundleFor(costs)
  const page = await browser.newPage({ viewport: { width, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) =>
    route.request().url() === "http://admin.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml(theme, css, bundle) })
      : route.abort(),
  )
  await page.goto("http://admin.test/")
  try {
    await page.getByText("Costos de Mercado Pago").waitFor({ timeout: 10_000 })
    await page.getByText("Configuradas").waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: automático con datos observados es la fuente activa y el cambio a manual queda explícito`, async () => {
    const page = await open(theme, overview("automatic", OBSERVED))
    try {
      const automatic = page.getByRole("radio", { name: /Automático/ })
      const manual = page.getByRole("radio", { name: /Manual/ })
      assert.equal(await automatic.getAttribute("aria-checked"), "true")
      await page.getByText("Automático activo.").waitFor()
      // 4,25% con IVA observado = 3,51% sin IVA: difiere del manual (3,46%).
      await page.getByText("3,51%", { exact: true }).first().waitFor()
      await page.getByText("Manual: 3,46%").waitFor()
      assert.equal(await page.getByText("Observado", { exact: true }).count(), 1)
      assert.equal(await page.getByText("Respaldo", { exact: true }).count(), 3)

      await manual.click()
      assert.equal(await manual.getAttribute("aria-checked"), "true")
      await page.getByText("Modo manual (sin guardar).").waitFor()
      assert.equal(await page.getByText("Observado", { exact: true }).count(), 0, "manual nunca usa observaciones")

      const section = page.locator(".admin-config-section", { hasText: "Costos de Mercado Pago" })
      await section.getByText("Cambios sin guardar").waitFor()
      await section.getByRole("button", { name: /Guardar cambios/ }).click()
      await section.getByText(/Guardado\./).waitFor()
      const patches = (await page.evaluate("window.__patches")) as Array<Record<string, unknown>>
      assert.deepEqual(patches, [{ installmentsFinancing: { ...MANUAL, mode: "manual" } }], "sólo se envía este bloque")
      assert.equal(await manual.getAttribute("aria-checked"), "true")
      await section.getByText("Sin cambios").waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: sin datos observados avisa que usa el respaldo; los demás bloques no se guardan sin cambios`, async () => {
    const page = await open(theme, overview("automatic", { ...OBSERVED, base: null, analyzedPayments: 0 }))
    try {
      await page.getByText("Todavía no hay datos observados.").waitFor()
      await page.getByText("Se usarán los valores de respaldo hasta detectar pagos reales aprobados.").waitFor()
      for (const title of ["Stock", "Envíos", "Precios y transferencia", "Recargas de saldo"]) {
        const section = page.locator(".admin-config-section", { has: page.getByRole("heading", { name: title, exact: true }) })
        assert.equal(await section.getByRole("button", { name: /Guardar cambios/ }).isDisabled(), true, title)
      }
      await page.getByText("Desde $ 75.000 de compra, BEYONIX bonifica", { exact: false }).waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: todo el texto visible de Configuración cumple contraste AA`, async () => {
    const page = await open(theme, overview("automatic", OBSERVED))
    // Se mide el estado final: los botones que se habilitan animan su opacidad.
    const settled = () => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)))
    try {
      await settled()
      const { audited, failures } = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.ok(audited > 80, `se auditaron ${audited} textos`)
      assert.deepEqual(failures, [])
      await page.getByRole("radio", { name: /Manual/ }).click()
      await settled()
      const manualAudit = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.deepEqual(manualAudit.failures, [], "modo manual")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: en mobile (390px) no hay scroll horizontal`, async () => {
    const page = await open(theme, overview("automatic", OBSERVED), 390)
    try {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 0, `desborde horizontal de ${overflow}px`)
    } finally {
      await page.close()
    }
  })
}
