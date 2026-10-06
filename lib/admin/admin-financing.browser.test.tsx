import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { chromium, type Browser, type Locator, type Page } from "playwright-core"

import {
  adminConfigStubs,
  adminPageHtml,
  CONTRAST_AUDIT,
  costsOverview,
  MANUAL,
  OBSERVED,
  SETTINGS,
} from "./admin-config-browser-harness.ts"

// Admin → Financiación con el componente REAL (AdminFinanciacion, bundle
// esbuild) en claro y oscuro, desktop y mobile. Cuatro bloques: Estado,
// Cuotas disponibles (con el texto publicado y "Cómo funciona" colapsado),
// Costos (lectura en Automático, edición en Manual o a pedido) e Historial
// compacto. Lo técnico va en desplegables cerrados por defecto.

// Umbrales arbitrarios de prueba (no son reglas de negocio).
const REFERENCE = {
  checkedAt: "2026-10-01T12:00:00.000Z",
  minimumAmountByCount: { 2: 31_000, 3: 44_000, 6: 67_000 },
  brandsByCount: { 2: ["visa", "master"], 3: ["visa", "master"], 6: ["visa"] },
  maxProbedAmount: 2_000_000,
}
const OFFER = {
  checkedAt: REFERENCE.checkedAt,
  tiers: [
    { count: 2, minimumAmount: 31_000, brands: ["visa", "master"] },
    { count: 3, minimumAmount: 44_000, brands: ["visa", "master"] },
    { count: 6, minimumAmount: 67_000, brands: ["visa"] },
  ],
}
// Respuesta real de la cuenta hoy: sólo 2 cuotas sin interés.
const TWO_ONLY_REFERENCE = {
  checkedAt: "2026-10-01T12:00:00.000Z",
  minimumAmountByCount: { 2: 31_000, 3: null, 6: null },
  brandsByCount: { 2: ["visa", "master"], 3: [], 6: [] },
  maxProbedAmount: 2_000_000,
}
const TWO_ONLY_OFFER = { checkedAt: REFERENCE.checkedAt, tiers: [OFFER.tiers[0]] }
// Ocho cambios de costo: el historial muestra 5 y despliega el resto.
const LONG_HISTORY = {
  ...OBSERVED,
  history: Array.from({ length: 8 }, (_, index) => ({
    modality: "credit_6" as const,
    previousPercentWithIva: 22 + index,
    percentWithIva: 23 + index,
    observedAt: `2026-09-${String(20 + index).padStart(2, "0")}T10:00:00.000Z`,
    orderId: 30 + index,
  })).reverse(),
}

const entry = (costs: unknown) => `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { AdminFinanciacion } from "@/app/admin/sections/financiacion/admin-financiacion"
window.__patches = []
window.__referenceChecks = 0
let costs = ${JSON.stringify(costs)}
window.fetch = async (input, init) => {
  const path = String(input)
  if (path === "/api/admin/financiacion/referencia-mercadopago") {
    window.__referenceChecks += 1
    costs = {
      ...costs,
      interestFreeStatus: { reference: ${JSON.stringify(REFERENCE)}, lastAttemptAt: ${JSON.stringify(REFERENCE.checkedAt)}, lastError: null, lastFailure: null },
      interestFreeOffer: ${JSON.stringify(OFFER)},
    }
    return Response.json({ mercadoPagoCosts: costs })
  }
  if (path === "/api/admin/settings") {
    if (init && init.method === "PATCH") {
      const body = JSON.parse(init.body)
      window.__patches.push(body)
      const { mode, interestFreePolicy } = body.installmentsFinancing
      costs = { ...costs, mode, interestFreePolicy }
    }
    return Response.json({ settings: ${JSON.stringify(SETTINGS)}, mercadoPagoCosts: costs })
  }
  return Response.json({})
}
createRoot(document.getElementById("root")).render(createElement(AdminFinanciacion))
`

let browser: Browser
let css: string
const bundles = new Map<string, string>()

