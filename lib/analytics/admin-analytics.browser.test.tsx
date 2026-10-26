import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

import { addDays } from "../business/dashboard-sales-analytics.ts"
import { argentinaDateKey } from "../business/dashboard-timezone.ts"
import { buildPeakHourReport, buildPeakWeekdayReport } from "./peak-views-report.ts"
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
  productId: index + 1, name, slug: `producto-${index + 1}`, image: index === 0 ? "https://img.test/malibu.svg" : null,
  // Pava 12V está archivada: conserva su histórico, sin PDP pública.
  available: name !== "Pava 12V", views: VIEWS[index],
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

/** Control de la API simulada: status de la próxima respuesta y una barrera para demorarla. */
interface ApiControl {
  status: number
  hold: Promise<void> | null
  /** Hora pico que devuelve el endpoint simulado (cambia entre refresh para verificar la card). */
  peakHour?: number
  /** Día ISO que devuelve el endpoint simulado de "Día con más visualizaciones". */
  peakWeekday?: number
}

/** Mock del día con más visualizaciones: con "Hoy" sólo existe un día, así que concentra el total. */
function weekdayReport(range: AnalyticsDateRange, total: number, weekday = 3) {
  return buildPeakWeekdayReport(range, total > 0 ? { bucket: weekday, views: range.from === range.to ? total : 255, totalViews: total } : null)
}

