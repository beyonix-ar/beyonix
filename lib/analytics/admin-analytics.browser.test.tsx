import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

import { addDays } from "../business/dashboard-sales-analytics.ts"
import { argentinaDateKey } from "../business/dashboard-timezone.ts"
import { buildHourlyViewsReport, buildPeakHourReport, buildPeakWeekdayReport, buildWeekdayViewsReport } from "./peak-views-report.ts"
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
  /** Visualizaciones de 00 a 23 que devuelven el gráfico por hora y, derivado de ellas, el horario pico. */
  hourlyViews?: number[]
  /** Día ISO que devuelve el endpoint simulado de "Día con más visualizaciones". */
  peakWeekday?: number
  /** Visualizaciones de lunes a domingo que devuelve el endpoint simulado del gráfico por día. */
  weekdayViews?: number[]
}

/** Mock del día con más visualizaciones: con "Hoy" sólo existe un día, así que concentra el total. */
function weekdayReport(range: AnalyticsDateRange, total: number, weekday = 3) {
  return buildPeakWeekdayReport(range, total > 0 ? { bucket: weekday, views: range.from === range.to ? total : 255, totalViews: total } : null)
}

/** Distribución de lunes a domingo coherente con `weekdayReport`: miércoles 255 de 710. */
const WEEKDAY_VIEWS = [80, 95, 255, 120, 60, 70, 30]

function weekdayViewsReport(range: AnalyticsDateRange, total: number, views?: number[]) {
  const counts = views ?? (total === 0 ? [] : range.from === range.to ? [0, 0, total, 0, 0, 0, 0] : WEEKDAY_VIEWS)
  return buildWeekdayViewsReport(range, counts.map((count, index) => ({ weekday: index + 1, views: count })))
}

/** Distribución de 00 a 23 que suma 710 (el total del ranking): pico a las 14 h con 62. */
const HOURLY_VIEWS = [2, 1, 0, 0, 0, 1, 4, 10, 18, 27, 35, 40, 44, 38, 62, 50, 45, 48, 55, 60, 58, 48, 40, 24]

/** `HOURLY_VIEWS` con la hora `hour` como pico (100 visualizaciones). */
const hourlyWithPeak = (hour: number) => HOURLY_VIEWS.map((count, index) => (index === hour ? 100 : count))

const hourlyCounts = (total: number, views?: number[]) => views ?? (total === 0 ? [] : HOURLY_VIEWS)

function hourlyViewsReport(range: AnalyticsDateRange, total: number, views?: number[]) {
  return buildHourlyViewsReport(range, hourlyCounts(total, views).map((count, hour) => ({ hour, views: count })))
}

