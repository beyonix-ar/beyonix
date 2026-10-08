import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Escala global de la tienda con el CSS REAL y el HeroSection real:
// - el rem en notebook/desktop sigue también el ALTO útil (1366x768 al 100%
//   ≈ 657px con la barra del navegador): antes 15.9px, todo "con zoom";
// - títulos display (text-5xl/6xl) fluidos;
// - Admin conserva su escala;
// - sin scroll horizontal de 320 a 2560.

const SHOTS = process.env.RESPONSIVE_SCALE_SHOTS

const stubs: Plugin = {
  name: "responsive-scale-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "next/image": `import { createElement } from "react"; export default function Image({ src, alt, fill, priority, sizes, ...props }) { return createElement("img", { ...props, src: String(src), alt, style: fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : undefined }) }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, prefetch, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref }) })`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const PRODUCT = {
  id: 7, nombre: "Encendedor eléctrico con carga USB", slug: "encendedor", precio: 10_000, precio_anterior: 12_500,
  stock: 10, activo: true, imagen_principal: "https://img.test/p.svg", imagenes_producto: [], producto_variantes: [],
  categorias: { nombre: "Accesorios" },
}

const ENTRY = `
import { createElement as h } from "react"
import { createRoot } from "react-dom/client"
import { HeroSection } from "@/components/hero-section"
createRoot(document.getElementById("hero")).render(h(HeroSection, { featuredProduct: ${JSON.stringify(PRODUCT)}, onOpenPreview() {} }))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "responsive-scale-fixture.tsx" },
    bundle: true,
    format: "iife",
    write: false,
    jsx: "automatic",
    plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(width: number, height: number, options: { admin?: boolean; theme?: "light" | "dark" } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith("https://img.test")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ddd"/></svg>' })
    return route.abort()
  })
  const content = options.admin
    ? `<div class="beyonix-admin-shell"><h1 class="text-6xl">Admin</h1></div>`
    : `<h1 data-display-6 class="text-4xl sm:text-5xl lg:text-6xl font-bold">Explorá la tienda por categoría</h1><h1 data-display-5 class="text-4xl lg:text-5xl font-bold">Contacto</h1><div id="hero"></div>`
  await page.setContent(`<!doctype html><html lang="es" data-account-theme="${options.theme ?? "dark"}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page">${content}<script>window.process={env:{NODE_ENV:"production"}}</script>${options.admin ? "" : `<script>${bundle}</script>`}</body></html>`)
  if (!options.admin) await page.waitForSelector("#hero h1")
  return page
}

const rootFont = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
const fontSize = (page: Page, selector: string) => page.evaluate((target) => parseFloat(getComputedStyle(document.querySelector(target)!).fontSize), selector)

test("rem: mobile/tablet sin cambios; notebook según alto útil; desktop grande y TV con más aire", async () => {
  const expected: [number, number, number, number][] = [
    // ancho, alto, mínimo, máximo (px)
    [390, 844, 15, 15],
    [768, 1024, 15, 15.2],
    [1366, 657, 14, 14.05], // 1366x768 al 100% con la barra de Chrome
    [1366, 768, 14.7, 14.8],
    [1440, 789, 14.9, 15],
    [1920, 960, 16.15, 16.25],
    [2560, 1300, 17.25, 17.25],
  ]
  for (const [width, height, min, max] of expected) {
    const page = await open(width, height)
    try {
      const size = await rootFont(page)
      assert.ok(size >= min && size <= max, `${width}x${height}: rem ${size}px (esperado ${min}–${max})`)
    } finally { await page.close() }
  }
})

test("Admin conserva su escala (no hereda la del alto de la tienda)", async () => {
  const page = await open(1366, 657, { admin: true })
  try {
    assert.ok(Math.abs((await rootFont(page)) - 15.91) < 0.05, "rem de Admin igual que antes a 1366")
  } finally { await page.close() }
})

test("títulos display fluidos: ~46px en notebook, ~60px en desktop grande; mobile igual", async () => {
  const cases: [number, number, [number, number], [number, number]][] = [
    [390, 844, [33.5, 34], [33.5, 34]],
    [1366, 657, [42, 48], [36, 41]],
    [1920, 960, [58, 62], [46, 49]],
  ]
  for (const [width, height, [min6, max6], [min5, max5]] of cases) {
    const page = await open(width, height)
    try {
      const six = await fontSize(page, "[data-display-6]")
      const five = await fontSize(page, "[data-display-5]")
      assert.ok(six >= min6 && six <= max6, `${width}: text-6xl ${six}px`)
      assert.ok(five >= min5 && five <= max5, `${width}: text-5xl ${five}px`)
    } finally { await page.close() }
  }
})

for (const theme of ["dark", "light"] as const) {
  test(`hero ${theme} 1366x657: título proporcionado y hero completo (beneficios + producto) en la primera pantalla`, async () => {
    const page = await open(1366, 657, { theme })
    try {
      // El hero va al tope del documento en este fixture (sin los títulos de muestra).
      await page.evaluate(() => document.querySelectorAll("[data-display-6], [data-display-5]").forEach((element) => element.remove()))
      const layout = await page.evaluate(() => {
        const hero = document.querySelector("#hero")!
        const title = hero.querySelector("h1")!
        const card = hero.querySelector(".beyonix-featured-product-card")!.getBoundingClientRect()
        const trust = [...hero.querySelectorAll(".mt-8.grid > *")].map((element) => element.getBoundingClientRect().bottom)
        return { title: parseFloat(getComputedStyle(title).fontSize), cardBottom: card.bottom, trustBottom: Math.max(...trust) }
      })
      assert.ok(layout.title >= 44 && layout.title <= 52, `H1 ${layout.title}px (antes 59px)`)
      assert.ok(layout.trustBottom <= 657, `beneficios visibles sin scroll (${Math.round(layout.trustBottom)}px)`)
      assert.ok(layout.cardBottom <= 657, `producto destacado completo (${Math.round(layout.cardBottom)}px)`)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/hero-${theme}-1366x657.png` })
    } finally { await page.close() }
  })
}