async function openAnalytics(
  width: number,
  theme: "dark" | "light",
  responder: Responder = () => ROWS,
  options: { clockAt?: number; api?: ApiControl } = {},
) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const api = options.api ?? { status: 200, hold: null }
  const requests: { range: AnalyticsDateRange; authorization: string | null }[] = []
  const peakRequests: AnalyticsDateRange[] = []
  const weekdayRequests: AnalyticsDateRange[] = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  // Playwright evalúa las rutas en orden inverso: la del HTML va primero para que la API la pise.
  await page.route("http://admin.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html data-admin-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>*,*::before,*::after{transition:none!important}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white lg:flex"><div class="hidden lg:block"><aside class="beyonix-admin-sidebar"></aside></div><main class="beyonix-admin-main min-w-0 flex-1"><div id="root"></div></main></div><script>window.process={env:{NODE_ENV:"production"}}</script><script>${bundle}</script></body></html>`,
  }))
  await page.route("**/api/admin/analytics/product-views**", async (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    requests.push({ range, authorization: route.request().headers().authorization ?? null })
    const status = api.status
    if (api.hold) await api.hold
    if (status !== 200) return route.fulfill({ status, json: { error: "No se pudieron cargar las vistas de productos." } })
    return route.fulfill({ json: buildProductViewReport(range, responder(range)) })
  })
  await page.route("**/api/admin/analytics/peak-hour**", async (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    peakRequests.push(range)
    const status = api.status
    if (api.hold) await api.hold
    if (status !== 200) return route.fulfill({ status, json: { error: "No se pudo cargar el horario pico de visualizaciones." } })
    const rows = responder(range)
    const total = rows.reduce((sum, row) => sum + row.views, 0)
    return route.fulfill({ json: buildPeakHourReport(range, total > 0 ? { bucket: api.peakHour ?? 14, views: 28, totalViews: total } : null) })
  })
  await page.route("**/api/admin/analytics/peak-weekday**", async (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    weekdayRequests.push(range)
    const status = api.status
    if (api.hold) await api.hold
    if (status !== 200) return route.fulfill({ status, json: { error: "No se pudo cargar el día con más visualizaciones." } })
    const total = responder(range).reduce((sum, row) => sum + row.views, 0)
    return route.fulfill({ json: weekdayReport(range, total, api.peakWeekday) })
  })
  await page.route("https://img.test/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ccc"/></svg>` }))
  if (options.clockAt !== undefined) {
    // Reloj simulado y detenido: el contador sólo avanza con runFor/fastForward.
    await page.clock.install({ time: options.clockAt })
    await page.clock.pauseAt(options.clockAt + 1_000)
  }
  await page.goto("http://admin.test/admin/analitica")
  return { page, requests, peakRequests, weekdayRequests, errors }
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
      "HORARIO PICO DE VISUALIZACIONES 14:00 – 15:00 28 visualizaciones 3,9% de las visualizaciones del período",
      "DÍA CON MÁS VISUALIZACIONES Miércoles 255 visualizaciones 35,9% de las visualizaciones del período",
    ])
    assert.equal(report.ranking.length, 12, "el ranking lista todos los productos con vistas")
    assert.deepEqual(report.ranking.slice(0, 3), [
      ["1", "Auricular Malibu", "245", "34,5%"],
      ["2", "Soporte Notebook HUB", "180", "25,4%"],
      ["3", "Pava 12VNo publicado", "95", "13,4%"],
    ])
    assert.deepEqual(report.ranking.at(-1), ["12", "Webcam", "2", "0,3%"])
    assert.equal(report.thumbnailBackground, "rgb(255, 255, 255)", "miniatura con fondo blanco de Productos")
    assert.equal(await page.getByRole("link", { name: "Auricular Malibu" }).getAttribute("href"), "/productos/producto-1")
    assert.equal(await page.getByRole("link", { name: "Pava 12V" }).count(), 0, "archivado: sin enlace a una PDP que ya no existe")
    assert.equal(await page.locator(".admin-analytics-ranking a").count(), 11)

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
    await page.locator(".admin-analytics-peak-hour").getByText("Sin datos", { exact: true }).waitFor()
    await page.locator(".admin-analytics-peak-weekday").getByText("Sin datos", { exact: true }).waitFor()
    assert.equal(await page.locator(".admin-dashboard-kpi").count(), 2, "sólo las cards de pico, en \"Sin datos\"")
    assert.equal(await page.locator(".admin-analytics-peak-weekday").getByText(/Lunes|^[\d.]+ visualizaci/).count(), 0, "nunca \"Lunes, 0 visualizaciones\"")
    assert.equal(await page.locator(".admin-analytics-peak-hour").getByText("00:00").count(), 0, "nunca 00:00 con 0")
    assert.equal(await page.locator(".admin-analytics-peak-hour").getByText(/^[\d.]+ visualizaci/).count(), 0, "sin \"0 visualizaciones\"")
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
          const peakValues = Array.from(root.querySelectorAll<HTMLElement>(".admin-analytics-peak-hour .text-2xl, .admin-analytics-peak-weekday .text-2xl"))
          return {
            peakValuesFit: peakValues.length === 2 && peakValues.every((value) => value.scrollWidth <= value.clientWidth + 1),
            metricsHeights: metrics.map((rect) => Math.round(rect.height)),
            metricsRects: metrics.map((rect) => ({ left: rect.left, right: rect.right, width: rect.width })),
            pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            outside,
            numbersFit: [cells[0], cells[2], cells[3]].every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
            metricsTops: metrics.map((rect) => Math.round(rect.top)),
            barColor: getComputedStyle(root.querySelector(".admin-analytics-bar")!).backgroundColor,
            periodButtons: Array.from(root.querySelectorAll(".admin-dash-segmented-option"), (button) => button.getBoundingClientRect().height),
            refresh: (() => {
              const control = root.querySelector(".admin-analytics-refresh")!.getBoundingClientRect()
              const title = root.querySelector("h1")!.getBoundingClientRect()
              const status = root.querySelector<HTMLElement>(".admin-analytics-refresh-status")!
              return {
                left: control.left, right: control.right, top: control.top, height: control.height,
                rootLeft: rootRect.left, rootRight: rootRect.right,
                titleTop: title.top, titleBottom: title.bottom, titleRight: title.right,
                statusFits: status.scrollWidth <= status.clientWidth + 1,
                statusColor: getComputedStyle(status).color,
              }
            })(),
          }
        })
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/analitica-${theme}-${width}.png`, fullPage: true })
        assert.equal(layout.pageOverflow, 0, "sin scroll horizontal")
        assert.deepEqual(layout.outside, [])
        assert.ok(layout.numbersFit, "posición, vistas y % entran completos")
        assert.equal(layout.metricsTops.length, 5, "3 métricas + horario pico + día con más visualizaciones")
        assert.equal(new Set(layout.metricsTops).size, width >= 1280 ? 2 : width >= 640 ? 3 : 5, "métricas: 3 + 2 en desktop, 2 columnas en tablet, apiladas en mobile")
        assert.ok(layout.peakValuesFit, "\"14:00 – 15:00\" y \"Miércoles\" entran completos")
        assert.ok(layout.metricsHeights.every((height) => height <= 140), `cards sin agrandarse: ${layout.metricsHeights}`)
        if (width >= 640 && width < 1280) {
          const [first, , , , last] = layout.metricsRects
          assert.ok(Math.abs(last.width - (layout.metricsRects[1].right - first.left)) < 1, "tablet: la quinta card ocupa la fila completa, sin hueco")
        }
        assert.equal(layout.barColor, theme === "dark" ? "rgb(57, 135, 229)" : "rgb(42, 120, 214)")
        assert.ok(layout.periodButtons.every((height) => height >= 28), "filtros con área táctil")
        const refresh = layout.refresh
        assert.ok(refresh.left >= refresh.rootLeft - 1 && refresh.right <= refresh.rootRight + 1, `cronómetro fuera de la página a ${width}px`)
        assert.ok(refresh.statusFits, "el texto del cronómetro entra completo")
        assert.ok(refresh.height <= 80, `cronómetro demasiado grande: ${refresh.height}px`)
        if (width >= 768) {
          assert.ok(refresh.left > refresh.titleRight, `a ${width}px el cronómetro va a la derecha del título`)
          assert.ok(Math.abs(refresh.top - refresh.titleTop) < 40, "arriba, alineado con el encabezado")
        } else {
          assert.ok(refresh.top >= refresh.titleBottom, "en mobile baja debajo del título")
        }
        assert.notEqual(refresh.statusColor, theme === "dark" ? "rgb(15, 23, 42)" : "rgb(248, 250, 252)", "texto legible en el tema")
      } finally { await page.close() }
    })
  }
}

// --- Auto-actualización global -------------------------------------------------

const CLOCK_START = Date.parse("2026-10-26T15:00:00-03:00")
const countdownText = (page: Page) => page.locator(".admin-analytics-refresh-status").innerText()
const refreshButton = (page: Page) => page.getByRole("button", { name: "Actualizar ahora" })
const rankingRows = (page: Page) => page.locator(".admin-analytics-ranking-row:not(.admin-analytics-ranking-head)")

async function waitForText(page: Page, expected: string) {
  await page.waitForFunction(
    (text) => document.querySelector(".admin-analytics-refresh-status")?.textContent?.replace(/\s+/g, " ").includes(text),
    expected,
    { timeout: 5_000 },
  )
}

test("cronómetro: arranca en 01:00, baja segundo a segundo y en 00:00 refresca el mismo período sin recargar la página", async () => {
  const { page, requests, errors } = await openAnalytics(1440, "dark", () => ROWS, { clockAt: CLOCK_START })
  try {
    await waitForRequests(requests, 1)
    await rankingRows(page).first().waitFor()
    await page.evaluate(() => { (window as Window & { __sinRecarga?: boolean }).__sinRecarga = true })
    assert.equal(await countdownText(page), "Próxima actualización en: 01:00")

    await page.clock.runFor(1_000)
    await waitForText(page, "00:59")
    await page.clock.runFor(14_000)
    await waitForText(page, "00:45")
    assert.equal(requests.length, 1, "no refresca antes de tiempo")

    await page.clock.runFor(45_000)
    await waitForRequests(requests, 2)
    assert.deepEqual(requests[1].range, requests[0].range, "consulta exactamente el mismo período")
    await waitForText(page, "01:00")
    assert.equal(requests.length, 2, "un solo refresh por vencimiento")
    assert.equal(await page.evaluate(() => (window as Window & { __sinRecarga?: boolean }).__sinRecarga), true, "no se recargó la página")
    assert.equal(await rankingRows(page).count(), 12, "Productos más vistos sigue mostrando el ranking")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Actualizar ahora: refresca ya, se deshabilita mientras tanto, no duplica requests (ni con el automático) y reinicia a 01:00", async () => {
  const api: ApiControl = { status: 200, hold: null }
  const { page, requests } = await openAnalytics(1440, "dark", () => ROWS, { clockAt: CLOCK_START, api })
  try {
    await waitForRequests(requests, 1)
    await rankingRows(page).first().waitFor()
    await page.clock.runFor(20_000)
    await waitForText(page, "00:40")

    let release!: () => void
    api.hold = new Promise((resolve) => { release = resolve })
    await refreshButton(page).click()
    await waitForRequests(requests, 2)
    await waitForText(page, "Actualizando...")
    assert.equal(await refreshButton(page).isDisabled(), true)
    await refreshButton(page).click({ force: true })
    await page.clock.runFor(60_000)
    await page.waitForTimeout(150)
    assert.equal(requests.length, 2, "botón + vencimiento durante el refresh: una sola consulta")
    assert.equal(await rankingRows(page).count(), 12, "mientras actualiza se siguen viendo los datos")

    api.hold = null
    release()
    await waitForText(page, "01:00")
    assert.equal(await refreshButton(page).isDisabled(), false)
    assert.equal(requests.length, 2)
  } finally { await page.close() }
})

test("error al refrescar: conserva los últimos datos, avisa discretamente y el siguiente refresh funciona", async () => {
  const api: ApiControl = { status: 200, hold: null }
  const { page, requests } = await openAnalytics(1440, "light", () => ROWS, { clockAt: CLOCK_START, api })
  try {
    await waitForRequests(requests, 1)
    await rankingRows(page).first().waitFor()
    api.status = 500
    await refreshButton(page).click()
    await waitForRequests(requests, 2)
    await page.getByText("No se pudo actualizar. Se muestran los últimos datos.").waitFor()
    assert.equal(await rankingRows(page).count(), 12, "el panel no se vacía")
    assert.equal(await page.locator(".admin-dashboard-kpi").count(), 5)
    assert.equal(await page.locator(".admin-analytics-peak-hour").getByText("14:00 – 15:00").count(), 1, "horario pico: conserva el último dato válido")
    assert.equal(await page.locator(".admin-analytics-peak-weekday").getByText("Miércoles", { exact: true }).count(), 1, "día con más visualizaciones: conserva el último dato válido")
    assert.equal(await page.locator(".admin-analytics-peak-weekday").getByText("255 visualizaciones").count(), 1)
    await waitForText(page, "01:00")

    api.status = 200
    await page.clock.runFor(60_000)
    await waitForRequests(requests, 3)
    await page.getByText("No se pudo actualizar. Se muestran los últimos datos.").waitFor({ state: "detached" })
    assert.equal(await rankingRows(page).count(), 12)
  } finally { await page.close() }
})

test("filtros: cambiar el período carga el nuevo y reinicia el contador; el refresh siguiente conserva ese período", async () => {
  const { page, requests } = await openAnalytics(1440, "dark", () => ROWS, { clockAt: CLOCK_START })
  try {
    await waitForRequests(requests, 1)
    await rankingRows(page).first().waitFor()
    await page.clock.runFor(25_000)
    await waitForText(page, "00:35")

    await page.getByRole("button", { name: "Últimos 30 días" }).click()
    await waitForRequests(requests, 2)
    await waitForText(page, "01:00")
    const thirtyDays = requests[1].range
    assert.notDeepEqual(thirtyDays, requests[0].range)

    await page.clock.runFor(60_000)
    await waitForRequests(requests, 3)
    assert.deepEqual(requests[2].range, thirtyDays, "el auto-refresh no resetea las fechas")
    assert.equal(await page.getByRole("button", { name: "Últimos 30 días" }).getAttribute("aria-pressed"), "true")
  } finally { await page.close() }
})

test("pestaña dormida varios minutos: al volver hace UNA sola actualización", async () => {
  const { page, requests } = await openAnalytics(1440, "dark", () => ROWS, { clockAt: CLOCK_START })
  try {
    await waitForRequests(requests, 1)
    await rankingRows(page).first().waitFor()
    await page.clock.fastForward("05:00")
    await waitForRequests(requests, 2)
    await waitForText(page, "01:00")
    await page.waitForTimeout(200)
    assert.equal(requests.length, 2, "no se acumulan refresh atrasados")
  } finally { await page.close() }
})

// --- Horario pico de visualizaciones ---------------------------------------------

const peakCard = (page: Page) => page.locator(".admin-analytics-peak-hour")
const weekdayCard = (page: Page) => page.locator(".admin-analytics-peak-weekday")

test("horario pico: usa exactamente el período global (Hoy, 7 días, 30 días y personalizado)", async () => {
  const { page, requests, peakRequests } = await openAnalytics(1440, "dark")
  try {
    await waitForRequests(peakRequests, 1)
    await peakCard(page).getByText("14:00 – 15:00").waitFor()
    for (const [button, count] of [["Hoy", 2], ["Últimos 30 días", 3], ["Últimos 7 días", 4]] as const) {
      await page.getByRole("button", { name: button }).click()
      await waitForRequests(peakRequests, count)
      await waitForRequests(requests, count)
      assert.deepEqual(peakRequests[count - 1], requests[count - 1].range, `${button}: mismo período que Productos más vistos`)
    }
    assert.deepEqual(peakRequests[1], { from: TODAY, to: TODAY })
    assert.deepEqual(peakRequests[2], { from: addDays(TODAY, -29), to: TODAY })

    await page.getByRole("button", { name: "Personalizado" }).click()
    const from = page.getByRole("textbox", { name: "Fecha inicial" })
    await from.fill("01/10/2026")
    await from.press("Tab")
    await page.keyboard.press("Escape")
    const to = page.getByRole("textbox", { name: "Fecha final" })
    await to.fill("15/10/2026")
    await to.press("Tab")
    const deadline = Date.now() + 5_000
    while (JSON.stringify(peakRequests.at(-1)) !== JSON.stringify({ from: "2026-10-01", to: "2026-10-15" }) && Date.now() < deadline) {
      await page.waitForTimeout(50)
    }
    assert.deepEqual(peakRequests.at(-1), { from: "2026-10-01", to: "2026-10-15" })
    assert.deepEqual(peakRequests.at(-1), requests.at(-1)?.range)
  } finally { await page.close() }
})

test("horario pico: el ciclo global (00:00) y Actualizar ahora lo refrescan junto con Productos más vistos", async () => {
  const api: ApiControl = { status: 200, hold: null, peakHour: 14 }
  const { page, requests, peakRequests } = await openAnalytics(1440, "dark", () => ROWS, { clockAt: CLOCK_START, api })
  try {
    await waitForRequests(peakRequests, 1)
    await peakCard(page).getByText("14:00 – 15:00").waitFor()

    api.peakHour = 18
    await page.clock.runFor(60_000)
    await waitForRequests(peakRequests, 2)
    await waitForRequests(requests, 2)
    await peakCard(page).getByText("18:00 – 19:00").waitFor()
    await waitForText(page, "01:00")
    assert.equal(peakRequests.length, 2, "una consulta por ciclo")
    assert.equal(requests.length, 2, "Productos más vistos en el mismo ciclo")

    api.peakHour = 9
    await refreshButton(page).click()
    await waitForRequests(peakRequests, 3)
    await peakCard(page).getByText("09:00 – 10:00").waitFor()
    await waitForText(page, "01:00")
    assert.deepEqual([requests.length, peakRequests.length], [3, 3])
  } finally { await page.close() }
})

test("un solo timer para toda Analítica: el horario pico no agrega intervalos", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const intervals: number[] = []
  await page.exposeFunction("__registrarIntervalo", (ms: number) => { intervals.push(ms) })
  await page.addInitScript(() => {
    const original = window.setInterval.bind(window)
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      void (window as Window & { __registrarIntervalo?: (ms: number) => void }).__registrarIntervalo?.(Number(timeout ?? 0))
      return original(handler, timeout, ...args)
    }) as typeof window.setInterval
  })
  await page.route("http://admin.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html data-admin-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body><main class="beyonix-admin-main"><div id="root"></div></main><script>window.process={env:{NODE_ENV:"production"}}</script><script>${bundle}</script></body></html>`,
  }))
  await page.route("**/api/admin/analytics/product-views**", (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    return route.fulfill({ json: buildProductViewReport(range, ROWS) })
  })
  await page.route("**/api/admin/analytics/peak-hour**", (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    return route.fulfill({ json: buildPeakHourReport(range, { bucket: 14, views: 28, totalViews: 710 }) })
  })
  await page.route("**/api/admin/analytics/peak-weekday**", (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    return route.fulfill({ json: weekdayReport(range, 710) })
  })
  try {
    await page.goto("http://admin.test/admin/analitica")
    await peakCard(page).getByText("14:00 – 15:00").waitFor()
    await weekdayCard(page).getByText("Miércoles", { exact: true }).waitFor()
    await page.waitForTimeout(300)
    assert.deepEqual(intervals, [250], "exactamente un setInterval: el del ciclo global (ni horario pico ni día con más visualizaciones agregan otro)")
  } finally { await page.close() }
})

