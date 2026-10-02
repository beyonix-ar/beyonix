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
// esbuild) en claro y oscuro, desktop y mobile. "Lectura primero, edición
// después": cada bloque muestra sus valores como texto y recién con
// [Editar] aparecen los controles con [Cancelar] [Guardar] (sólo ese
// bloque). Agrupación por categoría, Andreani resumido con el detalle
// colapsado, Financiación sólo como acceso, jerarquía visual en claro y
// contraste AA. Stubs sólo de infraestructura (sesión y banners).

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
    await page.locator("[data-config-block='stock'] [data-config-edit]:not([disabled])").waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

const EDITABLE = ["stock", "shipping", "pricing", "customer-credit"] as const
const configBlock = (page: Page, name: string) => page.locator(`[data-config-block='${name}']`)
const edit = (page: Page, name: string) => configBlock(page, name).locator("[data-config-edit]").click()
const saveButton = (page: Page, name: string) => configBlock(page, name).locator("[data-config-save]")
const cancel = (page: Page, name: string) => configBlock(page, name).locator("[data-config-cancel]").click()
const mode = (page: Page, name: string) => configBlock(page, name).getAttribute("data-config-mode")
const row = (page: Page, name: string, label: string) =>
  configBlock(page, name).locator(".admin-config-value-row", { has: page.locator("dt", { hasText: label }) }).first()
const rowValue = async (page: Page, name: string, label: string) =>
  (await row(page, name, label).locator("dd").innerText()).replace(/ /g, " ").trim()
const settled = (page: Page) =>
  // Una transición reemplazada rechaza `finished`: igual cuenta como terminada.
  page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))))
