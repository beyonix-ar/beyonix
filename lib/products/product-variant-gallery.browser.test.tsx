import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

// Modal de producto real (el mismo de la tienda) abierto desde la vista previa
// de Admin, con el caso MALIBU: NEGRO / ROSA / VERDE con fotos propias. Cada
// color muestra sólo su galería y el carrito recibe la variante exacta.

const IMAGES = {
  NEGRO: ["https://example.com/malibu-negro-1.png", "https://example.com/malibu-negro-2.png"],
  ROSA: ["https://example.com/malibu-rosa-1.png", "https://example.com/malibu-rosa-2.png"],
  VERDE: ["https://example.com/malibu-verde-1.png", "https://example.com/malibu-verde-2.png"],
} as const

function malibu(active: boolean, modoColor = "especifico") {
  const variant = (id: number, nombre: keyof typeof IMAGES, sku: string, color: string, stock: number) => ({
    id, producto_id: 9, nombre, sku, color_hex: color, stock, imagenes: IMAGES[nombre], activo: active, orden: 1, created_at: "2026-10-25T00:00:00.000Z",
  })
  return {
    id: 9, nombre: "AURICULAR INALAMBRICO MALIBU", slug: "malibu", descripcion: "<p>Sonido envolvente</p>", precio: 20000,
    precio_anterior: null, descuento: null, stock: 12, categoria_id: 1, activo: active, destacado: false,
    imagen_principal: IMAGES.NEGRO[0], video_url: null, sku: null, created_at: "2026-10-09T00:00:00.000Z",
    modo_color: modoColor, imagenes_producto: [], conditioned_stock: [], producto_especificaciones: [],
    producto_variantes: [
      variant(9, "NEGRO", "AUMN01", "#000000", 6),
      variant(15, "ROSA", "AUMR01", "#ECA2A2", 3),
      variant(16, "VERDE", "AUMV01", "#7FB77E", 3),
    ],
  }
}

const stubs: Plugin = {
  name: "variant-gallery-fixture",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /context\/cart-context$/ }, () => ({ path: "cart-context", namespace: "fixture" }))
    pluginBuild.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
      contents: `export function useCart() {
        return {
          addToCart: (product, color) => { window.cartAdds = [...(window.cartAdds || []), { productId: product.id, color }] },
          decreaseQuantity: () => {}, removeFromCart: () => {}, getQuantity: () => 0, isInCart: () => false, openCart: () => {},
        }
      }`,
      loader: "tsx", resolveDir: process.cwd(),
    }))
  },
}

