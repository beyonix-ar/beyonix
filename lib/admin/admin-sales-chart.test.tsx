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