const patches = (page: Page) => page.evaluate("window.__patches") as Promise<unknown[]>
const background = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor)

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: bloques agrupados por categoría y Banners a ancho completo`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const groups = await page.locator("[data-config-group]").evaluateAll((elements) =>
        elements.map((group) => ({
          id: group.getAttribute("data-config-group"),
          label: group.querySelector("h2")?.textContent,
          blocks: [...group.querySelectorAll("[data-config-block]")].map((block) => block.getAttribute("data-config-block")),
        })),
      )
      assert.deepEqual(groups, [
        { id: "integraciones", label: "Integraciones", blocks: ["andreani"] },
        { id: "inventario", label: "Inventario", blocks: ["stock"] },
        { id: "comercial", label: "Comercial", blocks: ["shipping", "pricing"] },
        { id: "pagos", label: "Pagos", blocks: ["financing", "customer-credit"] },
        { id: "visuales", label: "Visuales", blocks: ["banners"] },
      ])
      const [integraciones, inventario, banners] = await Promise.all([
        page.locator("[data-config-group='integraciones']").boundingBox(),
        page.locator("[data-config-group='inventario']").boundingBox(),
        configBlock(page, "banners").boundingBox(),
      ])
      assert.ok(integraciones && inventario && Math.abs(integraciones.y - inventario.y) < 2 && inventario.x > integraciones.x, "dos columnas")
      assert.ok(banners && integraciones && banners.width > integraciones.width * 1.8, "Banners ocupa el ancho completo")
      await configBlock(page, "banners").getByRole("heading", { name: "Banners", exact: true }).waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: lectura por defecto: valores como texto, sin inputs ni botón Guardar`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      for (const name of EDITABLE) {
        assert.equal(await mode(page, name), "read", name)
        await configBlock(page, name).locator("[data-config-edit]").waitFor()
      }
      assert.equal(await page.locator(".admin-config-section input, .admin-config-section [role='combobox']").count(), 0)
      assert.equal(await page.locator("[data-config-save]").count(), 0)

      assert.equal(await rowValue(page, "stock", "Crítico"), "1 a 3")
      assert.equal(await rowValue(page, "stock", "Bajo"), "4 a 6")
      assert.equal(await rowValue(page, "stock", "Disponible"), "7+")
      await configBlock(page, "shipping").locator("[data-shipping-summary]").getByText("Desde $ 75.000 de compra, BEYONIX bonifica hasta $ 12.000 del envío.").waitFor()
      assert.equal(await rowValue(page, "shipping", "Compra mínima"), "$ 75.000")
      assert.equal(await rowValue(page, "shipping", "Bonificación máxima"), "$ 12.000")
      assert.equal(await rowValue(page, "shipping", "Bonificación base"), "$ 3.000")
      assert.equal(await rowValue(page, "shipping", "Estado"), "Activa")
      assert.equal(await rowValue(page, "pricing", "Transferencia"), "10% OFF")
      assert.equal(await rowValue(page, "pricing", "Impuestos nacionales"), "21%")
      assert.equal(await rowValue(page, "pricing", "Ejemplo"), "$ 75.000 → $ 67.500")
      assert.equal(await rowValue(page, "customer-credit", "Recargo"), "0%")
      assert.equal(await rowValue(page, "customer-credit", "Importe mínimo"), "$ 10.000")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: bloques compactos (2–4 valores no ocupan media pantalla)`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      for (const [name, max] of [
        ["andreani", 300],
        ["stock", 200],
        ["shipping", 300],
        ["pricing", 200],
        ["financing", 160],
        ["customer-credit", 160],
      ] as const) {
        const box = await configBlock(page, name).boundingBox()
        assert.ok(box && box.height <= max, `${name}: ${box?.height}px`)
      }
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Stock: Editar muestra los valores editables; Cancelar descarta; Guardar guarda sólo Stock`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      await edit(page, "stock")
      assert.equal(await mode(page, "stock"), "edit")
      const stock = configBlock(page, "stock")
      assert.equal(await stock.locator("input").count(), 2, "Crítico y Bajo; Disponible se calcula")
      await stock.getByText("Sin cambios").waitFor()
      assert.equal(await saveButton(page, "stock").isDisabled(), true)
      await stock.getByLabel("Crítico").fill("2")
      await stock.getByText("Cambios sin guardar").waitFor()
      assert.equal(await rowValue(page, "stock", "Disponible"), "7+")

      await cancel(page, "stock")
      assert.equal(await mode(page, "stock"), "read")
      assert.equal(await rowValue(page, "stock", "Crítico"), "1 a 3", "Cancelar descarta el cambio local")
      assert.deepEqual(await patches(page), [])

      await edit(page, "stock")
      await stock.getByLabel("Crítico").fill("2")
      await stock.getByLabel("Bajo").fill("1")
      await stock.getByText("El stock crítico debe ser menor que el stock bajo.").waitFor()
      assert.equal(await saveButton(page, "stock").isDisabled(), true, "no guarda un rango inválido")
      await stock.getByLabel("Bajo").fill("6")
      await saveButton(page, "stock").click()
      await stock.getByText(/Guardado\./).waitFor()
      assert.equal(await mode(page, "stock"), "read", "tras guardar vuelve a lectura")
      assert.deepEqual(await patches(page), [{ stock: { criticalStockThreshold: 2, lowStockThreshold: 6, availableStockThreshold: 7 } }])
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Envíos: edición con inputs y estado; costo de referencia secundario; Cancelar no toca otros bloques`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const reference = page.locator("[data-shipping-reference]")
      assert.equal(await reference.evaluate((element) => (element as HTMLDetailsElement).open), false)
      await reference.locator("summary").click()
      assert.equal(await rowValue(page, "shipping", "Costo predeterminado"), "$ 9.000")

      await edit(page, "pricing")
      await edit(page, "shipping")
      const shipping = configBlock(page, "shipping")
      for (const label of [
        "Monto mínimo para acceder a envío bonificado",
        "Tope máximo de bonificación de envío",
        "Bonificación base de envío para compras por debajo del mínimo",
        "Costo de envío predeterminado",
      ]) {
        await shipping.getByLabel(label).waitFor()
      }
      await shipping.getByRole("button", { name: "Estado de la bonificación" }).waitFor()
      await shipping.getByLabel("Monto mínimo para acceder a envío bonificado").fill("$ 100000")
      await shipping.locator("[data-shipping-summary]").getByText("Desde $ 100.000 de compra", { exact: false }).waitFor()

      await cancel(page, "shipping")
      assert.equal(await rowValue(page, "shipping", "Compra mínima"), "$ 75.000")
      assert.equal(await mode(page, "pricing"), "edit", "cancelar Envíos no toca Precios")

      await edit(page, "shipping")
      await shipping.getByLabel("Tope máximo de bonificación de envío").fill("$ 20000")
      await saveButton(page, "shipping").click()
      await shipping.getByText(/Guardado\./).waitFor()
      assert.deepEqual(await patches(page), [
        { shipping: { defaultShippingCost: 9000, freeShippingMinAmount: 75000, shippingBonusMax: 20000, freeShippingMode: "full", logisticsBaseSubsidy: 3000 } },
      ])
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Precios y Recargas: edición compacta y cada bloque guarda sólo lo suyo`, async () => {
    const page = await open(theme, costsOverview("manual", null))
    try {
      await edit(page, "pricing")
      const pricing = configBlock(page, "pricing")
      assert.equal(await pricing.locator("input").count(), 2)
      await pricing.getByLabel("Descuento por transferencia").fill("% 20")
      assert.equal(await rowValue(page, "pricing", "Ejemplo"), "$ 75.000 → $ 60.000", "el ejemplo sigue al valor editado")
      await saveButton(page, "pricing").click()
      await pricing.getByText(/Guardado\./).waitFor()

      await edit(page, "customer-credit")
      const credit = configBlock(page, "customer-credit")
      assert.equal(await credit.locator("input").count(), 2)
      await credit.getByLabel("Importe mínimo de recarga con Mercado Pago").fill("$ 12000")
      await saveButton(page, "customer-credit").click()
      await credit.getByText(/Guardado\./).waitFor()

      assert.deepEqual(await patches(page), [
        { pricing: { transferDiscountPercent: 20, nationalTaxesIncidencePercent: 21 } },
        { customerCreditPayments: { mercadoPagoSurchargePercent: 0, mercadoPagoMinimumAmount: 12_000 } },
      ])
      for (const name of ["stock", "shipping"]) assert.equal(await mode(page, name), "read", name)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Financiación sólo resume (modo y cuotas) y deriva; sin controles duplicados`, async () => {
    const page = await open(theme, costsOverview("manual", OBSERVED, { enabled: false }))
    try {
      const financing = configBlock(page, "financing")
      assert.equal(await rowValue(page, "financing", "Modo"), "Manual")
      assert.equal(await rowValue(page, "financing", "Cuotas sin interés"), "Inactivas")
      const link = financing.getByRole("link", { name: /Ir a Financiación/ })
      assert.equal(await link.getAttribute("href"), "/admin/financiacion")
      assert.equal(await financing.locator("input, button").count(), 0, "sin controles: sólo el enlace")
      assert.equal(await page.getByRole("radiogroup", { name: /Origen de los costos/ }).count(), 0)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Andreani resumido con acciones; el detalle técnico colapsado`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      assert.equal(await rowValue(page, "andreani", "Ambiente"), "QA")
      assert.equal(await rowValue(page, "andreani", "Credenciales"), "Configuradas")
      assert.equal(await rowValue(page, "andreani", "Venta"), "Activa")
      assert.equal(await rowValue(page, "andreani", "Creación de envíos"), "PROD · Bloqueada")
      const actions = page.locator("[data-andreani-actions]")
      await actions.getByRole("button", { name: "Probar conexión QA" }).waitFor()
      await actions.getByRole("button", { name: "Desactivar venta" }).waitFor()
      const detail = page.locator("[data-andreani-detail]")
      assert.equal(await detail.evaluate((element) => (element as HTMLDetailsElement).open), false)
      assert.equal(await page.getByText("Creación de envíos: Creación en PROD sin autorizar.").isVisible(), false)
      await detail.locator("summary").click()
      await page.getByText("Creación de envíos: Creación en PROD sin autorizar.").waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: jerarquía visual: tarjetas distintas del fondo; inputs de edición legibles con borde`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const pageBackground = await page.locator(".beyonix-admin-main").evaluate((element) => {
        for (let node: Element | null = element; node; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor
          if (color !== "rgba(0, 0, 0, 0)") return color
        }
        return getComputedStyle(document.body).backgroundColor
      })
      const card = await background(page, "[data-config-block='stock']")
      assert.notEqual(card, pageBackground, "la tarjeta se distingue del fondo")
      if (theme === "light") {
        for (const name of ["andreani", "stock", "shipping", "pricing", "financing", "customer-credit"]) {
          assert.equal(await background(page, `[data-config-block='${name}']`), "rgb(242, 244, 247)", name)
        }
        assert.equal(await background(page, "[data-config-block='banners']"), "rgb(255, 255, 255)", "Banners combina con el resto")
      }
      await edit(page, "pricing")
      const input = configBlock(page, "pricing").getByLabel("Descuento por transferencia")
      const style = await input.evaluate((element) => {
        const computed = getComputedStyle(element)
        return { background: computed.backgroundColor, border: computed.borderTopColor, width: computed.borderTopWidth }
      })
      assert.notEqual(style.border, "rgba(0, 0, 0, 0)")
      assert.ok(parseFloat(style.width) >= 1, "borde visible")
      if (theme === "light") assert.equal(style.background, "rgb(255, 255, 255)")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: foco visible al navegar con teclado`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const target = configBlock(page, "stock").locator("[data-config-edit]")
      await page.locator("body").click({ position: { x: 2, y: 2 } })
      let reached = false
      for (let step = 0; step < 40 && !reached; step++) {
        await page.keyboard.press("Tab")
        reached = await target.evaluate((element) => element === document.activeElement)
      }
      assert.ok(reached, "el botón Editar es alcanzable con Tab")
      const ring = await target.evaluate((element) => {
        const computed = getComputedStyle(element)
        return computed.outlineStyle !== "none" || computed.boxShadow !== "none"
      })
      assert.ok(ring, "indicador de foco visible")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: contraste AA en lectura y en edición (con desplegables abiertos)`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      await settled(page)
      const read = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.ok(read.audited > 40, `se auditaron ${read.audited} textos`)
      assert.deepEqual(read.failures, [], "lectura")
      await page.locator("[data-andreani-detail] summary").click()
      await page.locator("[data-shipping-reference] summary").click()
      for (const name of EDITABLE) await edit(page, name)
      await configBlock(page, "pricing").getByLabel("Descuento por transferencia").fill("% 15")
      await configBlock(page, "stock").getByLabel("Bajo").fill("1")
      await settled(page)
      const editing = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.deepEqual(editing.failures, [], "edición, cambios sin guardar, error de validación y desplegables")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: mobile (390px): una columna, lectura compacta, inputs a ancho completo sólo en edición, sin overflow`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED), 390)
    try {
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok((await overflow()) <= 0, `desborde en lectura: ${await overflow()}px`)
      const [integraciones, inventario] = await Promise.all([
        page.locator("[data-config-group='integraciones']").boundingBox(),
        page.locator("[data-config-group='inventario']").boundingBox(),
      ])
      assert.ok(integraciones && inventario && inventario.y >= integraciones.y + integraciones.height, "grupos apilados")
      const editButton = await configBlock(page, "shipping").locator("[data-config-edit]").boundingBox()
      assert.ok(editButton && editButton.x + editButton.width <= 390, "Editar visible")

      for (const name of EDITABLE) await edit(page, name)
      assert.ok((await overflow()) <= 0, `desborde en edición: ${await overflow()}px`)
      const [input, rowBox] = await Promise.all([
        configBlock(page, "shipping").getByLabel("Monto mínimo para acceder a envío bonificado").boundingBox(),
        row(page, "shipping", "Compra mínima").boundingBox(),
      ])
      assert.ok(input && rowBox && input.width >= rowBox.width - 2, "input a ancho completo en mobile")
    } finally {
      await page.close()
    }
  })
}
