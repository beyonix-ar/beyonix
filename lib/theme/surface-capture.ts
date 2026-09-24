// Captura los fondos/bordes computados de cada sonda de SURFACE_FIXTURES con
// el globals.css real. Lo usan el test visual y, a mano, la generación de la
// referencia de Dark (node --import tsx lib/theme/surface-capture.ts).
import { readFileSync } from "node:fs"
import { chromium, type Browser, type Page } from "playwright-core"

import { SURFACE_FIXTURES, TAILWIND_SHIM, type SurfaceFixture } from "./surface-fixtures"

export type Theme = "dark" | "light"
export interface ProbeStyle {
  background: string
  border: string
}
export type Capture = Record<string, Record<string, ProbeStyle>>

export function launch(): Promise<Browser> {
  return chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
}

export async function loadFixture(page: Page, css: string, fixture: SurfaceFixture, theme: Theme) {
  const attributes =
    fixture.theme === "admin"
      ? `data-admin-theme="${theme}"`
      : `data-account-theme="${theme}" data-account-scope="tienda"`
  // Tailwind v4 emite las variables de `@theme` en :root; sin compilar, el
  // navegador ignora el at-rule, así que se reproduce esa emisión acá.
  const runtimeCss = css.replace(/@theme inline\s*\{/g, ":root {")
  await page.setContent(
    `<html ${attributes}><head><style>${runtimeCss}</style><style>${TAILWIND_SHIM}</style></head><body>${fixture.markup}</body></html>`,
  )
}

// Color de fondo "efectivo": color plano, o la primera parada opaca si el
// fondo es un gradiente (paneles del admin en Dark).
export async function probeStyle(page: Page, selector: string): Promise<ProbeStyle> {
  return page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element)
    const firstStop = style.backgroundImage.match(/rgba?\([^)]+\)/)?.[0]
    const color = style.backgroundColor
    const transparent = color === "rgba(0, 0, 0, 0)"
    return {
      background: transparent && firstStop ? firstStop : color,
      border: style.borderTopColor,
    }
  })
}

export async function captureAll(css: string, theme: Theme, browser: Browser): Promise<Capture> {
  const page = await browser.newPage()
  await page.route("**/*", (route) => route.abort())
  const capture: Capture = {}
  for (const fixture of SURFACE_FIXTURES) {
    await loadFixture(page, css, fixture, theme)
    capture[fixture.name] = {}
    for (const probe of fixture.probes) {
      capture[fixture.name][probe.selector] = await probeStyle(page, probe.selector)
    }
  }
  await page.close()
  return capture
}

async function main() {
  const css = readFileSync(process.argv[2] ?? "app/globals.css", "utf8")
  const theme: Theme = process.argv[3] === "light" ? "light" : "dark"
  const browser = await launch()
  try {
    console.log(JSON.stringify(await captureAll(css, theme, browser), null, 2))
  } finally {
    await browser.close()
  }
}

if (process.argv[1]?.endsWith("surface-capture.ts")) void main()
