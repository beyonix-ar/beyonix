import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { deflateSync } from "node:zlib"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Layout real de Productos y Categorías, con el CSS del proyecto.

const SHOTS = process.env.BANNER_LAYOUT_SHOTS

const stubs: Plugin = {
  name: "banner-layout-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/cart-context": `export function useCart() { return { cart: [], addToCart() {}, decreaseQuantity() {}, removeFromCart() {}, getQuantity() { return 0 }, isInCart() { return false }, openCart() {} } }`,
      "@/context/auth-context": `export function useAuth() { return { user: null, isLoading: false, isInternal: false } }`,
      "@/lib/supabase/client": `
        const channel = { on() { return channel }, subscribe() { return channel } }
        const query = { select() { return query }, eq() { return query }, in() { return query }, order() { return query }, then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve) } }
        export const supabase = { from: () => query, auth: { getSession: async () => ({ data: { session: null } }) }, channel: () => channel, removeChannel: async () => "ok" }
        export async function getSafeSupabaseSession() { return null }`,
      "@/lib/supabase/queries/store": `
        export async function getStoreProductos() { return window.__TEST_PRODUCTS || [] }
        export async function getStoreCategorias() { return window.__TEST_CATEGORIES || [] }`,
      "@/components/products/shared/shared-product-card": `
        import { createElement } from "react"
        export default function SharedProductCard({ product }) { return createElement("article", { "data-product-id": product.id }, product.nombre) }`,
      "next/navigation": `
        export function useRouter() { return { push() {}, replace() {}, prefetch() {} } }
        export function usePathname() { return "/categorias/test" }
        export function useSearchParams() { return new URLSearchParams(window.location.search) }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, prefetch, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref }) })`,
      "next/image": `import { createElement } from "react"; export default function Image({ src, alt, fill, priority, sizes, ...props }) { return createElement("img", { ...props, src: String(src), alt }) }`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const ENTRY = `
import { createElement as h } from "react"
import { createRoot } from "react-dom/client"
import { CategoryPageLayout } from "@/components/category/layout/category-page-layout"
import { ProductsPageLayout } from "@/components/products/products-page-layout"
createRoot(document.getElementById("root")).render(window.__PAGE === "products"
  ? h(ProductsPageLayout, { initialProducts: window.__TEST_PRODUCTS || [], initialCategories: window.__TEST_CATEGORIES || [] })
  : h(CategoryPageLayout, {
      title: window.__TITLE, description: "", currentSlug: window.__SLUG || "test", products: window.__TEST_PRODUCTS || [], categories: window.__TEST_CATEGORIES || [],
      image: window.__BANNER ? "https://img.test/banner.png" : null,
    }))
`

// Arte de prueba con la proporción recomendada para ambos banners (48:13).
function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
function makePng(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([20, 60, 120], y * (width * 3 + 1) + 1 + x * 3)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}
const BANNER_PNG = makePng(480, 130)

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "banner-layout-fixture.tsx" },
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

async function open(width: number, height: number, withBanner: boolean, theme: "light" | "dark" = "dark", kind: "category" | "products" = "category", title = "Accesorios y utilidades", fixture?: { products: unknown[]; categories: unknown[]; slug: string; url?: string }): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => (route.request().url() === "https://img.test/banner.png"
    ? route.fulfill({ contentType: "image/png", body: BANNER_PNG })
    : route.abort()))
  const markup = `<!doctype html><html lang="es" data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}};window.__BANNER=${withBanner};window.__PAGE=${JSON.stringify(kind)};window.__TITLE=${JSON.stringify(title)};window.__TEST_PRODUCTS=${JSON.stringify(fixture?.products ?? [])};window.__TEST_CATEGORIES=${JSON.stringify(fixture?.categories ?? [])};window.__SLUG=${JSON.stringify(fixture?.slug ?? "test")};const originalFetch=window.fetch;window.fetch=(url,...args)=>String(url).includes('/api/store/banners')?Promise.resolve({json:async()=>({banners:${withBanner ? '[{id:"test",image_url:"https://img.test/banner.png",alt_text:"Banner de productos"}]' : '[]'}})}):originalFetch(url,...args)</script><script>${bundle}</script></body></html>`
  if (fixture?.url) {
    await page.route("https://catalog.test/**", (route) => route.fulfill({ contentType: "text/html", body: markup }))
    await page.goto(fixture.url)
  } else {
    await page.setContent(markup)
  }
  try {
    await page.waitForSelector(".beyonix-hero-banner", { timeout: 10_000 })
    if (withBanner) await page.waitForFunction(() => { const image = document.querySelector("[data-banner-media] img") as HTMLImageElement | null; return Boolean(image?.complete && image.naturalWidth) })
  } catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return page
}