// --- Día con más visualizaciones ---------------------------------------------------

test("día con más visualizaciones: usa exactamente el período global (Hoy, 7 días, 30 días y personalizado)", async () => {
  const { page, requests, weekdayRequests } = await openAnalytics(1440, "dark")
  try {
    await waitForRequests(weekdayRequests, 1)
    await weekdayCard(page).getByText("Miércoles", { exact: true }).waitFor()
    for (const [button, count] of [["Hoy", 2], ["Últimos 30 días", 3], ["Últimos 7 días", 4]] as const) {
      await page.getByRole("button", { name: button }).click()
      await waitForRequests(weekdayRequests, count)
      await waitForRequests(requests, count)
      assert.deepEqual(weekdayRequests[count - 1], requests[count - 1].range, `${button}: mismo período que Productos más vistos`)
    }
    assert.deepEqual(weekdayRequests[0], { from: addDays(TODAY, -6), to: TODAY })
    assert.deepEqual(weekdayRequests[1], { from: TODAY, to: TODAY })
    assert.deepEqual(weekdayRequests[2], { from: addDays(TODAY, -29), to: TODAY })

    await page.getByRole("button", { name: "Personalizado" }).click()
    const from = page.getByRole("textbox", { name: "Fecha inicial" })
    await from.fill("01/10/2026")
    await from.press("Tab")
    await page.keyboard.press("Escape")
    const to = page.getByRole("textbox", { name: "Fecha final" })
    await to.fill("15/10/2026")
    await to.press("Tab")
    const deadline = Date.now() + 5_000
    while (JSON.stringify(weekdayRequests.at(-1)) !== JSON.stringify({ from: "2026-10-01", to: "2026-10-15" }) && Date.now() < deadline) {
      await page.waitForTimeout(50)
    }
    assert.deepEqual(weekdayRequests.at(-1), { from: "2026-10-01", to: "2026-10-15" })
    assert.deepEqual(weekdayRequests.at(-1), requests.at(-1)?.range)
  } finally { await page.close() }
})

