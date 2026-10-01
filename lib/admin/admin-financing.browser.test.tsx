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
  MANUAL,
  OBSERVED,
  SETTINGS,
} from "./admin-config-browser-harness.ts"

// Admin → Financiación con el componente REAL (AdminFinanciacion, bundle
// esbuild) en claro y oscuro, desktop y mobile: estado, promoción actual
// (lo que confirma Mercado Pago, sin mínimos propios), comunicación pública,
// costos 1/2/3/6 con su fuente y disponibilidad, Automático vs Manual
// (advertencia ámbar), cuotas sin interés ON/OFF, historial y AA.

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

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: Automático usa lo observado (1 pago y 6 cuotas) y Manual lo ignora con advertencia ámbar`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const automatic = page.getByRole("radio", { name: /Automático/ })
      const manual = page.getByRole("radio", { name: /Manual/ })
      assert.equal(await automatic.getAttribute("aria-checked"), "true")
      for (const block of ["estado", "promocion", "comunicacion", "costos", "reglas", "historial"]) {
        assert.equal(await page.locator(`[data-financing-block='${block}']`).count(), 1, block)
      }
      // 4,25% con IVA = 3,51% sin IVA (1 pago); 24,2% con IVA = 20% sin IVA (6 cuotas).
      const base = page.locator("[data-cost-row='1 pago']")
      await base.getByText("3,51%", { exact: true }).first().waitFor()
      await base.getByText("Manual: 3,46%").waitFor()
      const six = page.locator("[data-cost-row='6 cuotas']")
      await six.getByText("20%", { exact: true }).first().waitFor()
      assert.equal(await six.getByText("Observado", { exact: true }).count(), 1)
      assert.equal(await page.locator("[data-cost-row='3 cuotas']").getByText("Respaldo", { exact: true }).count(), 1)
      // Historial: el cambio detectado en un pago real, aplicado a ventas futuras.
      const history = page.locator("[data-cost-history] li").first()
      await history.getByText("18,69% → 20%").waitFor()
      await history.getByText("Aplicado automáticamente para ventas futuras.").waitFor()
      assert.equal(await page.locator("[data-manual-warning]").count(), 0)

      await manual.click()
      assert.equal(await manual.getAttribute("aria-checked"), "true")
      await page
        .getByText("Estás usando valores manuales. BEYONIX dejará de usar automáticamente los costos observados hasta volver al modo Automático.")
        .waitFor()
      const panel = page.locator(".admin-financing-manual")
      assert.equal(await panel.count(), 1, "borde/estado ámbar del panel")
      const borderColor = await panel.evaluate((element) => getComputedStyle(element).borderTopColor)
      assert.equal(borderColor, theme === "light" ? "rgb(217, 119, 6)" : "rgb(251, 191, 36)", "borde ámbar")
      assert.equal(await page.locator("[data-financing-block='costos']").getByText("Observado", { exact: true }).count(), 0, "manual nunca usa observaciones")

      await page.getByText("Cambios sin guardar").waitFor()
      await page.getByRole("button", { name: /Guardar cambios/ }).click()
      await page.getByText(/Guardado\./).waitFor()
      const patches = (await page.evaluate("window.__patches")) as Array<Record<string, unknown>>
      assert.deepEqual(patches, [
        {
          installmentsFinancing: {
            ...MANUAL,
            mode: "manual",
            interestFreePolicy: { enabled: true },
          },
        },
      ])
      await page.getByText("Sin cambios").waitFor()

      // Volver a Automático retoma lo observado.
      await automatic.click()
      await six.getByText("Observado", { exact: true }).waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: cuotas sin interés OFF se guarda y avisa que BEYONIX no comunica "sin interés"`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      const toggle = page.locator("[data-interest-free-toggle]")
      assert.equal(await toggle.getAttribute("aria-pressed"), "true")
      await toggle.click()
      assert.equal(await toggle.getAttribute("aria-pressed"), "false")
      await page.locator("[data-interest-free-off]").waitFor()
      await page.getByRole("button", { name: /Guardar cambios/ }).click()
      await page.getByText(/Guardado\./).waitFor()
      const [patch] = (await page.evaluate("window.__patches")) as Array<{ installmentsFinancing: { interestFreePolicy: { enabled: boolean } } }>
      assert.equal(patch.installmentsFinancing.interestFreePolicy.enabled, false)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: promoción actual = lo que confirma Mercado Pago (sin mínimos propios), por cuota y con marcas`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED, { reference: REFERENCE, offer: OFFER }))
    try {
      // Ningún control de mínimos propios.
      assert.equal(await page.getByLabel(/Mínimo BEYONIX/).count(), 0)
      assert.equal(await page.getByText("Mínimo BEYONIX").count(), 0)
      const max = page.locator("[data-confirmed-max]")
      await max.getByText("6 cuotas sin interés", { exact: true }).waitFor()
      await max.getByText("$ 67.000", { exact: true }).waitFor()
      await max.getByText("Visa", { exact: true }).waitFor()
      const three = page.locator("[data-availability-row='3']")
      await three.getByText("Desde aprox. $ 44.000").waitFor()
      await three.getByText("Visa · Mastercard").waitFor()
      await page.locator("[data-availability-row='2']").getByText("Desde aprox. $ 31.000").waitFor()
      await page.locator("[data-availability-row='6']").getByText("Visa", { exact: true }).waitFor()
      await page.locator("[data-public-message]").getByText("“Hasta 6 cuotas sin interés a partir de $ 67.000 con Visa”").waitFor()
      // Costos: 1 pago, 2, 3 y 6, cada cuota con su disponibilidad actual.
      for (const label of ["1 pago", "2 cuotas", "3 cuotas", "6 cuotas"]) {
        assert.equal(await page.locator(`[data-cost-row='${label}']`).count(), 1, label)
      }
      await page.locator("[data-cost-row='6 cuotas'] [data-availability='available']").getByText("Desde aprox. $ 67.000").waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: sin referencia lo dice; "Comprobar ahora" consulta Mercado Pago y muestra lo detectado`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED))
    try {
      assert.equal(await page.locator("[data-availability-row='6']").getByText("Sin comprobar").count(), 1)
      await page.locator("[data-public-message]").getByText("Ninguna: no hay promoción confirmada y vigente para comunicar.").waitFor()
      await page.locator("[data-check-reference]").click()
      await page.locator("[data-availability-row='6']").getByText("Desde aprox. $ 67.000").waitFor()
      await page.locator("[data-reference-checked]").waitFor()
      await page.locator("[data-confirmed-max]").getByText("6 cuotas sin interés", { exact: true }).waitFor()
      await page.locator("[data-public-message]").getByText("Hasta 6 cuotas sin interés a partir de $ 67.000 con Visa", { exact: false }).waitFor()
      assert.equal(await page.evaluate("window.__referenceChecks"), 1)
    } finally {
      await page.close()
    }
  })

  test(`${theme}: si Mercado Pago sólo confirma 2 cuotas: hasta 2; 3 y 6 no disponibles pero conservan su histórico de costos`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED, { reference: TWO_ONLY_REFERENCE, offer: TWO_ONLY_OFFER }))
    try {
      await page.locator("[data-confirmed-max]").getByText("2 cuotas sin interés", { exact: true }).waitFor()
      await page.locator("[data-confirmed-max]").getByText("Visa · Mastercard", { exact: true }).waitFor()
      for (const count of [3, 6]) {
        await page.locator(`[data-availability-row='${count}']`).getByText("No disponible hoy").waitFor()
      }
      await page.locator("[data-public-message]").getByText("“Hasta 2 cuotas sin interés a partir de $ 31.000”").waitFor()
      // 6 cuotas no está disponible hoy, pero su costo observado sigue a la vista (no se borra el histórico).
      const six = page.locator("[data-cost-row='6 cuotas']")
      await six.locator("[data-availability='unavailable']").getByText("No disponible hoy").waitFor()
      await six.getByText("20%", { exact: true }).first().waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: si Mercado Pago falla se avisa con hora, motivo y última consulta exitosa; no se comunica promoción`, async () => {
    const page = await open(
      theme,
      costsOverview("automatic", OBSERVED, { reference: REFERENCE, syncError: "Mercado Pago no respondió a tiempo." }),
    )
    try {
      const sync = page.locator("[data-mercadopago-sync]")
      await sync.getByText("⚠ Mercado Pago no pudo verificarse").waitFor()
      await sync.locator("[data-sync-error]").getByText("Mercado Pago no respondió a tiempo.", { exact: false }).waitFor()
      await sync.locator("[data-sync-error]").getByText("Falló:", { exact: false }).waitFor()
      await sync.locator("[data-last-success]").getByText("Última consulta exitosa:", { exact: false }).waitFor()
      await page.locator("[data-public-message]").getByText("Ninguna", { exact: false }).waitFor()
      assert.equal(await sync.getAttribute("data-tone"), "danger")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: todo el texto visible de Financiación cumple contraste AA (automático y manual)`, async () => {
    const page = await open(theme, costsOverview("automatic", OBSERVED, { reference: REFERENCE }))
    try {
      await settled(page)
      const { audited, failures } = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.ok(audited > 60, `se auditaron ${audited} textos`)
      assert.deepEqual(failures, [])
      await page.getByRole("radio", { name: /Manual/ }).click()
      await page.locator("[data-interest-free-toggle]").click()
      await settled(page)
      const manualAudit = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.deepEqual(manualAudit.failures, [], "modo manual y cuotas desactivadas")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: en mobile (390px) no hay scroll horizontal`, async () => {
    const page = await open(theme, costsOverview("manual", OBSERVED, { reference: REFERENCE }), 390)
    try {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 0, `desborde horizontal de ${overflow}px`)
    } finally {
      await page.close()
    }
  })
}
