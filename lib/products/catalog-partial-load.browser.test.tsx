import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Catálogo REAL (ProductsPageLayout + useCatalogFilters + CSS del proyecto)
// con la carga completa simulada: si falla y ya hay productos del servidor, se
// mantienen visibles con un aviso + Reintentar; con filtros sin coincidencias
// sobre un catálogo incompleto no se afirma "sin resultados"; un reintento
// exitoso quita el aviso y no duplica productos.

const stubs: Plugin = {
  name: "catalog-partial-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/lib/supabase/queries/store": `
        export async function getStoreProductos() {
          window.__loadCalls = (window.__loadCalls ?? 0) + 1
          const outcome = (window.__plan ?? []).shift() ?? "ok"
          if (outcome === "fail") throw new Error("PGRST116 connection refused")
          return window.__fullProducts
        }
        export async function getStoreCategorias() { return [] }`,
      "@/context/cart-context": `const noop = () => {}
        export function useCart() { return { addToCart: noop, removeFromCart: noop, decreaseQuantity: noop, getQuantity: () => 0, isInCart: () => false, openCart: noop } }`,
      "@/components/category/use-product-details": `const noop = () => {}
        export function useProductDetails() { return { isOpen: false, product: null, images: [], selectedImage: 0, selectedColor: "", openDetails: noop, closeDetails: noop, nextImage: noop, prevImage: noop, changeColor: noop, setSelectedImage: noop } }`,
      "@/components/global-search-bar": `export function GlobalSearchBar() { return null }`,
      "@/components/products/product-details-modal": `export function ProductDetailsModal() { return null }`,
      "@/components/products/shared/shared-product-card": `import { createElement } from "react"
        export default function SharedProductCard({ product }) { return createElement("article", { "data-product-card": product.id }, product.nombre) }`,
      "next/navigation": `export function useSearchParams() { return new URLSearchParams(location.search) }
        export function useRouter() { return { push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} } }
        export function usePathname() { return location.pathname }`,
      "next/link": `import { createElement } from "react"; export default function Link(props) { return createElement("a", { href: props.href, className: props.className }, props.children) }`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const entry = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { ProductsPageLayout } from "@/components/products/products-page-layout"

const product = (id, nombre) => ({ id, nombre, precio: 10000 + id, activo: true, stock: 5, imagenes: [], producto_variantes: [], categorias: null })
const params = new URLSearchParams(location.search)
window.__plan = (params.get("plan") ?? "ok").split(",")
window.__fullProducts = [product(1, "Auriculares"), product(2, "Cargador"), product(3, "Mouse"), product(4, "Zzz Lámpara")]
window.fetch = async () => Response.json({ banners: [] })
const initialCategories = []
createRoot(document.getElementById("root")).render(
  createElement(ProductsPageLayout, { initialProducts: window.__fullProducts.slice(0, 2), initialCategories }),
)
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  bundle = (await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "catalog-partial-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs], alias: { "@": process.cwd() },
    banner: { js: "var process = { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://x.invalid"', "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"k"' },
    logLevel: "error",
  })).outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(theme: "light" | "dark", width: number, query: string) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const html = `<!doctype html><html data-account-theme="${theme}" data-account-scope="tienda"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`
  await page.route("**/*", (route) => route.request().url().startsWith("http://localhost/") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort())
  await page.goto(`http://localhost/productos?${query}`)
  return { page, errors }
}

const cards = (page: Page) => page.locator("[data-product-card]")
const notice = (page: Page) => page.getByText("No pudimos cargar todos los productos.")

for (const theme of ["dark", "light"] as const) {
  for (const width of [390, 430, 768]) {
    test(`${theme} ${width}px: carga parcial mantiene los productos, avisa y Reintentar lo resuelve sin duplicar`, async () => {
      const { page, errors } = await open(theme, width, "plan=fail,ok")
      try {
        await notice(page).waitFor()
        assert.equal(await cards(page).count(), 2)

        const retry = page.locator(".beyonix-catalog-partial-notice").getByRole("button", { name: "Reintentar" })
        const box = await retry.boundingBox()
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 0.5, "Reintentar fuera del viewport")
        const noticeBox = await page.locator(".beyonix-catalog-partial-notice").boundingBox()
        assert.ok(noticeBox && noticeBox.x + noticeBox.width <= width + 0.5, "el aviso se sale del viewport")
        assert.equal(await page.locator(".beyonix-catalog-partial-notice").evaluate((node) => node.scrollWidth > node.clientWidth + 1), false, "texto del aviso cortado")
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "hay scroll horizontal")

        await retry.click()
        await page.waitForFunction(() => document.querySelectorAll("[data-product-card]").length === 4)
        assert.equal(await notice(page).count(), 0)
        assert.equal(await page.evaluate(() => (window as unknown as { __loadCalls: number }).__loadCalls), 2)
        assert.deepEqual(errors, [])
      } finally {
        await page.close()
      }
    })
  }
}

test("catálogo incompleto + filtros sin coincidencias: \"No pudimos completar la búsqueda.\", no \"sin resultados\"", async () => {
  const { page, errors } = await open("dark", 390, "plan=fail,ok&search=zzz")
  try {
    await page.getByText("No pudimos completar la búsqueda.").waitFor()
    assert.equal(await page.getByText("No encontramos productos con esos filtros.").count(), 0)
    assert.equal(await notice(page).count(), 0)

    // El producto que coincide estaba fuera de la primera página: el reintento lo trae.
    await page.getByRole("button", { name: "Reintentar" }).click()
    await page.waitForFunction(() => document.querySelectorAll("[data-product-card]").length === 1)
    assert.equal(await cards(page).first().textContent(), "Zzz Lámpara")
    assert.equal(await page.getByText("No pudimos completar la búsqueda.").count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("catálogo completo + 0 coincidencias sigue mostrando el mensaje normal con Limpiar filtros", async () => {
  const { page, errors } = await open("light", 390, "plan=ok&search=inexistente")
  try {
    await page.getByText("No encontramos productos con esos filtros.").waitFor()
    assert.equal(await page.getByText("No pudimos completar la búsqueda.").count(), 0)
    assert.equal(await notice(page).count(), 0)

    await page.getByRole("button", { name: "Limpiar filtros" }).last().click()
    await page.waitForFunction(() => document.querySelectorAll("[data-product-card]").length === 4)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("carga completa exitosa: sin aviso y con todo el catálogo", async () => {
  const { page, errors } = await open("dark", 768, "plan=ok")
  try {
    await page.waitForFunction(() => document.querySelectorAll("[data-product-card]").length === 4)
    assert.equal(await notice(page).count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