test("hero mobile 390 y desktop 1920: mobile igual que antes, desktop grande con más aire", async () => {
  const mobile = await open(390, 844)
  try {
    assert.equal(await fontSize(mobile, "#hero h1"), 36, "mobile sin cambios")
  } finally { await mobile.close() }
  const desktop = await open(1920, 960)
  try {
    const size = await fontSize(desktop, "#hero h1")
    assert.ok(size >= 68 && size <= 78, `H1 desktop ${size}px`)
  } finally { await desktop.close() }
})

const VIEWPORTS: [number, number][] = [
  [320, 568], [360, 800], [390, 844], [412, 915], [430, 932], [768, 1024], [820, 1180],
  [1024, 768], [1280, 720], [1366, 768], [1440, 900], [1536, 864], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160],
]

test("sin scroll horizontal ni contenido fuera de pantalla de 320px a 4K", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await open(width, height)
    try {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(overflow <= 0, `${width}x${height}: scroll horizontal ${overflow}px`)
      const offscreen = await page.evaluate(() => [...document.querySelectorAll("#hero *")]
        .filter((element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1) })
        .map((element) => element.tagName).slice(0, 3))
      assert.deepEqual(offscreen, [], `${width}x${height}: elementos fuera de pantalla`)
      // Contenido centrado y acotado en pantallas anchas (no se estira infinito).
      if (width >= 1920) {
        const box = await page.evaluate(() => {
          const rect = document.querySelector("#hero .container")!.getBoundingClientRect()
          const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
          return { width: rect.width, left: rect.left, right: window.innerWidth - rect.right, max: 98 * rem }
        })
        assert.ok(box.width <= box.max + 1, `${width}: contenedor acotado a 98rem (${Math.round(box.width)}px)`)
        assert.ok(Math.abs(box.left - box.right) <= 2, `${width}: contenedor centrado`)
      }
    } finally { await page.close() }
  }
})
