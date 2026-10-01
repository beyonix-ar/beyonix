import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

import {
  adminConfigStubs,
  adminPageHtml,
  CONTRAST_AUDIT,
  costsOverview,
  OBSERVED,
  SETTINGS,
} from "./admin-config-browser-harness.ts"

// Admin → Configuración con el componente REAL (AdminModificaciones, bundle
// esbuild) en claro y oscuro: guardado por bloque, contraste AA y la tarjeta
// que deriva a Admin → Financiación (los controles de costos y cuotas ya no
// viven acá). Stubs sólo de infraestructura (sesión y banners).

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
    if (init && init.method === "PATCH") window.__patches.push(JSON.parse(init.body))
    return Response.json({ settings: ${JSON.stringify(SETTINGS)}, mercadoPagoCosts: costs })
  }
  return Response.json({})
}
createRoot(document.getElementById("root")).render(createElement(AdminModificaciones))
`

let browser: Browser
let css: string
const bundles = new Map<string, string>()

async function bundleFor(costs: unknown) {
  const key = JSON.stringify(costs)
  const cached = bundles.get(key)
  if (cached) return cached
  const result = await build({
    stdin: { contents: entry(costs), resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-config-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [adminConfigStubs],
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
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml(theme, css, bundle) })
      : route.abort(),
  )
  await page.goto("http://admin.test/")
  try {
    await page.getByText("Financiación Mercado Pago").waitFor({ timeout: 10_000 })
    await page.getByText("Configuradas").waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: Configuración sólo resume Financiación y deriva; sin controles de costos duplicados`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      await page.getByText("Gestionar costos, cuotas y automatización.").waitFor()
      await page.getByText("Modo automático · cuotas sin interés activas").waitFor()
      const link = page.getByRole("link", { name: /Ir a Financiación/ })
      assert.equal(await link.getAttribute("href"), "/admin/financiacion")
      assert.equal(await page.getByRole("radiogroup", { name: /Origen de los costos/ }).count(), 0)
      assert.equal(await page.getByText("Costos de Mercado Pago").count(), 0)
      assert.equal(await page.locator("input[aria-label*='respaldo manual' i], input[aria-label*='valor manual' i]").count(), 0)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: los bloques de Configuración no se guardan sin cambios`, async () => {
    const page = await open(theme, costsOverview("manual", null))
    try {
      for (const title of ["Stock", "Envíos", "Precios y transferencia", "Recargas de saldo"]) {
        const section = page.locator(".admin-config-section", { has: page.getByRole("heading", { name: title, exact: true }) })
        assert.equal(await section.getByRole("button", { name: /Guardar cambios/ }).isDisabled(), true, title)
      }
      await page.getByText("Modo manual · cuotas sin interés activas").waitFor()
      await page.getByText("Desde $ 75.000 de compra, BEYONIX bonifica", { exact: false }).waitFor()
      assert.deepEqual(await page.evaluate("window.__patches"), [])
    } finally {
      await page.close()
    }
  })

  test(`${theme}: todo el texto visible de Configuración cumple contraste AA`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)))
      const { audited, failures } = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.ok(audited > 50, `se auditaron ${audited} textos`)
      assert.deepEqual(failures, [])
    } finally {
      await page.close()
    }
  })

  test(`${theme}: en mobile (390px) no hay scroll horizontal`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED), 390)
    try {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 0, `desborde horizontal de ${overflow}px`)
    } finally {
      await page.close()
    }
  })
}
