import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser } from "playwright-core"

const stubs: Plugin = {
  name: "category-card-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^next\/(image|link)$/ }, (args) => ({ path: args.path, namespace: "stub" }))
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: args.path === "next/image"
        ? `import { createElement } from "react"; export default function Image({ src, alt, fill, sizes, ...props }) { return createElement("img", { ...props, src, alt, style: fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : undefined }) }`
        : `import { createElement } from "react"; export default function Link({ href, ...props }) { return createElement("a", { ...props, href }) }`,
      loader: "js",
      resolveDir: process.cwd(),
    }))
  },
}

const categories = [
  { slug: "tecnologia", nombre: "Tecnología & Gadgets", width: 1568, height: 600 },
  { slug: "accesorios", nombre: "Accesorios y Utilidades", width: 1920, height: 520 },
  { slug: "hogar", nombre: "Hogar & Bazar", width: 1568, height: 600 },
].map((category) => ({
  ...category,
  descripcion: `Explorá ${category.nombre}`,
  imagen: `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${category.width}" height="${category.height}"><rect width="100%" height="100%" fill="#06182b"/><rect x="1" y="1" width="${category.width - 2}" height="${category.height - 2}" fill="none" stroke="#00bdf2" stroke-width="2"/><text x="5%" y="40%" fill="white" font-size="65" font-family="Arial">${category.nombre.replaceAll("&", "&amp;")}</text></svg>`).toString("base64")}`,
}))

const ENTRY = `
import { createElement as h } from "react"
import { createRoot } from "react-dom/client"
import { CategoryCard } from "@/components/category/category-card"
createRoot(document.getElementById("root")).render(h("div", { className: "container mx-auto px-4 lg:px-8" },
  h("div", { className: "grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3" },
    window.__CATEGORIES.map((categoria) => h(CategoryCard, { key: categoria.slug, categoria, fallbackDescription: "Explorá esta categoría" })))))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "category-card-fixture.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

for (const width of [390, 430, 768, 1366, 1440, 1920]) {
  test(`las tres cards preservan el arte y no desbordan a ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    try {
      await page.setContent(`<!doctype html><html lang="es" data-account-theme="dark" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}};window.__CATEGORIES=${JSON.stringify(categories)}</script><script>${bundle}</script></body></html>`)
      await page.waitForFunction(() => [...document.querySelectorAll("a img")].length === 3 && [...document.querySelectorAll("a img")].every((img) => (img as HTMLImageElement).naturalWidth > 0))
      const result = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        cards: [...document.querySelectorAll("a:has(img)")].map((card) => {
          const image = card.querySelector("img") as HTMLImageElement
          const frame = image.parentElement!.getBoundingClientRect()
          const box = image.getBoundingClientRect()
          const footer = image.parentElement!.parentElement!.lastElementChild!.getBoundingClientRect()
          const ratio = image.naturalWidth / image.naturalHeight
          const renderedWidth = Math.min(box.width, box.height * ratio)
          const renderedHeight = Math.min(box.height, box.width / ratio)
          return {
            name: card.getAttribute("aria-label"), fit: getComputedStyle(image).objectFit,
            ratio: frame.width / frame.height, renderedWidth, renderedHeight,
            imageWidth: box.width, imageHeight: box.height,
            footerBelow: footer.top >= frame.bottom - 1,
            withinViewport: frame.left >= 0 && frame.right <= window.innerWidth,
          }
        }),
      }))
      assert.equal(result.overflow, 0)
      assert.deepEqual(result.cards.map((card) => card.name), categories.map((category) => category.nombre))
      for (const card of result.cards) {
        assert.equal(card.fit, "contain", `${card.name}: imagen completa`)
        assert.ok(Math.abs(card.ratio - 48 / 13) < 0.02, `${card.name}: proporción de card`)
        assert.ok(card.renderedWidth <= card.imageWidth + 1 && card.renderedHeight <= card.imageHeight + 1)
        assert.ok(card.footerBelow, `${card.name}: la descripción no tapa el título`)
        assert.ok(card.withinViewport, `${card.name}: dentro del viewport`)
      }
    } finally { await page.close() }
  })
}

for (const width of [390, 1440]) {
  test(`la franja y la flecha mantienen los mismos colores en Light y Dark a ${width}px`, async () => {
    const colorsByTheme = []
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      try {
        await page.setContent(`<!doctype html><html lang="es" data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}};window.__CATEGORIES=${JSON.stringify(categories)}</script><script>${bundle}</script></body></html>`)
        await page.waitForSelector("a:has(img) p")
        const colors = await page.locator("a:has(img)").evaluateAll((cards) => cards.map((card) => {
          const footer = card.lastElementChild as HTMLElement
          const description = footer.querySelector("p") as HTMLElement
          const arrow = footer.querySelector("span") as HTMLElement
          return {
            background: getComputedStyle(footer).backgroundColor,
            description: getComputedStyle(description).color,
            arrowBackground: getComputedStyle(arrow).backgroundColor,
            arrowColor: getComputedStyle(arrow).color,
          }
        }))
        assert.equal(colors.length, categories.length)
        for (const color of colors) {
          assert.equal(color.background, "rgb(10, 10, 10)")
          assert.equal(color.description, "rgb(255, 255, 255)")
          assert.equal(color.arrowColor, "rgb(140, 200, 242)")
        }
        colorsByTheme.push(colors)
      } finally { await page.close() }
    }
    assert.deepEqual(colorsByTheme[0], colorsByTheme[1])
  })
}
