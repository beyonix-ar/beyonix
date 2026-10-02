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
// esbuild) en claro y oscuro, desktop y mobile: agrupación por categoría
// (Integraciones, Inventario, Comercial, Pagos), Andreani compacto con el
// detalle técnico colapsado, guardado por bloque, la tarjeta que deriva a
// Admin → Financiación (sin controles duplicados) y contraste AA. Stubs sólo
// de infraestructura (sesión y banners).

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
    await page.locator("[data-financing-mode='automatic'], [data-financing-mode='manual']").waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

const configBlock = (page: Page, name: string) => page.locator(`[data-config-block='${name}']`)
const saveButton = (page: Page, name: string) => configBlock(page, name).getByRole("button", { name: /Guardar cambios/ })

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: bloques agrupados por categoría (Integraciones, Inventario, Comercial, Pagos)`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const groups = await page.locator("[data-config-group]").evaluateAll((elements) =>
        elements.map((group) => ({
          id: group.getAttribute("data-config-group"),
          label: group.querySelector("h2")?.textContent,
          blocks: [...group.querySelectorAll("[data-config-block]")].map((block) => block.getAttribute("data-config-block")),
        })),
      )
      assert.deepEqual(groups.slice(0, 4), [
        { id: "integraciones", label: "Integraciones", blocks: ["andreani"] },
        { id: "inventario", label: "Inventario", blocks: ["stock"] },
        { id: "comercial", label: "Comercial", blocks: ["shipping", "pricing"] },
        { id: "pagos", label: "Pagos", blocks: ["financing", "customer-credit"] },
      ])
      // Desktop: dos columnas (Integraciones junto a Inventario).
      const [integraciones, inventario] = await Promise.all([
        page.locator("[data-config-group='integraciones']").boundingBox(),
        page.locator("[data-config-group='inventario']").boundingBox(),
      ])
      assert.ok(integraciones && inventario && Math.abs(integraciones.y - inventario.y) < 2 && inventario.x > integraciones.x)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Andreani compacto: estado arriba, acciones a mano y el detalle técnico colapsado`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const andreani = configBlock(page, "andreani")
      for (const [label, value] of [
        ["Ambiente", "QA"],
        ["Credenciales", "Configuradas"],
        ["Venta", "Activa"],
        ["Creación de envíos", "PROD · Bloqueada"],
      ]) {
        await andreani.locator("div", { has: page.getByText(label, { exact: true }) }).getByText(value, { exact: true }).first().waitFor()
      }
      await andreani.getByRole("button", { name: "Probar conexión QA" }).waitFor()
      await andreani.getByRole("button", { name: "Desactivar venta" }).waitFor()
      const detail = page.locator("[data-andreani-detail]")
      assert.equal(await detail.evaluate((element) => (element as HTMLDetailsElement).open), false)
      assert.equal(await page.getByText("Creación de envíos: Creación en PROD sin autorizar.").isVisible(), false)
      await detail.locator("summary").click()
      await page.getByText("Creación de envíos: Creación en PROD sin autorizar.").waitFor()
      await page.getByText("un resultado QA exitoso no valida PROD", { exact: false }).waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Stock con tres estados alineados y guardado propio`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const stock = configBlock(page, "stock")
      const tops = await stock.locator(".admin-stock-threshold-box").evaluateAll((tiles) => tiles.map((tile) => Math.round(tile.getBoundingClientRect().top)))
      assert.equal(tops.length, 3)
      assert.equal(new Set(tops).size, 1, "crítico, bajo y disponible en la misma fila")
      await stock.getByText("Desde 7 u.").waitFor()
      assert.equal(await saveButton(page, "stock").isDisabled(), true)
      await stock.getByLabel("Crítico").fill("2")
      await stock.getByText("Cambios sin guardar").waitFor()
      // Sólo este bloque queda con cambios.
      assert.equal(await page.getByText("Cambios sin guardar").count(), 1)
      await saveButton(page, "stock").click()
      await stock.getByText(/Guardado\./).waitFor()
      assert.deepEqual(await page.evaluate("window.__patches"), [
        { stock: { criticalStockThreshold: 2, lowStockThreshold: 6, availableStockThreshold: 7 } },
      ])
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Envíos se entiende con una frase; el costo de referencia queda secundario`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const shipping = configBlock(page, "shipping")
      await shipping.locator("[data-shipping-summary]").getByText("Desde $ 75.000 de compra, BEYONIX bonifica hasta $ 12.000 del envío.", { exact: false }).waitFor()
      await shipping.getByText("Bonificación activa").waitFor()
      for (const label of ["Compra mínima", "Bonificación máxima", "Bonificación base", "Estado"]) {
        await shipping.getByText(label, { exact: true }).waitFor()
      }
      const reference = page.locator("[data-shipping-reference]")
      assert.equal(await reference.evaluate((element) => (element as HTMLDetailsElement).open), false)
      assert.equal(await page.getByLabel("Costo de envío predeterminado").isVisible(), false)
      await reference.locator("summary").click()
      await page.getByLabel("Costo de envío predeterminado").waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Financiación sólo resume (modo y cuotas) y deriva; sin controles duplicados`, async () => {
    const page = await open(theme, costsOverview("manual", OBSERVED, { enabled: false }))
    try {
      const financing = configBlock(page, "financing")
      await financing.locator("[data-financing-mode='manual']").getByText("Manual", { exact: true }).waitFor()
      await financing.locator("[data-financing-installments='inactive']").getByText("Inactivas", { exact: true }).waitFor()
      const link = financing.getByRole("link", { name: /Ir a Financiación/ })
      assert.equal(await link.getAttribute("href"), "/admin/financiacion")
      assert.equal(await financing.locator("input, button").count(), 0, "sin controles: sólo el enlace")
      assert.equal(await page.getByRole("radiogroup", { name: /Origen de los costos/ }).count(), 0)
      assert.equal(await page.locator("input[aria-label*='respaldo' i], input[aria-label*='valor manual' i]").count(), 0)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Precios con ejemplo corto y Recargas compactas`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const pricing = configBlock(page, "pricing")
      await pricing.locator("[data-pricing-example]").getByText("Contado $ 75.000 → Transferencia $ 67.500").waitFor()
      await pricing.getByLabel("Descuento por transferencia").fill("% 20")
      await pricing.locator("[data-pricing-example]").getByText("Transferencia $ 60.000", { exact: false }).waitFor()
      const credit = configBlock(page, "customer-credit")
      assert.equal(await credit.locator("input").count(), 2)
      await credit.getByLabel("Recargo de las recargas de saldo con Mercado Pago").waitFor()
      await credit.getByLabel("Importe mínimo de recarga con Mercado Pago").waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: cada bloque guarda sólo lo suyo y nada se guarda sin cambios`, async () => {
    const page = await open(theme, costsOverview("manual", null))
    try {
      for (const name of ["stock", "shipping", "pricing", "customer-credit"]) {
        assert.equal(await saveButton(page, name).isDisabled(), true, name)
      }
      assert.deepEqual(await page.evaluate("window.__patches"), [])
      await configBlock(page, "customer-credit").getByLabel("Importe mínimo de recarga con Mercado Pago").fill("$ 12000")
      assert.equal(await saveButton(page, "pricing").isDisabled(), true, "otro bloque no se habilita")
      await saveButton(page, "customer-credit").click()
      await configBlock(page, "customer-credit").getByText(/Guardado\./).waitFor()
      assert.deepEqual(await page.evaluate("window.__patches"), [
        { customerCreditPayments: { mercadoPagoSurchargePercent: 0, mercadoPagoMinimumAmount: 12_000 } },
      ])
    } finally {
      await page.close()
    }
  })

  test(`${theme}: todo el texto visible de Configuración cumple contraste AA (también con desplegables abiertos)`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)))
      const { audited, failures } = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.ok(audited > 40, `se auditaron ${audited} textos`)
      assert.deepEqual(failures, [])
      await page.locator("[data-andreani-detail] summary").click()
      await page.locator("[data-shipping-reference] summary").click()
      await configBlock(page, "pricing").getByLabel("Descuento por transferencia").fill("% 15")
      const opened = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.deepEqual(opened.failures, [], "desplegables abiertos y bloque con cambios")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: en mobile (390px) una columna, sin scroll horizontal`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED), 390)
    try {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 0, `desborde horizontal de ${overflow}px`)
      const [integraciones, inventario] = await Promise.all([
        page.locator("[data-config-group='integraciones']").boundingBox(),
        page.locator("[data-config-group='inventario']").boundingBox(),
      ])
      assert.ok(integraciones && inventario && inventario.y >= integraciones.y + integraciones.height, "grupos apilados")
    } finally {
      await page.close()
    }
  })
}