/** Como `admin_product_view_peak_hour`: el máximo de la MISMA distribución, empate a la hora más temprana. */
function peakHourReport(range: AnalyticsDateRange, total: number, views?: number[]) {
  const counts = hourlyCounts(total, views)
  const max = Math.max(0, ...counts)
  return buildPeakHourReport(range, max > 0 ? { bucket: counts.indexOf(max), views: max, totalViews: counts.reduce((sum, count) => sum + count, 0) } : null)
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
  const weekdayViewsRequests: AnalyticsDateRange[] = []
  const hourlyRequests: AnalyticsDateRange[] = []
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
    const total = responder(range).reduce((sum, row) => sum + row.views, 0)
    return route.fulfill({ json: peakHourReport(range, total, api.hourlyViews) })
  })
  await page.route("**/api/admin/analytics/views-by-hour**", async (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    hourlyRequests.push(range)
    const status = api.status
    if (api.hold) await api.hold
    if (status !== 200) return route.fulfill({ status, json: { error: "No se pudieron cargar las visualizaciones por hora del día." } })
    const total = responder(range).reduce((sum, row) => sum + row.views, 0)
    return route.fulfill({ json: hourlyViewsReport(range, total, api.hourlyViews) })
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
  await page.route("**/api/admin/analytics/views-by-weekday**", async (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    weekdayViewsRequests.push(range)
    const status = api.status
    if (api.hold) await api.hold
    if (status !== 200) return route.fulfill({ status, json: { error: "No se pudieron cargar las visualizaciones por día de la semana." } })
    const total = responder(range).reduce((sum, row) => sum + row.views, 0)
    return route.fulfill({ json: weekdayViewsReport(range, total, api.weekdayViews) })
  })
  await page.route("https://img.test/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ccc"/></svg>` }))
  if (options.clockAt !== undefined) {
    // Reloj simulado y detenido: el contador sólo avanza con runFor/fastForward.
    await page.clock.install({ time: options.clockAt })
    await page.clock.pauseAt(options.clockAt + 1_000)
  }
  await page.goto("http://admin.test/admin/analitica")
  return { page, requests, peakRequests, weekdayRequests, weekdayViewsRequests, hourlyRequests, errors }
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

/** Columnas del gráfico por día: etiqueta accesible, valor, abreviatura y alto de la barra. */
async function readWeekdayChart(page: Page) {
  await page.locator(".admin-analytics-weekday").first().waitFor()
  return page.locator(".admin-analytics-weekdays").evaluate((chart) =>
    Array.from(chart.querySelectorAll<HTMLElement>(".admin-analytics-weekday"), (column) => {
      const track = column.querySelector<HTMLElement>(".admin-analytics-weekday-track")!
      const bar = column.querySelector<HTMLElement>(".admin-analytics-weekday-bar")!
      const value = column.querySelector<HTMLElement>(".admin-analytics-weekday-value")!
      return {
        label: column.getAttribute("aria-label") ?? "",
        value: value.textContent ?? "",
        short: track.nextElementSibling?.textContent ?? "",
        height: bar.getBoundingClientRect().height,
        track: track.clientHeight - parseFloat(getComputedStyle(track).paddingTop),
        valueOnBar: Math.abs(value.getBoundingClientRect().bottom + 4 - bar.getBoundingClientRect().top) < 1.5,
      }
    }))
}

/** Columnas del gráfico por hora: etiqueta accesible, eje, alto de la barra y alto útil del track. */
async function readHourlyChart(page: Page) {
  await page.locator(".admin-analytics-hour").first().waitFor()
  return page.locator(".admin-analytics-hours").evaluate((chart) =>
    Array.from(chart.querySelectorAll<HTMLElement>(".admin-analytics-hour"), (column) => ({
      label: column.getAttribute("aria-label") ?? "",
      axis: column.querySelector(".admin-analytics-hour-label")?.textContent ?? "",
      height: column.querySelector<HTMLElement>(".admin-analytics-hour-bar")!.getBoundingClientRect().height,
      track: column.querySelector<HTMLElement>(".admin-analytics-hour-track")!.clientHeight,
    })))
}

/** Visualizaciones de cada hora, leídas de la etiqueta accesible de su columna. */
const hourlyValues = async (page: Page) =>
  (await readHourlyChart(page)).map((column) => Number(/: ([\d.]+) visualizaci/.exec(column.label)?.[1].replace(/\./g, "")))

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
      "HORARIO PICO DE VISUALIZACIONES 14:00 – 15:00 62 visualizaciones 8,7% de las visualizaciones del período",
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

    const chart = await readWeekdayChart(page)
    assert.deepEqual(chart.map((column) => column.short), ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"])
    assert.deepEqual(chart.map((column) => column.value), ["80", "95", "255", "120", "60", "70", "30"])
    assert.equal(chart[2].label, "Miércoles: 255 visualizaciones, 35,9% del total")
    assert.equal(chart[6].label, "Domingo: 30 visualizaciones, 4,2% del total")
    assert.ok(Math.abs(chart[2].height - chart[2].track) < 1, "la columna mayor ocupa el alto")
    assert.ok(Math.abs(chart[3].height / chart[2].height - 120 / 255) < 0.02, "columnas proporcionales")
    assert.ok(chart.every((column) => column.valueOnBar), "cada valor va pegado sobre su barra")
    const tallest = chart.reduce((best, column) => (column.height > best.height ? column : best))
    assert.ok(tallest.label.startsWith(`${await weekdayCard(page).locator(".text-2xl").innerText()}:`), "la card y el gráfico coinciden en el día con más visualizaciones")
    const hours = await readHourlyChart(page)
    assert.equal(hours.length, 24, "las 24 horas")
    assert.deepEqual(hours.map((column) => column.axis).filter(Boolean), ["00", "03", "06", "09", "12", "15", "18", "21"], "eje cada 3 horas")
    assert.deepEqual(await hourlyValues(page), HOURLY_VIEWS)
    assert.equal(hours[14].label, "14:00 – 15:00: 62 visualizaciones, 8,7% del total")
    assert.equal(hours[2].label, "02:00 – 03:00: 0 visualizaciones, 0% del total")
    assert.equal(hours[23].label, "23:00 – 00:00: 24 visualizaciones, 3,4% del total")
    assert.ok(Math.abs(hours[14].height - hours[14].track) < 1, "la hora pico ocupa el alto")
    assert.ok(Math.abs(hours[20].height / hours[14].height - 58 / 62) < 0.02, "barras proporcionales")
    assert.equal(hours[2].height, 0)
    const tallestHour = hours.reduce((best, column) => (column.height > best.height ? column : best))
    assert.ok(tallestHour.label.startsWith(`${await peakCard(page).locator(".text-2xl").innerText()}:`), "la card y el gráfico coinciden en el horario pico")

    const order = await page.locator(".admin-analytics-page").evaluate((root) =>
      [".admin-analytics-metrics", ".admin-analytics-weekday-section", ".admin-analytics-hour-section", "#analytics-top-title"].map((selector) => root.querySelector(selector)!.getBoundingClientRect().top))
    assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3], "cards → por día de la semana → por hora → productos más vistos")
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

    await page.locator(".admin-analytics-weekday-section").getByText("Sin visualizaciones en este período").waitFor()
    const chart = await readWeekdayChart(page)
    assert.deepEqual(chart.map((column) => [column.short, column.value, column.height]), ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((day) => [day, "0", 0]), "los 7 días visibles, en 0")
    assert.equal(chart[0].label, "Lunes: 0 visualizaciones, 0% del total")

    const hours = await readHourlyChart(page)
    assert.deepEqual(hours.map((column) => column.height), Array(24).fill(0), "las 24 horas visibles, en 0")
    assert.equal(hours[20].label, "20:00 – 21:00: 0 visualizaciones, 0% del total")
    assert.equal(await page.locator(".admin-analytics-hour-section").getByText("Sin visualizaciones en este período").count(), 1)
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
          const outside = Array.from(root.querySelectorAll<HTMLElement>(".admin-dashboard-kpi, .admin-analytics-bar-row, .admin-analytics-ranking-row, .admin-dash-segmented, .admin-analytics-weekday, .admin-analytics-weekday-tooltip, .admin-analytics-hour, .admin-analytics-hour-tooltip"))
            .filter((element) => {
              const rect = element.getBoundingClientRect()
              return rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1
            }).map((element) => element.className)
          const ranking = Array.from(root.querySelectorAll(".admin-analytics-ranking-row:not(.admin-analytics-ranking-head)"))[0]
          const cells = Array.from(ranking.querySelectorAll<HTMLElement>("[role=cell]"))
          const metrics = Array.from(root.querySelectorAll(".admin-dashboard-kpi"), (card) => card.getBoundingClientRect())
          const peakValues = Array.from(root.querySelectorAll<HTMLElement>(".admin-analytics-peak-hour .text-2xl, .admin-analytics-peak-weekday .text-2xl"))
          return {
            weekdays: (() => {
              const columns = Array.from(root.querySelectorAll<HTMLElement>(".admin-analytics-weekday"))
              return {
                count: columns.length,
                rows: new Set(columns.map((column) => Math.round(column.getBoundingClientRect().top))).size,
                textFits: columns.every((column) => {
                  const box = column.getBoundingClientRect()
                  return Array.from(column.querySelectorAll(".admin-analytics-weekday-value, .admin-analytics-weekday-track, .admin-analytics-weekday-track + span")).every((child) => {
                    const rect = child.getBoundingClientRect()
                    return rect.left >= box.left - 1 && rect.right <= box.right + 1
                  })
                }),
                barColor: getComputedStyle(root.querySelector(".admin-analytics-weekday-bar")!).backgroundColor,
                labelColor: getComputedStyle(columns[0].lastElementChild!.previousElementSibling!).color,
              }
            })(),
            hours: (() => {
              const columns = Array.from(root.querySelectorAll<HTMLElement>(".admin-analytics-hour"))
              const chart = root.querySelector(".admin-analytics-hours")!.getBoundingClientRect()
              const labels = columns.map((column) => column.querySelector<HTMLElement>(".admin-analytics-hour-label")!)
                .filter((label) => label.textContent).map((label) => label.getBoundingClientRect())
              return {
                count: columns.length,
                rows: new Set(columns.map((column) => Math.round(column.getBoundingClientRect().top))).size,
                minWidth: Math.min(...columns.map((column) => column.getBoundingClientRect().width)),
                labelsInside: labels.every((rect) => rect.left >= chart.left - 1 && rect.right <= chart.right + 1),
                labelsOverlap: labels.some((rect, index) => index > 0 && rect.left < labels[index - 1].right + 2),
                barColor: getComputedStyle(root.querySelector(".admin-analytics-hour-bar")!).backgroundColor,
                labelColor: getComputedStyle(columns[0].querySelector(".admin-analytics-hour-label")!).color,
              }
            })(),
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
        assert.deepEqual([layout.weekdays.count, layout.weekdays.rows], [7, 1], "los 7 días en una sola fila, también en mobile")
        assert.ok(layout.weekdays.textFits, "valores y días entran en su columna")
        assert.equal(layout.weekdays.barColor, layout.barColor, "mismo azul que el Top 10")
        assert.notEqual(layout.weekdays.labelColor, theme === "dark" ? "rgb(15, 23, 42)" : "rgb(248, 250, 252)", "días legibles en el tema")
        assert.deepEqual([layout.hours.count, layout.hours.rows], [24, 1], "las 24 horas en una sola fila, sin scroll, también en mobile")
        assert.ok(layout.hours.minWidth >= 10, `columnas por hora tocables: ${layout.hours.minWidth}px`)
        assert.ok(layout.hours.labelsInside && !layout.hours.labelsOverlap, "eje sin textos superpuestos ni cortados")
        assert.equal(layout.hours.barColor, layout.barColor, "mismo azul que el Top 10")
        assert.notEqual(layout.hours.labelColor, theme === "dark" ? "rgb(15, 23, 42)" : "rgb(248, 250, 252)", "horas legibles en el tema")
        assert.ok(layout.peakValuesFit,"\"14:00 – 15:00\" y \"Miércoles\" entran completos")
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
    assert.deepEqual((await readWeekdayChart(page)).map((column) => column.value), ["80", "95", "255", "120", "60", "70", "30"], "por día de la semana: conserva el último dato válido")
    assert.deepEqual(await hourlyValues(page), HOURLY_VIEWS, "por hora del día: conserva el último dato válido")
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
  const api: ApiControl = { status: 200, hold: null }
  const { page, requests, peakRequests } = await openAnalytics(1440, "dark", () => ROWS, { clockAt: CLOCK_START, api })
  try {
    await waitForRequests(peakRequests, 1)
    await peakCard(page).getByText("14:00 – 15:00").waitFor()

    api.hourlyViews = hourlyWithPeak(18)
    await page.clock.runFor(60_000)
    await waitForRequests(peakRequests, 2)
    await waitForRequests(requests, 2)
    await peakCard(page).getByText("18:00 – 19:00").waitFor()
    await waitForText(page, "01:00")
    assert.equal(peakRequests.length, 2, "una consulta por ciclo")
    assert.equal(requests.length, 2, "Productos más vistos en el mismo ciclo")

    api.hourlyViews = hourlyWithPeak(9)
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
  await page.route("**/api/admin/analytics/views-by-weekday**", (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    return route.fulfill({ json: weekdayViewsReport(range, 710) })
  })
  await page.route("**/api/admin/analytics/views-by-hour**", (route) => {
    const url = new URL(route.request().url())
    const range = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }
    return route.fulfill({ json: hourlyViewsReport(range, 710) })
  })
  try {
    await page.goto("http://admin.test/admin/analitica")
    await peakCard(page).getByText("14:00 – 15:00").waitFor()
    await weekdayCard(page).getByText("Miércoles", { exact: true }).waitFor()
    await page.locator(".admin-analytics-weekday").first().waitFor()
    await page.locator(".admin-analytics-hour").first().waitFor()
    await page.waitForTimeout(300)
    assert.deepEqual(intervals, [250], "exactamente un setInterval: el del ciclo global (ninguna métrica agrega otro)")
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

// --- Visualizaciones por día de la semana --------------------------------------------

const weekdayValues = async (page: Page) => (await readWeekdayChart(page)).map((column) => column.value)

test("por día de la semana: usa exactamente el período global (Hoy, 7 días, 30 días y personalizado)", async () => {
  const { page, requests, weekdayViewsRequests } = await openAnalytics(1440, "dark")
  try {
    await waitForRequests(weekdayViewsRequests, 1)
    for (const [button, count] of [["Hoy", 2], ["Últimos 30 días", 3], ["Últimos 7 días", 4]] as const) {
      await page.getByRole("button", { name: button }).click()
      await waitForRequests(weekdayViewsRequests, count)
      await waitForRequests(requests, count)
      assert.deepEqual(weekdayViewsRequests[count - 1], requests[count - 1].range, `${button}: mismo período que Productos más vistos`)
    }
    assert.deepEqual(weekdayViewsRequests[0], { from: addDays(TODAY, -6), to: TODAY })
    assert.deepEqual(weekdayViewsRequests[1], { from: TODAY, to: TODAY })
    assert.deepEqual(weekdayViewsRequests[2], { from: addDays(TODAY, -29), to: TODAY })

    await page.getByRole("button", { name: "Personalizado" }).click()
    const from = page.getByRole("textbox", { name: "Fecha inicial" })
    await from.fill("01/10/2026")
    await from.press("Tab")
    await page.keyboard.press("Escape")
    const to = page.getByRole("textbox", { name: "Fecha final" })
    await to.fill("15/10/2026")
    await to.press("Tab")
    const deadline = Date.now() + 5_000
    while (JSON.stringify(weekdayViewsRequests.at(-1)) !== JSON.stringify({ from: "2026-10-01", to: "2026-10-15" }) && Date.now() < deadline) {
      await page.waitForTimeout(50)
    }
    assert.deepEqual(weekdayViewsRequests.at(-1), { from: "2026-10-01", to: "2026-10-15" })
    assert.deepEqual(weekdayViewsRequests.at(-1), requests.at(-1)?.range)
  } finally { await page.close() }
})

test("por día de la semana: con Hoy los 7 días siguen visibles y sólo uno tiene vistas (100%)", async () => {
  const { page, weekdayViewsRequests } = await openAnalytics(390, "light")
  try {
    await waitForRequests(weekdayViewsRequests, 1)
    await page.getByRole("button", { name: "Hoy" }).click()
    await waitForRequests(weekdayViewsRequests, 2)
    await page.waitForFunction(() => document.querySelectorAll(".admin-analytics-weekday")[2]?.textContent?.startsWith("710"))
    assert.deepEqual(await weekdayValues(page), ["0", "0", "710", "0", "0", "0", "0"])
    assert.equal((await readWeekdayChart(page))[2].label, "Miércoles: 710 visualizaciones, 100% del total")
  } finally { await page.close() }
})

test("por día de la semana: tooltip con día, visualizaciones y % al pasar el mouse o enfocar, sin salirse de la página", async () => {
  const { page } = await openAnalytics(390, "dark")
  try {
    await readWeekdayChart(page)
    const columns = page.locator(".admin-analytics-weekday")
    const tooltip = (index: number) => columns.nth(index).locator(".admin-analytics-weekday-tooltip")
    assert.equal(await tooltip(2).evaluate((element) => getComputedStyle(element).opacity), "0", "oculto en reposo")

    await columns.nth(2).hover()
    await page.waitForFunction(() => getComputedStyle(document.querySelectorAll(".admin-analytics-weekday-tooltip")[2]).opacity === "1")
    assert.equal((await tooltip(2).innerText()).replace(/\s+/g, " ").trim(), "Miércoles 255 visualizaciones 35,9% del total")

    await page.mouse.move(0, 0)
    await columns.nth(6).focus()
    await page.waitForFunction(() => getComputedStyle(document.querySelectorAll(".admin-analytics-weekday-tooltip")[6]).opacity === "1")
    assert.equal((await tooltip(6).innerText()).replace(/\s+/g, " ").trim(), "Domingo 30 visualizaciones 4,2% del total")

    const bounds = await page.evaluate(() => Array.from(document.querySelectorAll(".admin-analytics-weekday-tooltip"), (element) => {
      const rect = element.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= document.documentElement.clientWidth
    }))
    assert.deepEqual(bounds, Array(7).fill(true), "ningún tooltip se sale de la pantalla en mobile")
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0)
  } finally { await page.close() }
})

test("por día de la semana: el ciclo global (00:00) y Actualizar ahora lo refrescan junto con las demás métricas", async () => {
  const api: ApiControl = { status: 200, hold: null }
  const { page, requests, peakRequests, weekdayRequests, weekdayViewsRequests } = await openAnalytics(1440, "dark", () => ROWS, { clockAt: CLOCK_START, api })
  try {
    await waitForRequests(weekdayViewsRequests, 1)
    assert.deepEqual(await weekdayValues(page), ["80", "95", "255", "120", "60", "70", "30"])

    api.weekdayViews = [10, 20, 30, 40, 50, 60, 500]
    await page.clock.runFor(60_000)
    await waitForRequests(weekdayViewsRequests, 2)
    await page.waitForFunction(() => document.querySelectorAll(".admin-analytics-weekday")[6]?.textContent?.startsWith("500"))
    await waitForText(page, "01:00")
    assert.deepEqual([requests.length, peakRequests.length, weekdayRequests.length, weekdayViewsRequests.length], [2, 2, 2, 2], "las cuatro métricas en el mismo ciclo, una consulta cada una")

    api.weekdayViews = [7, 0, 0, 0, 0, 0, 0]
    await refreshButton(page).click()
    await waitForRequests(weekdayViewsRequests, 3)
    await page.waitForFunction(() => document.querySelectorAll(".admin-analytics-weekday")[0]?.textContent?.startsWith("7"))
    await waitForText(page, "01:00")
    assert.deepEqual(await weekdayValues(page), ["7", "0", "0", "0", "0", "0", "0"])
    assert.deepEqual([requests.length, peakRequests.length, weekdayRequests.length, weekdayViewsRequests.length], [3, 3, 3, 3])
  } finally { await page.close() }
})

// --- Visualizaciones por hora del día ---------------------------------------------

test("por hora del día: usa exactamente el período global (Hoy, 7 días, 30 días y personalizado)", async () => {
  const { page, requests, hourlyRequests } = await openAnalytics(1440, "dark")
  try {
    await waitForRequests(hourlyRequests, 1)
    for (const [button, count] of [["Hoy", 2], ["Últimos 30 días", 3], ["Últimos 7 días", 4]] as const) {
      await page.getByRole("button", { name: button }).click()
      await waitForRequests(hourlyRequests, count)
      await waitForRequests(requests, count)
      assert.deepEqual(hourlyRequests[count - 1], requests[count - 1].range, `${button}: mismo período que Productos más vistos`)
    }
    assert.deepEqual(hourlyRequests[0], { from: addDays(TODAY, -6), to: TODAY })
    assert.deepEqual(hourlyRequests[1], { from: TODAY, to: TODAY })
    assert.deepEqual(hourlyRequests[2], { from: addDays(TODAY, -29), to: TODAY })

    await page.getByRole("button", { name: "Personalizado" }).click()
    const from = page.getByRole("textbox", { name: "Fecha inicial" })
    await from.fill("01/10/2026")
    await from.press("Tab")
    await page.keyboard.press("Escape")
    const to = page.getByRole("textbox", { name: "Fecha final" })
    await to.fill("15/10/2026")
    await to.press("Tab")
    const deadline = Date.now() + 5_000
    while (JSON.stringify(hourlyRequests.at(-1)) !== JSON.stringify({ from: "2026-10-01", to: "2026-10-15" }) && Date.now() < deadline) {
      await page.waitForTimeout(50)
    }
    assert.deepEqual(hourlyRequests.at(-1), { from: "2026-10-01", to: "2026-10-15" })
    assert.deepEqual(hourlyRequests.at(-1), requests.at(-1)?.range)
  } finally { await page.close() }
})

test("por hora del día: tooltip con franja exacta, visualizaciones y % al pasar el mouse o enfocar, sin salirse de la página", async () => {
  const { page } = await openAnalytics(390, "dark")
  try {
    await readHourlyChart(page)
    const columns = page.locator(".admin-analytics-hour")
    const tooltip = (index: number) => columns.nth(index).locator(".admin-analytics-hour-tooltip")
    const visible = (index: number) => page.waitForFunction(
      (position) => getComputedStyle(document.querySelectorAll(".admin-analytics-hour-tooltip")[position]).opacity === "1", index)
    assert.equal(await tooltip(20).evaluate((element) => getComputedStyle(element).opacity), "0", "oculto en reposo")

    await columns.nth(20).hover()
    await visible(20)
    assert.equal((await tooltip(20).innerText()).replace(/\s+/g, " ").trim(), "20:00 – 21:00 58 visualizaciones 8,2% del total")

    await page.mouse.move(0, 0)
    await columns.nth(4).focus()
    await visible(4)
    assert.equal((await tooltip(4).innerText()).replace(/\s+/g, " ").trim(), "04:00 – 05:00 0 visualizaciones 0% del total", "hora sin etiqueta en el eje y sin vistas: igual interactuable")

    await columns.nth(23).focus()
    await visible(23)
    assert.equal((await tooltip(23).innerText()).replace(/\s+/g, " ").trim(), "23:00 – 00:00 24 visualizaciones 3,4% del total")

    const bounds = await page.evaluate(() => Array.from(document.querySelectorAll(".admin-analytics-hour-tooltip"), (element) => {
      const rect = element.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= document.documentElement.clientWidth
    }))
    assert.deepEqual(bounds, Array(24).fill(true), "ningún tooltip se sale de la pantalla en mobile")
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0)
  } finally { await page.close() }
})

test("por hora del día: el ciclo global (00:00) y Actualizar ahora lo refrescan junto con el horario pico, que siempre es su barra más alta", async () => {
  const api: ApiControl = { status: 200, hold: null }
  const { page, requests, peakRequests, weekdayRequests, weekdayViewsRequests, hourlyRequests } = await openAnalytics(1440, "dark", () => ROWS, { clockAt: CLOCK_START, api })
  const peakMatchesChart = async () => {
    const hours = await readHourlyChart(page)
    const tallest = hours.reduce((best, column) => (column.height > best.height ? column : best))
    return tallest.label.startsWith(`${await peakCard(page).locator(".text-2xl").innerText()}:`)
  }
  try {
    await waitForRequests(hourlyRequests, 1)
    await peakCard(page).getByText("14:00 – 15:00").waitFor()
    assert.deepEqual(await hourlyValues(page), HOURLY_VIEWS)
    assert.ok(await peakMatchesChart())

    api.hourlyViews = hourlyWithPeak(20)
    await page.clock.runFor(60_000)
    await waitForRequests(hourlyRequests, 2)
    await peakCard(page).getByText("20:00 – 21:00").waitFor()
    await page.waitForFunction(() => document.querySelectorAll(".admin-analytics-hour")[20]?.getAttribute("aria-label")?.includes(": 100 visualizaciones"))
    await waitForText(page, "01:00")
    assert.ok(await peakMatchesChart(), "00:00: card y gráfico se actualizan juntos")
    assert.deepEqual(
      [requests.length, peakRequests.length, weekdayRequests.length, weekdayViewsRequests.length, hourlyRequests.length],
      [2, 2, 2, 2, 2],
      "las cinco métricas en el mismo ciclo, una consulta cada una",
    )

    // Empate 10 h = 20 h: gana la hora más temprana en la card y en el gráfico.
    api.hourlyViews = HOURLY_VIEWS.map((count, hour) => (hour === 10 || hour === 20 ? 90 : count))
    await refreshButton(page).click()
    await waitForRequests(hourlyRequests, 3)
    await peakCard(page).getByText("10:00 – 11:00").waitFor()
    await waitForText(page, "01:00")
    const values = await hourlyValues(page)
    assert.deepEqual([values[10], values[20]], [90, 90])
    assert.ok(await peakMatchesChart(), "empate: la primera barra más alta es la de la card")
    assert.deepEqual(
      [requests.length, peakRequests.length, weekdayRequests.length, weekdayViewsRequests.length, hourlyRequests.length],
      [3, 3, 3, 3, 3],
    )
  } finally { await page.close() }
})

test("por hora del día: cambiar de período nunca muestra las horas del período anterior", async () => {
  const api: ApiControl = { status: 200, hold: null }
  const { page, hourlyRequests } = await openAnalytics(1440, "light", () => ROWS, { api })
  try {
    await waitForRequests(hourlyRequests, 1)
    assert.deepEqual(await hourlyValues(page), HOURLY_VIEWS)
    let release!: () => void
    api.hold = new Promise((resolve) => { release = resolve })
    api.hourlyViews = hourlyWithPeak(9)
    await page.getByRole("button", { name: "Hoy" }).click()
    await waitForRequests(hourlyRequests, 2)
    await page.locator(".admin-analytics-hour-section[aria-busy=true]").waitFor()
    assert.equal(await page.locator(".admin-analytics-hour").count(), 0, "mientras carga el nuevo período, sin barras del anterior")
    api.hold = null
    release()
    await page.waitForFunction(() => document.querySelectorAll(".admin-analytics-hour")[9]?.getAttribute("aria-label")?.includes(": 100 visualizaciones"))
  } finally { await page.close() }
})