type BannerMetrics = { banner: number; bannerHeight: number; media: number; mediaHeight: number; fit: string; paintedFill: number; overflow: number; searchTop: number; benefitsTop: number; searchInside: boolean; benefitsInside: boolean }

async function metrics(page: Page) {
  return (await page.evaluate(`(() => {
    const banner = document.querySelector(".beyonix-hero-banner").getBoundingClientRect()
    const image = document.querySelector("[data-banner-media] img")
    const box = image.getBoundingClientRect()
    const style = getComputedStyle(image)
    const ratio = image.naturalWidth / image.naturalHeight
    const painted = style.objectFit === "contain" ? Math.min(box.width, box.height * ratio) : box.width
    const search = document.querySelector(".global-search-wrapper").getBoundingClientRect()
    const benefits = document.querySelector(".beyonix-benefit-item").parentElement.getBoundingClientRect()
    return {
      banner: banner.width, bannerHeight: banner.height,
      media: document.querySelector("[data-banner-media]").getBoundingClientRect().width, mediaHeight: box.height,
      fit: style.objectFit, paintedFill: painted / banner.width,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      searchTop: search.top - banner.top, benefitsTop: benefits.top - banner.top,
      searchInside: search.top >= banner.top && search.bottom <= banner.bottom,
      benefitsInside: benefits.top >= banner.top && benefits.bottom <= banner.bottom,
    }
  })()`)) as BannerMetrics
}

const VIEWPORTS: [number, number][] = [[390, 844], [768, 1024], [1024, 768], [1366, 768], [1440, 900], [1920, 1080]]

for (const theme of ["dark", "light"] as const) {
  for (const [width, height] of VIEWPORTS) {
    test(`Productos y Categorías comparten banner ${theme} ${width}x${height}`, async () => {
      const category = await open(width, height, true, theme)
      const products = await open(width, height, true, theme, "products")
      try {
        const [c, p] = await Promise.all([metrics(category), metrics(products)])
        for (const m of [c, p]) {
          assert.ok(m.overflow <= 0, `scroll horizontal ${m.overflow}px`)
          assert.ok(Math.abs(m.media - m.banner) <= 3)
          assert.ok(m.paintedFill >= 0.98, "la imagen recomendada llena el ancho")
          assert.ok(m.searchInside && m.benefitsInside, "buscador y beneficios dentro del banner")
          assert.equal(m.fit, "cover")
        }
        for (const key of ["banner", "bannerHeight", "media", "mediaHeight", "searchTop", "benefitsTop"] as const) {
          assert.ok(Math.abs(c[key] - p[key]) <= 2, `${key}: Categoría ${c[key]}, Productos ${p[key]}`)
        }
        const labels = await category.locator(".beyonix-benefit-item").allTextContents()
        assert.ok(labels.some((label) => label.includes("Pagos seguros")))
        assert.ok(labels.some((label) => label.includes("Garantía de 6 meses")))
        if (SHOTS) {
          await category.screenshot({ path: `${SHOTS}/category-banner-${theme}-${width}x${height}.png` })
          await products.screenshot({ path: `${SHOTS}/products-banner-${theme}-${width}x${height}.png` })
        }
      } finally { await category.close(); await products.close() }
    })
  }
}

test("las tres categorías usan el mismo banner", async () => {
  for (const title of ["Accesorios y utilidades", "Hogar & Bazar", "Tecnología & Gadgets"]) {
    const page = await open(390, 844, true, "dark", "category", title)
    try {
      assert.equal(await page.locator("[data-banner-media] img").getAttribute("alt"), title)
      const m = await metrics(page)
      assert.ok(m.searchInside && m.benefitsInside)
      assert.equal(m.overflow, 0)
    } finally { await page.close() }
  }
})

test("sin banner: no se reserva un recuadro vacío", async () => {
  for (const [width, height] of [[390, 844], [1366, 657], [1920, 1080]] as const) {
    const page = await open(width, height, false)
    try {
      const layout = await page.evaluate(() => {
        const banner = document.querySelector(".beyonix-hero-banner")!.getBoundingClientRect()
        const search = document.querySelector(".global-search-wrapper")!.getBoundingClientRect()
        return { media: document.querySelectorAll("[data-banner-media]").length, gapAboveSearch: search.top - banner.top }
      })
      assert.equal(layout.media, 0)
      assert.ok(layout.gapAboveSearch <= 90, `${width}: el buscador arranca arriba, sólo con el padding normal (${Math.round(layout.gapAboveSearch)}px)`)
    } finally { await page.close() }
  }
})

