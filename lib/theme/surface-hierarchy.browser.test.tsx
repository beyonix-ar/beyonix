import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import type { Browser, Page } from "playwright-core"

import { captureAll, launch, loadFixture, probeStyle, type Capture } from "./surface-capture"
import { SURFACE_FIXTURES } from "./surface-fixtures"

// Sistema semántico de superficies (globals.css) medido en Edge/Chrome real
// con el CSS del proyecto:
// - Dark queda idéntico (referencia capturada antes de la migración).
// - Light: página != sección != card != control, con diferencia perceptible.
// - Las reglas legacy [rounded][border] no pisan las superficies declaradas.
// - Textos legibles sobre cada nivel; misma jerarquía en todos los anchos.

const css = readFileSync("app/globals.css", "utf8")
const source = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

type Rgba = [number, number, number, number]

function parse(value: string): Rgba {
  const match = value.match(/rgba?\(([^)]+)\)/)
  assert.ok(match, `color no RGB: ${value}`)
  const [r, g, b, a = "1"] = match[1].split(",").map((part) => part.trim())
  return [Number(r), Number(g), Number(b), Number(a)]
}

function luminance([r, g, b]: Rgba) {
  const channel = (value: number) => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: Rgba, b: Rgba) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

// Referencia Dark capturada con el globals.css ANTERIOR a esta migración
// (npx tsx lib/theme/surface-compare.ts <css-anterior> app/globals.css).
const DARK_REFERENCE: Record<string, Record<string, string>> = {
  "admin-base": {
    "[data-page]": "rgba(17, 42, 67, 0.28)",
    "[data-section]": "rgba(8, 18, 29, 0.98)",
    "[data-card]": "rgba(13, 27, 42, 0.98)",
    "[data-field]": "rgb(11, 17, 26)",
    "[data-legacy-section]": "rgba(7, 17, 27, 0.98)",
    "[data-legacy-card]": "rgba(11, 22, 34, 0.98)",
  },
  "admin-claims": {
    "[data-page]": "rgba(17, 42, 67, 0.28)",
    "[data-order-module]": "rgba(7, 17, 27, 0.98)",
    "[data-claims]": "rgba(5, 12, 20, 0.98)",
    "[data-reception]": "rgb(27, 38, 50)",
    "[data-stepper]": "rgba(17, 42, 67, 0.28)",
    "[data-product]": "rgb(15, 28, 43)",
    "[data-tile]": "rgba(255, 255, 255, 0.03)",
    "[data-note]": "rgb(26, 26, 26)",
  },
  account: {
    "[data-account-page]": "rgb(5, 7, 10)",
    "[data-account-panel]": "rgb(13, 17, 23)",
    "[data-account-item]": "rgb(17, 24, 32)",
    "[data-account-input]": "rgb(11, 17, 26)",
  },
  checkout: {
    "[data-checkout-page]": "rgba(0, 0, 0, 0)",
    "[data-checkout-panel]": "rgb(7, 12, 18)",
    "[data-checkout-card]": "rgb(16, 21, 28)",
    "[data-checkout-input]": "rgb(16, 21, 28)",
  },
  catalog: {
    "[data-catalog-page]": "rgb(0, 0, 0)",
    "[data-product-card]": "oklch(0.12 0 0)",
    "[data-product-body]": "rgb(17, 17, 17)",
    "[data-cart-panel]": "rgb(10, 10, 10)",
    "[data-cart-item]": "rgb(17, 17, 17)",
  },
}

// Valores Light definitivos de los tokens --bx-* por variante.
const LIGHT_TOKENS = {
  admin: { page: "#e8ecf1", section: "#d1d9e2", card: "#f5f7fa", raised: "#ffffff", field: "#ffffff" },
  account: { page: "#f1f4f8", section: "#e2e8ef", card: "#ffffff", raised: "#ffffff", field: "#ffffff" },
} as const

const hexToRgba = (hex: string): Rgba => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
  1,
]

let browser: Browser
let light: Capture
let dark: Capture

test.before(async () => {
  browser = await launch()
  light = await captureAll(css, "light", browser)
  dark = await captureAll(css, "dark", browser)
})

test.after(async () => {
  await browser.close()
})

