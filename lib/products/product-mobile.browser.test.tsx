import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Producto en mobile con los componentes REALES (PDP y modal) y el CSS del
// proyecto, en Light y Dark. Stubs sólo de infraestructura (carrito, imagen
// de Next, router). Cubre: sin miniaturas en mobile (sí desde sm), flechas,
// swipe, indicador "n / N" discreto, título/precio/stock proporcionados y
// sin overflow; desktop sin cambios.

const SHOTS = process.env.PRODUCT_MOBILE_SHOTS

const stubs: Plugin = {
  name: "product-mobile-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/cart-context": `export function useCart() { return { addToCart() {}, decreaseQuantity() {}, removeFromCart() {}, getQuantity() { return 0 }, isInCart() { return false }, openCart() {} } }`,
      "next/image": `import { createElement } from "react"; export default function Image({ src, alt, fill, priority, sizes, onLoad, ...props }) { return createElement("img", { ...props, src: String(src), alt, onLoad, style: fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : undefined }) }`,
      "next/navigation": `export function useRouter() { return { push() {}, replace() {}, prefetch() {} } } export function usePathname() { return "/productos/encendedor" }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, prefetch, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref }) })`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const PRODUCT = {
  id: 7,
  nombre: "Encendedor USB recargable con nombre largo para probar el ajuste",
  slug: "encendedor",
  precio: 10_000,
  precio_anterior: 14_000,
  descuento: 29,
  stock: 25,
  sku: "ENC",
  activo: true,
  descripcion: "<p>Encendedor recargable.</p>",
  video_url: null,
  categorias: { nombre: "Accesorios y utilidades" },
  imagenes_producto: [{ url: "https://img.test/1.svg" }, { url: "https://img.test/2.svg" }, { url: "https://img.test/3.svg" }],
  imagen_principal: "https://img.test/1.svg",
  producto_especificaciones: [
    { id: 1, producto_id: 7, icono: "Zap", texto: "Carga USB-C", orden: 1, activo: true },
    { id: 2, producto_id: 7, icono: "Shield", texto: "Resistente al viento", orden: 2, activo: true },
  ],
  producto_variantes: [],
}

const ENTRY = `
import { createElement as h, useState } from "react"
import { createRoot } from "react-dom/client"
import { ProductPageLayout } from "@/components/products/product-page-layout"
import { ProductDetailsModalCard } from "@/components/products/product-details-modal"

const product = ${JSON.stringify(PRODUCT)}
const images = product.imagenes_producto.map((image) => image.url)
const noop = () => {}

function Modal() {
  const [selected, setSelected] = useState(0)
  return h("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4 py-5" },
    h(ProductDetailsModalCard, {
      product, images, selectedImage: selected, selectedColor: "",
      onClose: noop, onNext: () => setSelected((i) => (i + 1) % images.length), onPrev: () => setSelected((i) => (i === 0 ? images.length - 1 : i - 1)),
      onSelectImage: setSelected, onColorChange: noop, onAddToCart: noop, onDecreaseCart: noop, onRemoveFromCart: noop, onViewCart: noop,
    }))
}

createRoot(document.getElementById("root")).render(window.__VIEW === "modal" ? h(Modal) : h(ProductPageLayout, { producto: product }))
`

const IMAGE_SVG = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#e5e7eb"/><text x="200" y="220" font-size="120" text-anchor="middle">${label}</text></svg>`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "product-mobile-fixture.tsx" },
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

async function open(view: "pdp" | "modal", theme: "light" | "dark", width: number, height = 844): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: true })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.origin === "https://img.test") return route.fulfill({ contentType: "image/svg+xml", body: IMAGE_SVG(url.pathname.replace(/\D/g, "")) })
    return route.abort()
  })
  await page.setContent(`<!doctype html><html lang="es" data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page" style="margin:0"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}};window.__VIEW=${JSON.stringify(view)}</script><script>${bundle}</script></body></html>`)
  try { await page.waitForSelector("[data-gallery-stage]", { timeout: 10_000 }) }
  catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return page
}

/** Swipe horizontal real (TouchEvent) sobre la imagen. */
async function swipe(page: Page, deltaX: number, deltaY = 0) {
  // Como string: tsx renombra funciones con nombre (__name) y el navegador no lo tiene.
  await page.evaluate(`(() => {
    const stage = document.querySelector("[data-gallery-stage]")
    const rect = stage.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const touch = (clientX, clientY) => new Touch({ identifier: 1, target: stage, clientX, clientY })
    stage.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch(x, y)], changedTouches: [touch(x, y)] }))
    stage.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [touch(x + ${deltaX}, y + ${deltaY})] }))
  })()`)
}

const mobileIndex = (page: Page) => page.locator("[data-gallery-index-mobile]").innerText()