async function bundleFor(costs: unknown) {
  const key = JSON.stringify(costs)
  const cached = bundles.get(key)
  if (cached) return cached
  const result = await build({
    stdin: { contents: entry(costs), resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-financing-entry.tsx" },
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
  const page = await browser.newPage({ viewport: { width, height: 1100 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) =>
    route.request().url() === "http://admin.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml(theme, css, bundle) })
      : route.abort(),
  )
  await page.goto("http://admin.test/")
  try {
    await page.locator("[data-financing-block='costos']").waitFor({ timeout: 10_000 })
    await page.getByRole("radio", { name: /Automático/ }).and(page.locator(":not([disabled])")).waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

const settled = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)))

const block = (page: Page, name: string) => page.locator(`[data-financing-block='${name}']`)
const costRow = (page: Page, label: string) => page.locator(`[data-cost-row='${label}']`)
const costInputs = (page: Page) => block(page, "costos").locator("input")
const sourceChip = (scope: Locator, text: string) => scope.locator(".admin-config-chip").getByText(text, { exact: true })

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: cuatro bloques principales; reglas y detalle técnico colapsados`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED, { reference: REFERENCE, offer: OFFER }))
    try {
      const blocks = await page.locator("[data-financing-block]").evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-financing-block")),
      )
      assert.deepEqual(blocks, ["estado", "cuotas", "costos", "historial"])
      if (theme === "light") {
        for (const name of ["estado", "cuotas", "costos", "historial"]) {
          assert.equal(
            await block(page, name).evaluate((element) => getComputedStyle(element).backgroundColor),
            "rgb(255, 255, 255)",
            name,
          )
        }
      }
      // Jerarquía por superficie: sección → card → subcard (modalidad de costo) → desglose/campo.
      const surfaceOf = (selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor)
      const surfaces = {
        cluster: await surfaceOf(".admin-config-cluster"),
        card: await surfaceOf("[data-financing-block='costos']"),
        row: await surfaceOf("[data-cost-list] > li"),
        breakdown: await surfaceOf("[data-cost-list] .admin-config-breakdown"),
      }
      assert.equal(new Set([surfaces.cluster, surfaces.card, surfaces.row]).size, 3, `niveles distintos: ${JSON.stringify(surfaces)}`)
      assert.notEqual(surfaces.breakdown, surfaces.row, "el desglose se distingue de su fila")
      for (const color of Object.values(surfaces)) assert.doesNotMatch(color, /rgba\(.*, 0(\.\d+)?\)$/, `superficie sólida: ${color}`)
      // Lo técnico se despliega: "Cómo funciona" y "Ver detalle" cerrados.
      for (const selector of ["[data-financing-rules]", "[data-sync-detail]"]) {
        assert.equal(await page.locator(selector).evaluate((element) => (element as HTMLDetailsElement).open), false, selector)
      }
      assert.equal(await page.getByText("Manda el total final", { exact: false }).isVisible(), false)
      await page.locator("[data-financing-rules] summary").click()
      await page.getByText("Se ofrece exactamente lo que confirma Mercado Pago", { exact: false }).waitFor()
      // Desktop: Estado y Cuotas lado a lado.
      const [estado, cuotas] = await Promise.all([block(page, "estado").boundingBox(), block(page, "cuotas").boundingBox()])
      assert.ok(estado && cuotas && Math.abs(estado.y - cuotas.y) < 2 && cuotas.x > estado.x, "dos columnas en desktop")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Automático prioriza lectura (sin inputs) y "Editar respaldo manual" los muestra`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const estado = block(page, "estado")
      assert.equal(await page.getByRole("radio", { name: /Automático/ }).getAttribute("aria-checked"), "true")
      await estado.locator("[data-mode-state='automatic']").getByText("Automático", { exact: true }).waitFor()
      assert.equal(await page.locator("[data-manual-warning]").count(), 0)
      assert.equal(await costInputs(page).count(), 0, "en Automático no hay inputs a la vista")

      // 4,25% con IVA = 3,51% sin IVA (1 pago); 24,2% con IVA = 20% sin IVA (6 cuotas).
      await costRow(page, "1 pago").locator("[data-cost-effective]").getByText("3,51%").waitFor()
      assert.equal(await sourceChip(costRow(page, "1 pago"), "Observado").count(), 1)
      await costRow(page, "6 cuotas").locator("[data-cost-effective]").getByText("20%").waitFor()
      assert.equal(await sourceChip(costRow(page, "3 cuotas"), "Respaldo").count(), 1)
      await costRow(page, "IVA").getByText("21%", { exact: true }).waitFor()

      const edit = page.locator("[data-edit-backup]")
      assert.equal(await edit.getAttribute("aria-expanded"), "false")
      await edit.click()
      assert.equal(await costInputs(page).count(), 5, "1 pago, 2, 3, 6 cuotas e IVA")
      await page.getByLabel("6 cuotas: valor respaldo").fill("19,5")
      await page.getByText("Cambios sin guardar").waitFor()
      await page.getByRole("button", { name: /Guardar cambios/ }).click()
      await page.getByText(/Guardado\./).waitFor()
      const [patch] = (await page.evaluate("window.__patches")) as Array<{ installmentsFinancing: Record<string, unknown> }>
      assert.deepEqual(patch.installmentsFinancing, {
        ...MANUAL,
        surchargePercentByCount: { ...MANUAL.surchargePercentByCount, 6: 19.5 },
        mode: "automatic",
        interestFreePolicy: { enabled: true },
      })
    } finally {
      await page.close()
    }
  })

  test(`${theme}: Manual muestra los campos editables directamente y la advertencia ámbar`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const manual = page.getByRole("radio", { name: /Manual/ })
      await manual.click()
      assert.equal(await manual.getAttribute("aria-checked"), "true")
      await page
        .getByText("Estás usando valores manuales. BEYONIX dejará de usar automáticamente los costos observados hasta volver al modo Automático.")
        .waitFor()
      assert.equal(await page.locator("[data-edit-backup]").count(), 0, "en Manual no hace falta el botón")
      assert.equal(await costInputs(page).count(), 5)
      await page.getByLabel("1 pago: valor manual").waitFor()
      assert.equal(await sourceChip(block(page, "costos"), "Observado").count(), 0, "manual nunca usa observaciones")

      // El modo Manual se comunica con el selector, los chips y el aviso: sin franja ni borde ámbar estructural.
      for (const name of ["estado", "costos"]) {
        const surface = await block(page, name).evaluate((element) => {
          const style = getComputedStyle(element)
          return { shadow: style.boxShadow, left: style.borderLeftColor, top: style.borderTopColor }
        })
        assert.doesNotMatch(surface.shadow, /inset 3px/, `${name}: sin franja lateral`)
        for (const color of [surface.left, surface.top]) {
          assert.ok(!["rgb(217, 119, 6)", "rgb(251, 191, 36)"].includes(color), `${name}: sin borde ámbar (${color})`)
        }
      }

      await page.getByRole("button", { name: /Guardar cambios/ }).click()
      await page.getByText(/Guardado\./).waitFor()
      assert.deepEqual(await page.evaluate("window.__patches"), [
        { installmentsFinancing: { ...MANUAL, mode: "manual", interestFreePolicy: { enabled: true } } },
      ])
      await page.getByText("Sin cambios").waitFor()

      // Volver a Automático retoma lo observado.
      await page.getByRole("radio", { name: /Automático/ }).click()
      await sourceChip(costRow(page, "6 cuotas"), "Observado").waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: cada fila desglosa base + financiación = total sin IVA y el total final con IVA`, async () => {
    // Manual: base 3,46%, extra 2/3/6 = 7,79/10,49/18,69%, IVA 21% (valores de Mercado Pago).
    const page = await open(theme, costsOverview("manual", OBSERVED))
    try {
      const breakdown = async (label: string) =>
        Object.fromEntries(
          await costRow(page, label)
            .locator("[data-cost-breakdown] [data-breakdown]")
            .evaluateAll((items) =>
              items.map((item) => [
                item.getAttribute("data-breakdown"),
                `${item.querySelector("dt")?.textContent} ${item.querySelector("dd")?.textContent}`,
              ]),
            ),
        )
      assert.deepEqual(await breakdown("1 pago"), {
        base: "Costo base MP 3,46%",
        "total-iva": "Total final con IVA 4,19%",
      })
      for (const [label, financing, total, totalWithIva] of [
        ["2 cuotas", "7,79%", "11,25%", "13,61%"],
        ["3 cuotas", "10,49%", "13,95%", "16,88%"],
        ["6 cuotas", "18,69%", "22,15%", "26,80%"],
      ]) {
        assert.deepEqual(
          await breakdown(label),
          {
            base: "Costo base MP 3,46%",
            financing: `Financiación ${financing}`,
            total: `Total MP sin IVA ${total}`,
            "total-iva": `Total final con IVA ${totalWithIva}`,
          },
          label,
        )
      }
      assert.equal(await costRow(page, "IVA").locator("[data-cost-breakdown]").count(), 0)
      // El valor de la fila dice qué es: la financiación, nunca el total.
      await costRow(page, "6 cuotas").getByText("Financiación en uso", { exact: true }).waitFor()
      await costRow(page, "1 pago").getByText("Costo base MP en uso", { exact: true }).waitFor()
      await block(page, "costos").getByText("Comisiones sin IVA; el total final incluye IVA").waitFor()

      // Sólo presentación: editar la financiación actualiza el desglose y lo guardado sigue siendo el extra.
      await page.getByLabel("6 cuotas: valor manual").fill("20")
      await costRow(page, "6 cuotas").locator("[data-breakdown='total']").getByText("23,46%").waitFor()
      await page.getByRole("button", { name: /Guardar cambios/ }).click()
      await page.getByText(/Guardado\./).waitFor()
      const [patch] = (await page.evaluate("window.__patches")) as Array<{ installmentsFinancing: typeof MANUAL }>
      assert.deepEqual(patch.installmentsFinancing.surchargePercentByCount, { ...MANUAL.surchargePercentByCount, 6: 20 })
      assert.equal(patch.installmentsFinancing.baseProcessingPercent, MANUAL.baseProcessingPercent)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: cuotas sin interés OFF se guarda y lo dice en una línea`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED, { reference: REFERENCE, offer: OFFER }))
    try {
      const toggle = page.locator("[data-interest-free-toggle]")
      assert.equal(await toggle.getAttribute("aria-pressed"), "true")
      await toggle.click()
      assert.equal(await toggle.getAttribute("aria-pressed"), "false")
      await page.locator("[data-interest-free-off]").waitFor()
      await page.locator("[data-mercadopago-status='paused']").waitFor()
      await block(page, "cuotas").getByText("Cuotas desactivadas", { exact: true }).waitFor()
      await page.getByRole("button", { name: /Guardar cambios/ }).click()
      await page.getByText(/Guardado\./).waitFor()
      const [patch] = (await page.evaluate("window.__patches")) as Array<{ installmentsFinancing: { interestFreePolicy: { enabled: boolean } } }>
      assert.equal(patch.installmentsFinancing.interestFreePolicy.enabled, false)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: promoción activa en primer plano (máximo, desde, marcas) y texto publicado como preview`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED, { reference: REFERENCE, offer: OFFER }))
    try {
      const cuotas = block(page, "cuotas")
      assert.equal(await cuotas.locator("[data-confirmed-max]").getAttribute("data-confirmed-max"), "6")
      await cuotas.getByText("Hasta 6 cuotas sin interés", { exact: true }).waitFor()
      await cuotas.getByText("$ 67.000", { exact: true }).waitFor()
      await cuotas.locator("[data-confirmed-brands]").getByText("Visa", { exact: true }).waitFor()
      for (const count of [2, 3, 6]) {
        assert.equal(await page.locator(`[data-availability-row='${count}']`).getAttribute("data-availability"), "available", String(count))
      }
      await page.locator("[data-public-message]").getByText("“Hasta 6 cuotas sin interés a partir de $ 67.000 con Visa”").waitFor()
      await page.locator("[data-mercadopago-status='synced']").getByText("Sincronizado").waitFor()
      assert.equal(await block(page, "costos").getByText("No disponible hoy").count(), 0)
      // Sin controles de mínimos propios.
      assert.equal(await page.getByLabel(/Mínimo BEYONIX/).count(), 0)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: si Mercado Pago sólo confirma 2: hasta 2; 3 y 6 secundarias y con su costo guardado`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED, { reference: TWO_ONLY_REFERENCE, offer: TWO_ONLY_OFFER }))
    try {
      const cuotas = block(page, "cuotas")
      await cuotas.getByText("Hasta 2 cuotas sin interés", { exact: true }).waitFor()
      await cuotas.locator("[data-confirmed-brands]").getByText("Visa · Mastercard", { exact: true }).waitFor()
      assert.equal(await page.locator("[data-availability-row='2']").getAttribute("data-availability"), "available")
      for (const count of [3, 6]) {
        assert.equal(await page.locator(`[data-availability-row='${count}']`).getAttribute("data-availability"), "unavailable")
      }
      await page.locator("[data-public-message]").getByText("“Hasta 2 cuotas sin interés a partir de $ 31.000”").waitFor()
      for (const label of ["3 cuotas", "6 cuotas"]) {
        const row = costRow(page, label)
        await row.getByText("No disponible hoy").waitFor()
        await row.getByText("Financiación (guardado)").waitFor()
      }
      // 6 cuotas no está disponible hoy pero conserva su costo observado (no se borra el histórico).
      await costRow(page, "6 cuotas").locator("[data-cost-effective]").getByText("20%").waitFor()
      assert.equal(await costRow(page, "2 cuotas").getByText("No disponible hoy").count(), 0)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: error de Mercado Pago: estado rojo corto; el detalle técnico sólo en "Ver detalle"`, async () => {
    const page = await open(
      theme,
      costsOverview("automatic", OBSERVED, { reference: REFERENCE, syncError: "Mercado Pago no respondió a tiempo." }),
    )
    try {
      await page.locator("[data-mercadopago-status='failed']").getByText("No se pudo verificar").waitFor()
      await page.locator("[data-mercadopago-sync]").waitFor()
      const error = page.locator("[data-sync-error]")
      assert.equal(await error.isVisible(), false, "el motivo técnico está colapsado")
      await page.locator("[data-sync-detail] summary").click()
      await error.getByText("Motivo: Mercado Pago no respondió a tiempo.", { exact: false }).waitFor()
      await error.getByText("Falló:", { exact: false }).waitFor()
      await page.locator("[data-last-success]").getByText("Última consulta exitosa:", { exact: false }).waitFor()
      await page.locator("[data-public-message]").getByText("Ninguno", { exact: false }).waitFor()
      await block(page, "cuotas").getByText("Último dato verificado").waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: sin referencia lo dice; "Comprobar ahora" consulta Mercado Pago y muestra lo detectado`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      await page.locator("[data-mercadopago-status='unchecked']").waitFor()
      await block(page, "cuotas").getByText("Sin comprobar", { exact: true }).waitFor()
      assert.equal(await page.locator("[data-availability-row='6']").getAttribute("data-availability"), "unchecked")
      await page.locator("[data-check-reference]").click()
      await block(page, "cuotas").getByText("Hasta 6 cuotas sin interés", { exact: true }).waitFor()
      await page.locator("[data-mercadopago-status='synced']").waitFor()
      await page.locator("[data-public-message]").getByText("Hasta 6 cuotas sin interés a partir de $ 67.000 con Visa", { exact: false }).waitFor()
      assert.equal(await page.evaluate("window.__referenceChecks"), 1)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: historial compacto (5 recientes) con "Ver historial completo"`, async () => {
    const page = await open(theme, costsOverview("automatic", LONG_HISTORY))
    try {
      const items = page.locator("[data-cost-history] > li")
      assert.equal(await items.count(), 5)
      const first = items.first()
      await first.getByText("6 cuotas", { exact: true }).waitFor()
      await first.getByText("Detectado en pago real · Aplicado automáticamente", { exact: false }).waitFor()
      const toggle = page.locator("[data-history-toggle]")
      await toggle.getByText("Ver historial completo (8)").waitFor()
      await toggle.click()
      assert.equal(await items.count(), 8)
      await toggle.getByText("Ver menos").waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: todo el texto visible de Financiación cumple contraste AA (automático, manual y desplegables)`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED, { reference: REFERENCE, offer: OFFER }))
    try {
      await settled(page)
      const { audited, failures } = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.ok(audited > 50, `se auditaron ${audited} textos`)
      assert.deepEqual(failures, [])
      await page.locator("[data-financing-rules] summary").click()
      await page.locator("[data-sync-detail] summary").click()
      await page.getByRole("radio", { name: /Manual/ }).click()
      await page.locator("[data-interest-free-toggle]").click()
      await settled(page)
      const manualAudit = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.deepEqual(manualAudit.failures, [], "modo manual, cuotas desactivadas y desplegables abiertos")
    } finally {
      await page.close()
    }
    const failing = await open(theme, costsOverview("automatic", OBSERVED, { reference: REFERENCE, syncError: "Mercado Pago no respondió a tiempo." }))
    try {
      await failing.locator("[data-sync-detail] summary").click()
      await settled(failing)
      const { failures } = (await failing.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.deepEqual(failures, [], "error de Mercado Pago")
    } finally {
      await failing.close()
    }
  })

  test(`${theme}: en mobile (390px) una columna, sin scroll horizontal y con acciones accesibles`, async () => {
    const page = await open(theme, costsOverview("manual", OBSERVED, { reference: REFERENCE, offer: OFFER }), 390)
    try {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 0, `desborde horizontal de ${overflow}px`)
      const [estado, cuotas] = await Promise.all([block(page, "estado").boundingBox(), block(page, "cuotas").boundingBox()])
      assert.ok(estado && cuotas && cuotas.y > estado.y + estado.height - 1, "bloques apilados")
      for (const selector of ["[data-check-reference]", "[data-interest-free-toggle]"]) {
        const box = await page.locator(selector).boundingBox()
        assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${selector} dentro de la pantalla`)
      }
    } finally {
      await page.close()
    }
  })
}
