import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

import { addDays } from "../business/dashboard-sales-analytics.ts"
import { argentinaDateKey } from "../business/dashboard-timezone.ts"
import { buildProductViewReport, type AnalyticsDateRange, type ProductViewStatsRow } from "./product-view-report.ts"

// Admin > Analítica > Productos más vistos con el componente REAL y el CSS del
// proyecto. Sólo se simulan la sesión de Supabase y la API (que responde con
// el mismo armado de reporte que usa el servidor).

const stubs: Plugin = {
  name: "admin-analytics-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/lib/supabase/client": `export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: "admin-token" } } }) } }`,
      "next/image": `import { createElement } from "react"; export default function Image({ src, alt, fill, sizes, ...props }) { return createElement("img", { ...props, src: String(src), alt, style: fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : undefined }) }`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const NAMES = [
  "Auricular Malibu", "Soporte Notebook HUB", "Pava 12V", "Lámpara Ñandú de escritorio con brazo articulado y nombre muy largo",
  "Ventilador", "Mouse inalámbrico", "Teclado mecánico", "Parlante", "Cargador USB-C", "Hub USB", "Cable HDMI", "Webcam",
]
const VIEWS = [245, 180, 95, 60, 40, 30, 20, 15, 10, 8, 5, 2]
const ROWS: ProductViewStatsRow[] = NAMES.map((name, index) => ({
  productId: index + 1, name, slug: `producto-${index + 1}`, image: index === 0 ? "https://img.test/malibu.svg" : null, views: VIEWS[index],
}))

const TODAY = argentinaDateKey(new Date())
const SHOTS = process.env.ADMIN_ANALYTICS_SHOTS

let browser: Browser
let bundle: string
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: {
      contents: `import React from "react"; import { createRoot } from "react-dom/client"; import { AdminAnalitica } from "./app/admin/sections/analitica/admin-analitica.tsx";
        createRoot(document.getElementById("root")).render(<AdminAnalitica />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-analytics-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

type Responder = (range: AnalyticsDateRange) => ProductViewStatsRow[]

async function openAnalytics(width: number, theme: "dark" | "light", responder: Responder = () => ROWS) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const requests: { range: AnalyticsDateRange; authorization: string | null }[] = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  // Playwright evalúa las rutas en orden inverso: la del HTML va primero para que la API la pise.
  await page.route("http://admin.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html data-admin-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>*,*::before,*::after{transition:none!important}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white lg:flex"><div class="hidden lg:block"><aside class="beyonix-admin-sidebar"></aside></div><main class="beyonix-admin-main min-w-0 flex-1"><div id="root"></div></main></div><script>window.process={env:{NODE_ENV:"production"}}</script><script>${bundle}</script></body></html>`,
  }))
  await page.route("**/api/admin/analytics/product-views**", (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    requests.push({ range, authorization: route.request().headers().authorization ?? null })
    return route.fulfill({ json: buildProductViewReport(range, responder(range)) })
  })
  await page.route("https://img.test/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ccc"/></svg>` }))
  await page.goto("http://admin.test/admin/analitica")
  return { page, requests, errors }
}

const waitForRequests = async (requests: unknown[], count: number) => {
  const deadline = Date.now() + 5_000
  while (requests.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(requests.length >= count, `esperaba ${count} consultas, hubo ${requests.length}`)
}

const lastRange = (requests: { range: AnalyticsDateRange }[]) => requests.at(-1)?.range

test("filtros: Hoy, 7 días, 30 días y rango personalizado consultan el período correcto", async () => {
  const { page, requests } = await openAnalytics(1440, "dark")
  try {
    await waitForRequests(requests, 1)
    assert.deepEqual(lastRange(requests), { from: addDays(TODAY, -6), to: TODAY }, "por defecto: últimos 7 días")
    assert.equal(requests[0].authorization, "Bearer admin-token")

    await page.getByRole("button", { name: "Hoy" }).click()
    await waitForRequests(requests, 2)
    assert.deepEqual(lastRange(requests), { from: TODAY, to: TODAY })

    await page.getByRole("button", { name: "Últimos 30 días" }).click()
    await waitForRequests(requests, 3)
    assert.deepEqual(lastRange(requests), { from: addDays(TODAY, -29), to: TODAY })

    await page.getByRole("button", { name: "Últimos 7 días" }).click()
    await waitForRequests(requests, 4)
    assert.deepEqual(lastRange(requests), { from: addDays(TODAY, -6), to: TODAY })

    await page.getByRole("button", { name: "Personalizado" }).click()
    await page.getByText("Elegí la fecha inicial del período.").waitFor()
    assert.equal(requests.length, 4, "sin fecha inicial no consulta")
    const from = page.getByRole("textbox", { name: "Fecha inicial" })
    await from.fill("01/10/2026")
    await from.press("Tab")
    await page.keyboard.press("Escape")
    const to = page.getByRole("textbox", { name: "Fecha final" })
    await to.fill("15/10/2026")
    await to.press("Tab")
    await page.keyboard.press("Escape")
    const deadline = Date.now() + 5_000
    while (JSON.stringify(lastRange(requests)) !== JSON.stringify({ from: "2026-10-01", to: "2026-10-15" }) && Date.now() < deadline) {
      await page.waitForTimeout(50)
    }
    assert.deepEqual(lastRange(requests), { from: "2026-10-01", to: "2026-10-15" })
    await page.getByText("1 oct – 15 oct 2026").waitFor()

    const before = requests.length
    await from.fill("20/10/2026")
    await from.press("Tab")
    await page.getByRole("alert").filter({ hasText: "“Desde” no puede ser posterior a “Hasta”" }).waitFor()
    await page.waitForTimeout(200)
    assert.equal(requests.length, before, "rango invertido no consulta")
  } finally { await page.close() }
})

async function readReport(page: Page) {
  await page.locator(".admin-analytics-ranking-row:not(.admin-analytics-ranking-head)").first().waitFor()
  return page.locator(".admin-analytics-page").evaluate((root) => {
    const metrics = Array.from(root.querySelectorAll<HTMLElement>(".admin-dashboard-kpi"), (card) => card.innerText.replace(/\s+/g, " ").trim())
    const ranking = Array.from(root.querySelectorAll(".admin-analytics-ranking-row:not(.admin-analytics-ranking-head)"), (row) =>
      Array.from(row.querySelectorAll("[role=cell]"), (cell) => cell.textContent?.trim() ?? ""))
    const bars = Array.from(root.querySelectorAll(".admin-analytics-bar-row"), (row) => ({
      label: row.getAttribute("aria-label") ?? "",
      width: row.querySelector<HTMLElement>(".admin-analytics-bar")!.getBoundingClientRect().width,
      track: row.querySelector<HTMLElement>(".admin-analytics-bar-track")!.getBoundingClientRect().width,
      color: getComputedStyle(row.querySelector(".admin-analytics-bar")!).backgroundColor,
    }))
    const thumbnail = root.querySelector(".admin-analytics-ranking-row:not(.admin-analytics-ranking-head) img")
    return { metrics, ranking, bars, thumbnailBackground: thumbnail ? getComputedStyle(thumbnail.parentElement!).backgroundColor : null }
  })
}

test("resumen, ranking, porcentajes, producto más visto y Top 10", async () => {
  const { page } = await openAnalytics(1440, "dark")
  try {
    const report = await readReport(page)
    assert.deepEqual(report.metrics, [
      "VISTAS TOTALES 710",
      "PRODUCTOS VISTOS 12",
      "PRODUCTO MÁS VISTO Auricular Malibu 245 vistas · 34,5% del total",
    ])
    assert.equal(report.ranking.length, 12, "el ranking lista todos los productos con vistas")
    assert.deepEqual(report.ranking.slice(0, 3), [
      ["1", "Auricular Malibu", "245", "34,5%"],
      ["2", "Soporte Notebook HUB", "180", "25,4%"],
      ["3", "Pava 12V", "95", "13,4%"],
    ])
    assert.deepEqual(report.ranking.at(-1), ["12", "Webcam", "2", "0,3%"])
    assert.equal(report.thumbnailBackground, "rgb(255, 255, 255)", "miniatura con fondo blanco de Productos")
    assert.equal(await page.getByRole("link", { name: "Auricular Malibu" }).getAttribute("href"), "/productos/producto-1")

    assert.equal(report.bars.length, 10, "el gráfico muestra el Top 10")
    assert.equal(report.bars[0].label, "Auricular Malibu: 245 vistas, 34,5% del total")
    assert.ok(Math.abs(report.bars[0].width - report.bars[0].track) < 1, "la barra mayor ocupa el ancho")
    assert.ok(Math.abs(report.bars[1].width / report.bars[0].width - 180 / 245) < 0.01, "barras proporcionales")
    assert.equal(report.bars[0].color, "rgb(57, 135, 229)")
  } finally { await page.close() }
})

test("sin vistas en el período: empty state claro, sin métricas ni gráfico", async () => {
  const { page } = await openAnalytics(1440, "dark", () => [])
  try {
    await page.getByText("Sin datos de visualización para este período.").waitFor()
    assert.equal(await page.locator(".admin-dashboard-kpi").count(), 0)
    assert.equal(await page.locator(".admin-analytics-bar-row").count(), 0)
  } finally { await page.close() }
})

for (const theme of ["dark", "light"] as const) {
  for (const width of [1920, 1366, 1024, 768, 390]) {
    test(`responsive ${theme} ${width}px: sin overflow horizontal ni textos cortados de más`, async () => {
      const { page } = await openAnalytics(width, theme)
      try {
        await readReport(page)
        const layout = await page.evaluate(() => {
          const root = document.querySelector(".admin-analytics-page")!
          const rootRect = root.getBoundingClientRect()
          const outside = Array.from(root.querySelectorAll<HTMLElement>(".admin-dashboard-kpi, .admin-analytics-bar-row, .admin-analytics-ranking-row, .admin-dash-segmented"))
            .filter((element) => {
              const rect = element.getBoundingClientRect()
              return rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1
            }).map((element) => element.className)
          const ranking = Array.from(root.querySelectorAll(".admin-analytics-ranking-row:not(.admin-analytics-ranking-head)"))[0]
          const cells = Array.from(ranking.querySelectorAll<HTMLElement>("[role=cell]"))
          const metrics = Array.from(root.querySelectorAll(".admin-dashboard-kpi"), (card) => card.getBoundingClientRect())
          return {
            pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            outside,
            numbersFit: [cells[0], cells[2], cells[3]].every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
            metricsTops: metrics.map((rect) => Math.round(rect.top)),
            barColor: getComputedStyle(root.querySelector(".admin-analytics-bar")!).backgroundColor,
            periodButtons: Array.from(root.querySelectorAll(".admin-dash-segmented-option"), (button) => button.getBoundingClientRect().height),
          }
        })
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/analitica-${theme}-${width}.png`, fullPage: true })
        assert.equal(layout.pageOverflow, 0, "sin scroll horizontal")
        assert.deepEqual(layout.outside, [])
        assert.ok(layout.numbersFit, "posición, vistas y % entran completos")
        assert.equal(new Set(layout.metricsTops).size, width >= 640 ? 1 : 3, "métricas: una fila en desktop, apiladas en mobile")
        assert.equal(layout.barColor, theme === "dark" ? "rgb(57, 135, 229)" : "rgb(42, 120, 214)")
        assert.ok(layout.periodButtons.every((height) => height >= 28), "filtros con área táctil")
      } finally { await page.close() }
    })
  }
}
