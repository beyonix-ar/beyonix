import assert from "node:assert/strict"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core"

// product_view en la tienda con la PDP y el modal de vista rápida REALES y el
// tracking real (sesión, deduplicación y envío). Stubs sólo de
// infraestructura (carrito, imagen y router de Next). El sitio se sirve desde
// un origen HTTP simulado para que localStorage y el fetch relativo se
// comporten como en producción.

const ORIGIN = "http://tienda.test"
const ENDPOINT = `${ORIGIN}/api/analytics/product-view`

const stubs: Plugin = {
  name: "product-view-tracking-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/cart-context": `export function useCart() { return { addToCart() {}, decreaseQuantity() {}, removeFromCart() {}, getQuantity() { return 0 }, isInCart() { return false }, openCart() {} } }`,
      "next/image": `import { createElement } from "react"; export default function Image({ src, alt, fill, priority, sizes, onLoad, ...props }) { return createElement("img", { ...props, src: String(src), alt, onLoad }) }`,
      "next/navigation": `export function useRouter() { return { push() {}, replace() {}, prefetch() {} } } export function usePathname() { return "/productos/encendedor" }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, prefetch, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref }) })`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const product = (id: number, nombre: string) => ({
  id, nombre, slug: `producto-${id}`, precio: 10_000, precio_anterior: null, descuento: 0, stock: 5, sku: `SKU${id}`, activo: true,
  descripcion: "<p>Descripción.</p>", video_url: null, categorias: { nombre: "Accesorios" },
  imagenes_producto: [{ url: `${ORIGIN}/img/${id}.svg` }], imagen_principal: `${ORIGIN}/img/${id}.svg`,
  producto_especificaciones: [], producto_variantes: [],
})

const ENTRY = `
import { createElement as h } from "react"
import { createRoot } from "react-dom/client"
import { ProductPageLayout } from "@/components/products/product-page-layout"
import { ProductDetailsModal } from "@/components/products/product-details-modal"

const products = { 7: ${JSON.stringify(product(7, "Encendedor USB"))}, 8: ${JSON.stringify(product(8, "Pava 12V"))} }
const params = new URLSearchParams(location.search)
const item = products[Number(params.get("id") ?? 7)]
const noop = () => {}
const view = params.get("view") ?? "pdp"

createRoot(document.getElementById("root")).render(view === "pdp"
  ? h(ProductPageLayout, { producto: item })
  : h(ProductDetailsModal, {
      open: true, product: item, images: item.imagenes_producto.map((image) => image.url), selectedImage: 0, selectedColor: "",
      measureViews: view !== "admin-preview",
      onClose: noop, onNext: noop, onPrev: noop, onSelectImage: noop, onColorChange: noop, onAddToCart: noop,
      onDecreaseCart: noop, onRemoveFromCart: noop, onViewCart: noop,
    }))
`

let browser: Browser
let bundle: string

test.before(async () => {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "product-view-tracking-fixture.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    alias: { "@": process.cwd() },
    // Sin URL/clave de Supabase: el cliente de auth no puede inicializarse
    // (equivale a un fallo de auth) y la vista debe enviarse igual, anónima.
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

type Beacon = { body: Record<string, unknown>; headers: Record<string, string> }
type EndpointMode = "ok" | "error" | "network-error" | "hang"

async function serve(context: BrowserContext, beacons: Beacon[], mode: EndpointMode = "ok") {
  await context.route("**/*", async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.href === ENDPOINT) {
      beacons.push({ body: JSON.parse(request.postData() ?? "null"), headers: request.headers() })
      if (mode === "hang") return
      if (mode === "network-error") return route.abort("failed")
      return route.fulfill({ status: mode === "error" ? 500 : 204, body: mode === "error" ? "boom" : "" })
    }
    if (url.pathname === "/api/reviews") return route.fulfill({ json: { reviews: [] } })
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 404, json: { error: "No disponible en el fixture." } })
    if (url.pathname.startsWith("/img/")) {
      return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ddd"/></svg>` })
    }
    if (url.origin === ORIGIN) {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="es"><head><meta charset="utf-8"></head><body><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script>${bundle}</script></body></html>`,
      })
    }
    return route.abort()
  })
}

async function visit(page: Page, query: string) {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${ORIGIN}/productos/x?${query}`)
  await page.locator("[data-product-title]").first().waitFor({ timeout: 10_000 })
  return errors
}

const waitForBeacons = async (beacons: Beacon[], count: number) => {
  const deadline = Date.now() + 5_000
  while (beacons.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
}

/** Espera el tiempo en que el tracking ya habría disparado (idle ≤ 2 s). */
const settle = (page: Page) => page.waitForTimeout(2_300)

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test("PDP: visitar registra una product_view; refresh no duplica; otro producto y otra sesión sí cuentan", async () => {
  const context = await browser.newContext()
  const beacons: Beacon[] = []
  try {
    await serve(context, beacons)
    const page = await context.newPage()
    assert.deepEqual(await visit(page, "id=7"), [])
    await waitForBeacons(beacons, 1)
    assert.equal(beacons.length, 1)
    const [first] = beacons
    assert.equal(first.body.productId, 7)
    assert.equal(first.body.source, "product_page")
    assert.match(String(first.body.sessionId), UUID_V4)
    assert.deepEqual(Object.keys(first.body).sort(), ["productId", "sessionId", "source"], "sin datos de usuario en el payload")
    assert.equal(first.headers.authorization, undefined, "sin sesión de auth: vista anónima")

    await page.reload()
    await page.locator("[data-product-title]").first().waitFor()
    await settle(page)
    assert.equal(beacons.length, 1, "refresh inmediato no envía otra vista")

    await visit(page, "id=8")
    await waitForBeacons(beacons, 2)
    assert.equal(beacons.length, 2)
    assert.equal(beacons[1].body.productId, 8)
    assert.equal(beacons[1].body.sessionId, first.body.sessionId, "otro producto, misma sesión")

    const other = await browser.newContext()
    try {
      const otherBeacons: Beacon[] = []
      await serve(other, otherBeacons)
      await visit(await other.newPage(), "id=7")
      await waitForBeacons(otherBeacons, 1)
      assert.equal(otherBeacons.length, 1)
      assert.notEqual(otherBeacons[0].body.sessionId, first.body.sessionId, "otra sesión cuenta otra vista")
    } finally { await other.close() }
  } finally { await context.close() }
})

test("vista rápida: el modal de la tienda registra quick_view; la vista previa del Admin no", async () => {
  const context = await browser.newContext()
  const beacons: Beacon[] = []
  try {
    await serve(context, beacons)
    const page = await context.newPage()
    await visit(page, "id=8&view=quick")
    await waitForBeacons(beacons, 1)
    assert.deepEqual(beacons.map((beacon) => [beacon.body.productId, beacon.body.source]), [[8, "quick_view"]])

    await visit(page, "id=7&view=admin-preview")
    await settle(page)
    assert.equal(beacons.length, 1, "la vista previa del Admin no mide")
  } finally { await context.close() }
})

for (const mode of ["error", "network-error", "hang"] as const) {
  test(`fallo de analítica (${mode}): la PDP carga y funciona igual`, async () => {
    const context = await browser.newContext()
    const beacons: Beacon[] = []
    try {
      await serve(context, beacons, mode)
      const page = await context.newPage()
      const startedAt = Date.now()
      const errors = await visit(page, "id=7")
      assert.ok(Date.now() - startedAt < 8_000)
      await waitForBeacons(beacons, 1)
      await settle(page)
      assert.deepEqual(errors, [], "sin errores no controlados")
      assert.equal(beacons.length, 1)
      assert.equal(await page.locator("[data-product-title]").first().innerText(), "Encendedor USB")
      assert.ok(await page.getByRole("button", { name: "Añadir producto al carrito" }).first().isEnabled(), "la compra sigue disponible")
    } finally { await context.close() }
  })
}