test("el marcado de los fixtures usa las clases reales de cada zona", () => {
  const controls = source("app/admin/components/admin-controls.tsx")
  assert.match(controls, /section: "bx-surface bx-surface-section"/)
  assert.match(controls, /cn\(adminCardClassName, adminSurfaceLevel\.section, compact/)
  assert.equal(controls.split("adminSurfaceLevel.card").length - 1, 3, "AdminCard, AdminStatCard, AdminEmptyState")
  assert.equal(controls.split("adminSurfaceLevel.raised").length - 1, 2, "AdminModal, AdminDrawer")
  const pedidos = source("app/admin/sections/pedidos/admin-pedidos.tsx")
  assert.equal(pedidos.split("admin-order-detail-scope bx-surface bx-surface-section").length - 1, 2)
  assert.equal(pedidos.split("bx-surface-inherit").length - 1, 2)
  const claims = source("components/claims/admin-claim-manager.tsx")
  assert.match(claims, /admin-claim-card admin-claim-reception-panel bx-surface bx-surface-section/)
  assert.equal(claims.split('"admin-claim-card bx-surface bx-surface-section rounded-xl border p-3"').length - 1, 4)
  assert.match(claims, /admin-claim-chat-panel bx-surface bx-surface-section/)
  const checkout = source("app/checkout/page.tsx")
  assert.match(checkout, /"checkout-panel checkout-form-panel relative overflow-hidden rounded-xl border border-\[#112A43\] bg-\[#070C12\]/)
  assert.match(checkout, /"checkout-option flex w-full cursor-pointer rounded-lg border border-beyonix-blue-light\/16 bg-\[#10151C\]/)
  assert.match(source("components/category/category-product-card.tsx"), /<article className="bx-surface bx-surface-raised relative z-10/)
  assert.match(source("components/cart/cart-item.tsx"), /beyonix-cart-item bx-surface bx-surface-card/)
  assert.match(source("components/cart/cart-summary.tsx"), /beyonix-cart-summary-box bx-surface bx-surface-card/)
})

test("Dark: todas las superficies conservan exactamente su color anterior", () => {
  for (const [fixture, probes] of Object.entries(DARK_REFERENCE)) {
    for (const [selector, expected] of Object.entries(probes)) {
      assert.equal(dark[fixture][selector].background, expected, `${fixture} ${selector}`)
    }
  }
})

test("Light: cada sonda toma el token de su nivel", () => {
  for (const fixture of SURFACE_FIXTURES) {
    const tokens = LIGHT_TOKENS[fixture.theme]
    for (const probe of fixture.probes) {
      const actual = parse(light[fixture.name][probe.selector].background)
      assert.deepEqual(actual, hexToRgba(tokens[probe.role]), `${fixture.name} ${probe.selector} (${probe.role})`)
    }
  }
})

test("Light: la jerarquía se distingue por fondo, no sólo por borde", () => {
  const ratio = (theme: keyof typeof LIGHT_TOKENS, a: keyof (typeof LIGHT_TOKENS)["admin"], b: keyof (typeof LIGHT_TOKENS)["admin"]) =>
    contrast(hexToRgba(LIGHT_TOKENS[theme][a]), hexToRgba(LIGHT_TOKENS[theme][b]))

  // Mismo modelo en toda la web: página -> módulo (azul grisáceo, más oscuro)
  // -> card (blanca/casi blanca) -> control (blanco + borde de campo).
  // Admin (operativo, más marcado).
  assert.ok(ratio("admin", "page", "section") >= 1.15, "admin: página vs sección")
  assert.ok(ratio("admin", "section", "card") >= 1.25, "admin: sección vs card")
  assert.ok(ratio("admin", "card", "raised") >= 1.04, "admin: card vs control (+ borde y sombra)")
  // Tienda / cuenta / checkout (comercial, más suave).
  assert.ok(ratio("account", "page", "section") >= 1.1, "tienda: página vs sección")
  assert.ok(ratio("account", "section", "card") >= 1.2, "tienda: sección vs card")
  // Ningún par página/sección o sección/card comparte tono.
  for (const theme of ["admin", "account"] as const) {
    const values = LIGHT_TOKENS[theme]
    assert.notEqual(values.page, values.section)
    assert.notEqual(values.section, values.card)
  }
  // Los campos se distinguen de la card que los contiene por borde de campo.
  const tokens = (selector: string) => css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)))
  for (const [theme, selector] of [
    ["admin", 'html[data-admin-theme="light"] :is(.beyonix-admin-shell, .admin-portal-scope) {\n  --bx-surface-page'],
    ["account", 'html[data-account-theme="light"][data-account-scope] {\n  --bx-surface-page'],
  ] as const) {
    const border = tokens(selector).match(/--bx-border-field: (#[0-9a-f]{6});/)?.[1]
    assert.ok(border, `${theme}: --bx-border-field`)
    // WCAG 1.4.11 (contraste de componentes de interfaz): >= 3:1.
    assert.ok(contrast(hexToRgba(border), hexToRgba(LIGHT_TOKENS[theme].card)) >= 3, `${theme}: borde de campo visible`)
  }
})

test("Light: las reglas legacy no pisan superficies declaradas (sección anidada sigue siendo sección)", () => {
  // Recepción está anidada dentro de dos contenedores [rounded][border]: la
  // regla legacy la pintaría como "card"; la clase semántica manda.
  assert.deepEqual(parse(light["admin-claims"]["[data-reception]"].background), hexToRgba(LIGHT_TOKENS.admin.section))
  assert.deepEqual(parse(light["admin-claims"]["[data-order-module]"].background), hexToRgba(LIGHT_TOKENS.admin.section))
  // Y el mecanismo legacy (sin clases) usa los mismos tokens.
  assert.deepEqual(parse(light["admin-base"]["[data-legacy-section]"].background), hexToRgba(LIGHT_TOKENS.admin.section))
  assert.deepEqual(parse(light["admin-base"]["[data-legacy-card]"].background), hexToRgba(LIGHT_TOKENS.admin.card))
})

test("Light: textos principales y secundarios legibles sobre cada nivel", () => {
  const texts = {
    admin: { primary: "#0f172a", secondary: "#262b33", muted: "#2b3039" },
    account: { primary: "#0f172a", secondary: "#262b33", muted: "#2b3039" },
  }
  for (const theme of ["admin", "account"] as const) {
    for (const level of ["page", "section", "card", "raised"] as const) {
      const background = hexToRgba(LIGHT_TOKENS[theme][level])
      for (const [kind, color] of Object.entries(texts[theme])) {
        assert.ok(contrast(hexToRgba(color), background) >= 7, `${theme} ${level} ${kind}`)
      }
    }
  }
  // Tokens de texto reales del tema claro (no inventados en el test).
  assert.match(css, /--beyonix-light-text-secondary: #262b33;/)
  assert.match(css, /--beyonix-light-text-muted: #2b3039;/)
})

test("CSS: tokens únicos por variante y sin selectores nuevos basados en [rounded][border]", () => {
  const start = css.indexOf("SISTEMA SEMÁNTICO DE SUPERFICIES")
  assert.ok(start > 0)
  const block = css.slice(start)
  assert.doesNotMatch(block, /\[class\*=/, "el bloque nuevo no adivina superficies por clases Tailwind")
  for (const [theme, selector] of [
    ["admin", 'html[data-admin-theme="light"] :is(.beyonix-admin-shell, .admin-portal-scope) {'],
    ["account", 'html[data-account-theme="light"][data-account-scope] {'],
  ] as const) {
    const body = block.slice(block.indexOf(selector), block.indexOf("}", block.indexOf(selector)))
    for (const [role, value] of Object.entries(LIGHT_TOKENS[theme])) {
      assert.match(body, new RegExp(`--bx-surface-${role}: ${value};`), `${theme} ${role}`)
    }
  }
  // Los sistemas anteriores apuntan a los tokens nuevos.
  for (const mapping of [
    "--admin-bg: var(--bx-surface-page);",
    "--admin-control: var(--bx-surface-field);",
    "--account-surface: var(--bx-surface-section);",
    "--account-surface-raised: var(--bx-surface-card);",
    "--account-input: var(--bx-surface-field);",
  ]) {
    assert.ok(css.includes(mapping), mapping)
  }
  // Las reglas legacy por [rounded][border] del admin Light excluyen .bx-surface.
  const legacy = css.split("\n").filter((line) => /^html\[data-admin-theme="light"\] \.beyonix-admin-main :where\(section, article, aside, details, form, div\)\[class\*="rounded"\]\[class\*="border"\]/.test(line))
  assert.ok(legacy.length >= 2)
  assert.ok(css.includes('[class*="border"]:not(.bx-surface) {'))
})

test("responsive: la jerarquía no depende del ancho (1280-1920 y 390)", async () => {
  const page: Page = await browser.newPage()
  await page.route("**/*", (route) => route.abort())
  try {
    for (const width of [390, 1280, 1366, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      for (const fixture of SURFACE_FIXTURES) {
        await loadFixture(page, css, fixture, "light")
        for (const probe of fixture.probes) {
          const style = await probeStyle(page, probe.selector)
          assert.equal(style.background, light[fixture.name][probe.selector].background, `${width} ${fixture.name} ${probe.selector}`)
        }
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `${width} ${fixture.name}: sin scroll horizontal`,
        )
      }
    }
  } finally {
    await page.close()
  }
})