test("día con más visualizaciones: con Hoy muestra el 100% de las visualizaciones del período", async () => {
  const { page, weekdayRequests } = await openAnalytics(390, "light")
  try {
    await weekdayCard(page).getByText("255 visualizaciones").waitFor()
    await page.getByRole("button", { name: "Hoy" }).click()
    await waitForRequests(weekdayRequests, 2)
    await weekdayCard(page).getByText("710 visualizaciones").waitFor()
    assert.equal(await weekdayCard(page).getByText("100% de las visualizaciones del período").count(), 1)
  } finally { await page.close() }
})

test("día con más visualizaciones: el ciclo global (00:00) y Actualizar ahora lo refrescan junto con las demás métricas", async () => {
  const api: ApiControl = { status: 200, hold: null, peakWeekday: 3 }
  const { page, requests, peakRequests, weekdayRequests } = await openAnalytics(1440, "dark", () => ROWS, { clockAt: CLOCK_START, api })
  try {
    await waitForRequests(weekdayRequests, 1)
    await weekdayCard(page).getByText("Miércoles", { exact: true }).waitFor()

    api.peakWeekday = 6
    await page.clock.runFor(60_000)
    await waitForRequests(weekdayRequests, 2)
    await weekdayCard(page).getByText("Sábado", { exact: true }).waitFor()
    await waitForText(page, "01:00")
    assert.deepEqual([requests.length, peakRequests.length, weekdayRequests.length], [2, 2, 2], "las tres métricas en el mismo ciclo, una consulta cada una")

    api.peakWeekday = 7
    await refreshButton(page).click()
    await waitForRequests(weekdayRequests, 3)
    await weekdayCard(page).getByText("Domingo", { exact: true }).waitFor()
    await waitForText(page, "01:00")
    assert.deepEqual([requests.length, peakRequests.length, weekdayRequests.length], [3, 3, 3])
  } finally { await page.close() }
})