async function metrics(page: Page) {
  return (await page.evaluate(`(() => {
    const box = (selector) => { const element = document.querySelector(selector); if (!element) return null; const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width, fontSize: parseFloat(style.fontSize), visible: rect.width > 0 && rect.height > 0 && style.display !== "none" } }
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      stage: box("[data-gallery-stage]"),
      stock: box("[data-stock-badge]"),
      thumbnails: box("[data-gallery-thumbnails]"),
      indexRow: box("[data-gallery-index]"),
      indexMobile: box("[data-gallery-index-mobile]"),
      category: box("[data-product-category]"),
      title: box("[data-product-title]"),
      price: box("[data-product-price]"),
      discount: box("[data-product-discount]"),
      originalPrice: box("[data-product-original-price]"),
    }
  })()`)) as Record<string, { top: number; bottom: number; height: number; width: number; fontSize: number; visible: boolean } | null> & { overflow: number }
}

for (const view of ["pdp", "modal"] as const) {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [320, 360, 390, 412, 430]) {
      test(`producto ${view} ${theme} ${width}px: compacto, sin miniaturas, flechas + swipe + indicador`, async () => {
        const page = await open(view, theme, width)
        try {
          const layout = await metrics(page)
          assert.ok(layout.overflow <= 0, `scroll horizontal: ${layout.overflow}px`)
          assert.equal(layout.thumbnails?.visible, false, "miniaturas ocultas en mobile")
          assert.equal(layout.indexRow?.visible, false, "sin fila propia para el indicador")
          assert.equal(layout.indexMobile?.visible, true)
          assert.ok(layout.indexMobile!.height <= 24, "indicador discreto")
          assert.equal(await mobileIndex(page), "1 / 3")

          // Imagen grande pero no una pantalla entera; stock compacto.
          assert.ok(layout.stage!.height <= width * 0.85, `imagen ${layout.stage!.height}px`)
          assert.ok(layout.stock!.height <= 26 && layout.stock!.fontSize <= 12.5, `stock ${JSON.stringify(layout.stock)}`)

          // Tipografías proporcionadas (no chicas).
          assert.ok(layout.title!.fontSize >= 18 && layout.title!.fontSize <= 24, `título ${layout.title!.fontSize}px`)
          assert.ok(layout.title!.height <= layout.title!.fontSize * 1.4 * 3 + 1, "título en 3 líneas como máximo")
          assert.ok(layout.price!.fontSize >= 22 && layout.price!.fontSize <= 24, `precio ${layout.price!.fontSize}px`)
          assert.ok(layout.category!.height <= 24, `categoría ${layout.category!.height}px`)
          assert.ok(layout.discount!.visible && layout.originalPrice!.visible, "descuento y precio anterior siguen visibles")

          if (view === "pdp") {
            // Imagen + título + precio dentro de la primera pantalla.
            assert.ok(layout.price!.bottom <= 844, `precio visible sin scroll (${Math.round(layout.price!.bottom)}px)`)
          }

          // Flechas.
          await page.locator('button[aria-label="Imagen siguiente"]').click()
          assert.equal(await mobileIndex(page), "2 / 3")
          await page.locator('button[aria-label="Imagen anterior"]').click()
          assert.equal(await mobileIndex(page), "1 / 3")
          const arrow = await page.locator('button[aria-label="Imagen siguiente"]').boundingBox()
          assert.ok(arrow && arrow.width >= 36 && arrow.height >= 36, "flecha cómoda de tocar")

          // Swipe: izquierda = siguiente, derecha = anterior; vertical o corto no cambia.
          await swipe(page, -90)
          assert.equal(await mobileIndex(page), "2 / 3")
          await swipe(page, -90)
          assert.equal(await mobileIndex(page), "3 / 3")
          await swipe(page, 90)
          assert.equal(await mobileIndex(page), "2 / 3")
          await swipe(page, -20)
          assert.equal(await mobileIndex(page), "2 / 3", "un toque corto no cambia de imagen")
          await swipe(page, -60, 140)
          assert.equal(await mobileIndex(page), "2 / 3", "un scroll vertical no cambia de imagen")

          if (SHOTS) await page.screenshot({ path: `${SHOTS}/product-${view}-${theme}-${width}.png`, fullPage: view === "pdp" })
        } finally { await page.close() }
      })
    }

    for (const width of [768, 1280]) {
      test(`producto ${view} ${theme} ${width}px: miniaturas e indicador como antes`, async () => {
        const page = await open(view, theme, width)
        try {
          const layout = await metrics(page)
          assert.ok(layout.overflow <= 0, `scroll horizontal: ${layout.overflow}px`)
          assert.equal(layout.thumbnails?.visible, true, "miniaturas visibles")
          assert.equal(layout.indexRow?.visible, true)
          assert.equal(layout.indexMobile?.visible, false)
          assert.equal(layout.title!.fontSize, width >= 768 ? 34 : 28, "título desktop/tablet sin cambios")
          assert.equal(layout.price!.fontSize, 32)
          assert.ok(Math.abs(layout.stage!.height - layout.stage!.width) <= 1, "imagen cuadrada como antes")
          assert.ok(layout.stock!.fontSize >= 13, "badge de stock desktop sin cambios")
          await page.locator('[data-media-index="1"]').click()
          assert.match(await page.locator("[data-gallery-index]").innerText(), /2 \/ 3/)
          if (SHOTS) await page.screenshot({ path: `${SHOTS}/product-${view}-${theme}-${width}.png` })
        } finally { await page.close() }
      })
    }
  }
}