let browser: Browser
let bundle: string
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  bundle = (await build({
    stdin: {
      contents: `import React from "react"; import { createRoot } from "react-dom/client"; import { AdminProductPreviewModal } from "./app/admin/sections/productos/admin-product-preview-modal.tsx";
        createRoot(document.getElementById("root")).render(<AdminProductPreviewModal product={window.fixtureProduct} onClose={() => {}} />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "variant-gallery-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function openPreview(product: ReturnType<typeof malibu>, width = 1440, theme: "dark" | "light" = "dark") {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const html = `<!doctype html><html lang="es" data-admin-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0;background:#000"><div id="root"></div><script>window.process = { env: { NODE_ENV: "production" } }; window.fixtureProduct = ${JSON.stringify(product)};</script><script>${bundle}</script></body></html>`
  await page.route("http://beyonix.test/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/admin/productos") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>` })
  })
  await page.goto("http://beyonix.test/admin/productos")
  await page.getByRole("button", { name: /Ampliar imagen de/ }).waitFor()
  return page
}

/** URLs originales de la galería activa (principal, miniaturas y precarga), sin el selector de color. */
const galleryImages = (page: Page) => page.evaluate(() => {
  const urls = Array.from(document.querySelectorAll("img"))
    .filter((img) => !img.closest('button[aria-label^="Seleccionar color"]'))
    .map((img) => {
      const src = img.getAttribute("src") ?? ""
      const match = src.match(/[?&]url=([^&]+)/)
      return match ? decodeURIComponent(match[1]) : src
    })
  return [...new Set(urls)].filter((url) => url.startsWith("https://example.com/")).sort()
})

const colorButtons = (page: Page) => page.getByRole("button", { name: /^Seleccionar color / })
const colorButton = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^Seleccionar color ${name}$`, "i") })

test("MALIBU (color específico) ofrece NEGRO/ROSA/VERDE y cada uno muestra sólo su galería", async () => {
  const page = await openPreview(malibu(true))
  try {
    assert.deepEqual(await colorButtons(page).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))), [
      "Seleccionar color Negro", "Seleccionar color Rosa", "Seleccionar color Verde",
    ].map((label) => label), "tres opciones de color")
    assert.deepEqual(await galleryImages(page), [...IMAGES.NEGRO].sort(), "NEGRO por defecto, sin fotos de otros colores")

    for (const name of ["ROSA", "VERDE", "NEGRO"] as const) {
      await colorButton(page, name).click()
      await page.waitForFunction((expected) => {
        const main = document.querySelector('button[aria-label^="Ampliar imagen de"] img')?.getAttribute("src") ?? ""
        return decodeURIComponent(main).includes(expected)
      }, IMAGES[name][0])
      assert.deepEqual(await galleryImages(page), [...IMAGES[name]].sort(), `${name} muestra sólo sus imágenes`)
      assert.equal(await colorButton(page, name).getAttribute("aria-pressed"), "true")
    }

    await colorButton(page, "verde").click()
    await page.getByRole("button", { name: "Añadir producto al carrito" }).first().click()
    assert.deepEqual(await page.evaluate(() => (window as unknown as { cartAdds: unknown[] }).cartAdds), [{ productId: 9, color: "variant:16" }], "el carrito recibe la variante VERDE (id 16)")
  } finally { await page.close() }
})

test("con las variantes todavía inactivas la vista previa las separa igual y no permite agregar al carrito", async () => {
  const page = await openPreview(malibu(false))
  try {
    assert.equal(await colorButtons(page).count(), 3)
    await colorButton(page, "rosa").click()
    await page.waitForFunction((expected) => decodeURIComponent(document.querySelector('button[aria-label^="Ampliar imagen de"] img')?.getAttribute("src") ?? "").includes(expected), IMAGES.ROSA[0])
    assert.deepEqual(await galleryImages(page), [...IMAGES.ROSA].sort())
    const addButton = page.getByRole("button", { name: "Añadir producto al carrito" }).first()
    await addButton.click()
    assert.equal(await page.evaluate(() => (window as unknown as { cartAdds?: unknown[] }).cartAdds), undefined, "vista previa de variantes inactivas: sólo lectura")
  } finally { await page.close() }
})

test("aleatorio con variantes físicas conserva una sola opción sin selector de color", async () => {
  const page = await openPreview(malibu(true, "aleatorio_variantes"))
  try {
    assert.equal(await colorButtons(page).count(), 0)
    assert.equal(await page.getByText("Aleatorio según disponibilidad").count() > 0, true)
  } finally { await page.close() }
})

for (const [width, theme] of [[1440, "light"], [390, "dark"], [390, "light"]] as const) {
  test(`selector y galería por variante sin scroll horizontal a ${width}px (${theme})`, async () => {
    const page = await openPreview(malibu(true), width, theme)
    try {
      assert.equal(await colorButtons(page).count(), 3)
      await colorButton(page, "verde").click()
      await page.waitForFunction((expected) => decodeURIComponent(document.querySelector('button[aria-label^="Ampliar imagen de"] img')?.getAttribute("src") ?? "").includes(expected), IMAGES.VERDE[0])
      assert.deepEqual(await galleryImages(page), [...IMAGES.VERDE].sort())
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow a ${width}px`)
    } finally { await page.close() }
  })
}