const filterFixture = {
  slug: "tecnologia",
  categories: [
    { id: 1, slug: "tecnologia", nombre: "Tecnología & Gadgets" },
    { id: 2, slug: "hogar", nombre: "Hogar & Bazar" },
    { id: 3, slug: "accesorios", nombre: "Accesorios y utilidades" },
  ],
  products: [
    { id: 1, nombre: "Lámpara negra", slug: "lampara", precio: 100, precio_anterior: null, destacado: false, modo_color: "especifico", categorias: { slug: "tecnologia" }, producto_variantes: [{ id: 11, nombre: "NEGRO", color_hex: "#000000", activo: true, orden: 0, stock: 2, imagenes: [] }] },
    { id: 2, nombre: "Vaso bicolor", slug: "vaso", precio: 200, precio_anterior: 250, destacado: false, modo_color: "especifico", categorias: { slug: "hogar" }, producto_variantes: [{ id: 21, nombre: "AZUL / ROSA", color_hex: "#2563EB", color_hex_secundario: "#EC4899", activo: true, orden: 0, stock: 2, imagenes: [] }] },
    { id: 3, nombre: "Encendedor aleatorio", slug: "encendedor", precio: 300, precio_anterior: null, destacado: false, modo_color: "aleatorio_variantes", categorias: { slug: "accesorios" }, producto_variantes: [{ id: 31, nombre: "ROJO", color_hex: "#EF4444", activo: true, orden: 0, stock: 2, imagenes: [] }, { id: 32, nombre: "NEGRO", color_hex: "#000000", activo: true, orden: 1, stock: 2, imagenes: [] }] },
  ],
}

for (const width of [390, 768, 1024, 1366, 1440, 1920]) {
  test(`filtros completos y sin desborde en Productos y Categorías a ${width}px`, async () => {
    for (const kind of ["products", "category"] as const) {
      const page = await open(width, 900, false, "dark", kind, "Tecnología & Gadgets", filterFixture)
      try {
        if (width < 1024) await page.getByRole("button", { name: "Mostrar u ocultar filtros" }).click()
        assert.equal(await page.getByText("Categorías", { exact: true }).count(), 1)
        assert.equal(await page.getByText("Colores", { exact: true }).count(), 1)
        assert.equal(await page.getByRole("button", { name: "Filtrar por Multicolor" }).count(), 1)
        assert.equal(await page.getByRole("button", { name: "Filtrar por Aleatorio" }).count(), 1)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0)
        if (kind === "category") {
          assert.equal(await page.getByRole("checkbox", { name: "Tecnología & Gadgets" }).isChecked(), true)
          await page.getByRole("checkbox", { name: "Hogar & Bazar" }).check()
          assert.equal(await page.locator("[data-product-id]").count(), 2)
          await page.getByRole("button", { name: "Filtrar por Multicolor" }).click()
          assert.deepEqual(await page.locator("[data-product-id]").evaluateAll((items) => items.map((item) => item.getAttribute("data-product-id"))), ["2"])
          await page.getByRole("button", { name: "Limpiar filtros" }).click()
          assert.equal(await page.locator("[data-product-id]").count(), 3)
        }
      } finally { await page.close() }
    }
  })
}

test("URL de Categorías conserva filtros al recargar, volver y avanzar", async () => {
  const page = await open(1440, 900, false, "dark", "category", "Tecnología & Gadgets", {
    ...filterFixture, url: "https://catalog.test/categorias/tecnologia?color=multicolor",
  })
  try {
    assert.equal(await page.locator("[data-product-id]").count(), 0)
    await page.getByRole("checkbox", { name: "Hogar & Bazar" }).evaluate((node: HTMLInputElement) => node.click())
    await page.waitForFunction(() => document.querySelectorAll("[data-product-id]").length === 1)
    assert.equal(await page.locator("[data-product-id]").count(), 1)
    assert.ok(page.url().includes("category=hogar"))
    await page.reload()
    await page.waitForFunction(() => document.querySelectorAll("[data-product-id]").length === 1)
    assert.equal(await page.locator("[data-product-id]").count(), 1)
    await page.goBack()
    const backState = await page.evaluate(() => ({ url: location.href, count: document.querySelectorAll("[data-product-id]").length, checks: [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((input) => input.checked) }))
    assert.equal(backState.count, 0, JSON.stringify(backState))
    assert.equal(await page.locator("[data-product-id]").count(), 0)
    await page.goForward()
    await page.waitForFunction(() => document.querySelectorAll("[data-product-id]").length === 1)
    assert.equal(await page.locator("[data-product-id]").count(), 1)
    await page.getByRole("button", { name: "Limpiar filtros" }).evaluate((node: HTMLButtonElement) => node.click())
    await page.waitForFunction(() => document.querySelectorAll("[data-product-id]").length === 3)
    assert.equal(await page.locator("[data-product-id]").count(), 3)
    await page.reload()
    await page.waitForFunction(() => document.querySelectorAll("[data-product-id]").length === 3)
    assert.equal(await page.locator("[data-product-id]").count(), 3)
  } finally { await page.close() }
})
