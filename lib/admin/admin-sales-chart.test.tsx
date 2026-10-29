import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act, createElement } from "react"

const SALES = [
  { date: "2026-10-01T15:00:00.000Z", channel: "BEYONIX Web" as const, grossAmount: 10_000 },
  { date: "2026-10-02T15:00:00.000Z", channel: "MercadoLibre Marketplace" as const, grossAmount: 4_000 },
  { date: "2026-10-03T15:00:00.000Z", channel: "Ventas externas" as const, grossAmount: 2_500 },
  { date: "2026-10-03T18:00:00.000Z", channel: "BEYONIX Web" as const, grossAmount: 6_000 },
]
const RANGE = { from: "2026-10-01", to: "2026-10-03" }

test("gráfico de ventas: series por canal, leyenda, tooltip, totales, ocultamiento y vacíos", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  const { SalesEvolutionChart } = await import("../../app/admin/sections/dashboard/sales-evolution-chart")
  const { createRoot } = await import("react-dom/client")
  const root = createRoot(document.getElementById("root")!)
  type ChartProps = Parameters<typeof SalesEvolutionChart>[0]
  const render = async (props: Partial<ChartProps> = {}) =>
    act(async () => {
      root.render(createElement(SalesEvolutionChart, { sales: SALES, range: RANGE, channelFilter: "todos", hidden: false, ...props }))
    })
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent?.trim().startsWith(label))
  const seriesLines = () =>
    [...document.querySelectorAll("svg[role=img] path[stroke]")].filter((path) => !path.getAttribute("stroke-dasharray"))
  const click = async (node: Element | undefined) => {
    assert.ok(node, "el control existe")
    await act(async () => (node as HTMLElement).click())
  }
  const press = async (key: string) => {
    const svg = document.querySelector("svg[role=img]")!
    await act(async () => {
      svg.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }))
    })
  }

  try {
    await render()
    assert.equal(seriesLines().length, 3, "una línea por canal con ventas")
    const legend = [...document.querySelectorAll(".admin-dash-legend-item")].map((node) => node.textContent)
    assert.equal(legend.length, 3)
    assert.match(legend[0] ?? "", /BEYONIX Web.*16\.000/)
    assert.match(legend[1] ?? "", /Mercado Libre.*4\.000/)
    assert.match(legend[2] ?? "", /Ventas externas.*2\.500/)
    assert.equal(document.querySelectorAll(".admin-sales-chart-axis").length > 3, true, "ejes con marcas")

    await press("End")
    const tooltip = document.querySelector("[role=status].admin-sales-chart-tooltip")
    assert.ok(tooltip, "tooltip con teclado")
    assert.match(tooltip.textContent ?? "", /sábado, 3 de octubre de 2026/)
    assert.match(tooltip.textContent ?? "", /6\.000.*BEYONIX Web/)
    assert.match(tooltip.textContent ?? "", /8\.500.*Total visible/)

    await click(button("Mercado Libre"))
    assert.equal(seriesLines().length, 2, "la leyenda oculta un canal")
    assert.equal(button("Mercado Libre")?.getAttribute("aria-pressed"), "false")

    await click(button("Total"))
    assert.equal(seriesLines().length, 1, "vista total: una sola línea")
    assert.ok(document.querySelector("svg[role=img] path[fill^='url(']"), "área bajo la línea única")

    await click(button("Mes"))
    await press("Home")
    assert.match(document.querySelector(".admin-sales-chart-tooltip")?.textContent ?? "", /octubre de 2026 · parcial \(1 oct – 3 oct 2026\).*22\.500.*Total/)

    await click(button("Tabla"))
    assert.ok(document.querySelector("table caption"), "vista de tabla accesible")

    await render({ hidden: true })
    assert.equal(button("CSV")?.hasAttribute("disabled"), true, "CSV deshabilitado con valores ocultos")
    assert.doesNotMatch(document.body.textContent ?? "", /22\.500/)

    await render({ channelFilter: "Ventas externas", hidden: false })
    assert.equal(button("Por canal")?.hasAttribute("disabled"), true, "con un canal filtrado no hay vista por canal")

    await render({ sales: [] })
    assert.match(document.body.textContent ?? "", /Sin ventas en este período/)
    assert.equal(document.querySelector("svg[role=img]"), null)

    await render({ range: null })
    assert.match(document.body.textContent ?? "", /Rango de fechas inválido/)
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test("gráfico de ventas: un tramo indeterminado es un hueco, nunca un punto en $0", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  const { SalesEvolutionChart, getChartSegments } = await import("../../app/admin/sections/dashboard/sales-evolution-chart")
  const { createRoot } = await import("react-dom/client")
  const root = createRoot(document.getElementById("root")!)
  type ChartProps = Parameters<typeof SalesEvolutionChart>[0]
  const render = async (props: Partial<ChartProps>) =>
    act(async () => {
      root.render(createElement(SalesEvolutionChart, { sales: [], range: RANGE, channelFilter: "todos", hidden: false, ...props }))
    })
  const svg = () => document.querySelector("svg[role=img]")!
  const seriesPath = (variable: string) =>
    [...svg().querySelectorAll("path[stroke]")].find((path) => path.getAttribute("stroke") === `var(${variable})`)
  // Coordenadas y de cada subpath "M x y" / "L x y".
  const pathPoints = (d: string) =>
    [...d.matchAll(/([ML]) ([\d.]+) ([\d.]+)/g)].map(([, command, , y]) => ({ command, y: Number(y) }))
  const baselineY = () =>
    Number([...svg().querySelectorAll("line")].find((line) => line.getAttribute("stroke") === "var(--sales-chart-baseline)")?.getAttribute("y1"))
  const press = async (key: string) => {
    await act(async () => {
      svg().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }))
    })
  }
  const tooltip = () => document.querySelector(".admin-sales-chart-tooltip")?.textContent ?? ""

  // Día 1 = 10.000 · Día 2 = indeterminado · Día 3 = 12.000.
  const web = (day: number, grossAmount: number | null) =>
    ({ date: `2026-10-0${day}T15:00:00.000Z`, channel: "BEYONIX Web" as const, grossAmount })

  try {
    // El dato que recibe la serie es null, no 0: corta en dos tramos.
    assert.deepEqual(getChartSegments([10_000, null, 12_000]), [
      [{ index: 0, value: 10_000 }],
      [{ index: 2, value: 12_000 }],
    ])

    await render({ sales: [web(1, 10_000), web(2, null), web(3, 12_000)], channelFilter: "BEYONIX Web" })
    const line = seriesPath("--sales-chart-web")
    assert.ok(line, "línea de la serie")
    const points = pathPoints(line.getAttribute("d") ?? "")
    // Dos subpaths de un punto: no hay "L" que cruce el hueco ni vértice en el eje 0.
    assert.deepEqual(points.map((point) => point.command), ["M", "M"])
    assert.ok(points.every((point) => point.y < baselineY()), "ningún vértice en $0")
    // Marcadores sólo en los días con dato; el área tampoco rellena el hueco.
    assert.equal(svg().querySelectorAll(`circle[fill="var(--sales-chart-web)"]`).length, 2)
    assert.equal(svg().querySelector("path[fill^='url(']"), null, "sin área a través del hueco")

    await press("Home")
    await press("ArrowRight")
    assert.match(tooltip(), /Pendiente/)
    assert.doesNotMatch(tooltip(), /\$\s?0(?![\d.,])/)
    assert.equal(svg().querySelectorAll("circle[r='5']").length, 0, "sin punto activo en $0")

    // Web indeterminado el día 2, ML determinable los tres días.
    const ml = (day: number, grossAmount: number) =>
      ({ date: `2026-10-0${day}T15:00:00.000Z`, channel: "MercadoLibre Marketplace" as const, grossAmount })
    await render({ sales: [web(1, 10_000), web(2, null), web(3, 12_000), ml(1, 5_000), ml(2, 5_000), ml(3, 6_000)] })
    assert.deepEqual(pathPoints(seriesPath("--sales-chart-web")?.getAttribute("d") ?? "").map((point) => point.command), ["M", "M"])
    const mlPoints = pathPoints(seriesPath("--sales-chart-ml")?.getAttribute("d") ?? "")
    assert.deepEqual(mlPoints.map((point) => point.command), ["M", "L", "L"], "ML sigue continua")
    assert.ok(mlPoints.every((point) => point.y < baselineY()))

    await press("Home")
    await press("ArrowRight")
    assert.match(tooltip(), /Pendiente.*BEYONIX Web/)
    assert.match(tooltip(), /5\.000.*Mercado Libre/)
    assert.match(tooltip(), /Pendiente.*Total visible/)
    // El punto activo sólo existe para ML.
    assert.equal(svg().querySelectorAll("circle[r='5']").length, 1)
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
