import assert from "node:assert/strict"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// add_to_cart, search y checkout_started con el CartProvider, el buscador y
// el tracking REALES, dentro de React.StrictMode (que ejecuta dos veces los
// updaters de estado: un evento disparado ahí se duplicaría). Stubs sólo de
// infraestructura: Supabase sin sesión, router de Next y reservas de stock.

const ORIGIN = "http://tienda.test"

const stubs: Plugin = {
  name: "commerce-tracking-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/lib/supabase/client": `export const supabase = { auth: {
          getSession: async () => ({ data: { session: null } }),
          getUser: async () => ({ data: { user: null } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        } }
        export async function getSafeSupabaseSession() { return null }`,
      "@/lib/supabase/queries/store": `export async function getStoreCartProducts() { return [] }`,
      "@/lib/cart/stock-reservations": `export async function reserveCartStock() { return { ok: true } }`,
      "next/navigation": `export function useRouter() { return { push(url) { window.__pushed = url }, replace() {}, prefetch() {} } } export function usePathname() { return "/productos" }`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const base = { precio: 10_000, precio_anterior: null, descuento: 0, sku: "SKU", activo: true, descripcion: "", video_url: null, categorias: null, imagenes_producto: [], imagen_principal: null, producto_especificaciones: [] }
const variant = (id: number, stock: number) => ({ id, producto_id: 9, nombre: `Color ${id}`, color_hex: "#111111", stock, imagenes: [], activo: true, orden: id, created_at: "2026-01-01" })

const ENTRY = `
import { createElement as h, StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { CartProvider, useCart } from "@/context/cart-context"
import { GlobalSearchBar } from "@/components/global-search-bar"
import { trackCheckoutStarted } from "@/lib/analytics/track-commerce"

const simple = ${JSON.stringify({ ...base, id: 7, nombre: "Encendedor USB", slug: "encendedor", stock: 2, producto_variantes: [] })}
const withVariants = ${JSON.stringify({ ...base, id: 9, nombre: "Auricular", slug: "auricular", stock: 3, producto_variantes: [variant(91, 3), variant(92, 0)] })}

function Harness() {
  const { addToCart, increaseQuantity, cart } = useCart()
  const [search, setSearch] = useState("")
  const line = cart.find((item) => item.product.id === 7)
  const button = (id, onClick) => h("button", { id, onClick }, id)
  return h("div", null,
    button("add-simple", () => addToCart(simple, "")),
    button("add-variant", () => addToCart(withVariants, "variant:91")),
    button("add-sold-out", () => addToCart(withVariants, "variant:92")),
    button("increase-simple", () => line && increaseQuantity(7, line.color)),
    button("admin-preview", () => addToCart(withVariants, "variant:91", undefined, { track: false })),
    button("checkout", () => trackCheckoutStarted()),
    h("output", { id: "cart" }, JSON.stringify(cart.map((item) => [item.product.id, item.quantity, item.variantId]))),
    h(GlobalSearchBar, { search, products: [], onSearchChange: setSearch }),
  )
}

createRoot(document.getElementById("root")).render(h(StrictMode, null, h(CartProvider, null, h(Harness))))
`

let browser: Browser
let bundle: string

test.before(async () => {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "commerce-tracking-fixture.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

type Beacon = { endpoint: string; body: Record<string, unknown> }

async function openStore() {
  const context = await browser.newContext()
  const page = await context.newPage()
  const beacons: Beacon[] = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>window.process={env:{NODE_ENV:"development"}}</script><script>${bundle}</script></body></html>`,
  }))
  await page.route(`${ORIGIN}/api/analytics/**`, async (route) => {
    beacons.push({ endpoint: new URL(route.request().url()).pathname, body: JSON.parse(route.request().postData() ?? "{}") })
    await route.fulfill({ status: 204 })
  })
  await page.goto(`${ORIGIN}/productos`)
  await page.locator("#add-simple").waitFor()
  return { context, page, beacons, errors }
}

const cartState = async (page: Page) => JSON.parse(await page.locator("#cart").innerText()) as [number, number, number | null][]

async function settle(page: Page, beacons: Beacon[], count: number) {
  const deadline = Date.now() + 3_000
  while (beacons.length < count && Date.now() < deadline) await page.waitForTimeout(25)
  await page.waitForTimeout(150)
}

const addEvents = (beacons: Beacon[]) => beacons.filter((beacon) => beacon.endpoint === "/api/analytics/add-to-cart")

test("add_to_cart: una unidad agregada de verdad = un evento (también en Strict Mode); tope, sin stock y vista previa del Admin no", async () => {
  const { context, page, beacons, errors } = await openStore()
  try {
    await page.locator("#add-simple").click()
    await settle(page, beacons, 1)
    assert.deepEqual(await cartState(page), [[7, 1, null]])
    assert.equal(addEvents(beacons).length, 1, "Strict Mode ejecuta el updater dos veces: el evento no se duplica")

    await page.locator("#add-simple").click()
    await page.locator("#add-simple").click()
    await settle(page, beacons, 2)
    assert.deepEqual(await cartState(page), [[7, 2, null]], "tope del producto: 2 en stock")
    assert.equal(addEvents(beacons).length, 2, "el tercer clic no agregó nada: no es un evento")

    await page.locator("#increase-simple").click()
    await settle(page, beacons, 2)
    assert.equal(addEvents(beacons).length, 2, "+ en el carrito ya en el tope: sin evento")

    await page.locator("#add-sold-out").click()
    await settle(page, beacons, 2)
    assert.equal(addEvents(beacons).length, 2, "variante sin stock: el agregado falla y no hay evento")

    await page.locator("#add-variant").click()
    await settle(page, beacons, 3)
    await page.locator("#admin-preview").click()
    await settle(page, beacons, 3)
    assert.deepEqual(await cartState(page), [[7, 2, null], [9, 2, 91]], "la vista previa sí agrega al carrito")
    const events = addEvents(beacons)
    assert.equal(events.length, 3, "vista previa del Admin: sin evento")
    assert.deepEqual(events.map((event) => [event.body.productId, event.body.variantId]), [[7, null], [7, null], [9, 91]], "producto y variante correctos")
    assert.equal(new Set(events.map((event) => event.body.sessionId)).size, 1, "misma sesión de Analítica")
    assert.equal(new Set(events.map((event) => event.body.eventId)).size, 3, "cada acción real con su propio id (idempotencia técnica)")
    assert.ok(events.every((event) => Object.keys(event.body).sort().join() === "eventId,productId,sessionId,variantId"), "sin usuario, precio ni cantidades en el payload")
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("add_to_cart: + en el carrito con lugar suma un evento", async () => {
  const { context, page, beacons } = await openStore()
  try {
    await page.locator("#add-simple").click()
    await settle(page, beacons, 1)
    await page.locator("#increase-simple").click()
    await settle(page, beacons, 2)
    assert.deepEqual(await cartState(page), [[7, 2, null]])
    assert.equal(addEvents(beacons).length, 2)
  } finally { await context.close() }
})

test("search: sólo al ejecutar, normalizada; vacía o con datos sensibles no se envía", async () => {
  const { context, page, beacons } = await openStore()
  const input = page.getByRole("textbox")
  const searches = () => beacons.filter((beacon) => beacon.endpoint === "/api/analytics/search")
  try {
    await input.fill("  Auriculares    BLUETOOTH  ")
    await page.waitForTimeout(200)
    assert.equal(searches().length, 0, "escribir no es buscar")
    await input.press("Enter")
    await settle(page, beacons, 1)
    assert.deepEqual(searches().map((beacon) => beacon.body.query), ["auriculares bluetooth"])
    assert.equal(await page.evaluate(() => (window as Window & { __pushed?: string }).__pushed), "/productos?search=%20%20Auriculares%20%20%20%20BLUETOOTH%20%20", "la búsqueda en sí no cambia")

    for (const sensitive of ["mi mail juan.perez@test.com", "11 4444 5555", "dni 30.123.456", "4509 9535 6623 3704", "   "]) {
      await input.fill(sensitive)
      await input.press("Enter")
    }
    await page.waitForTimeout(300)
    assert.equal(searches().length, 1, "emails, teléfonos, documentos, tarjetas y vacías no salen del navegador")

    await input.fill("Lámpara Ñandú")
    await input.press("Enter")
    await settle(page, beacons, 2)
    assert.equal(searches().at(-1)?.body.query, "lámpara ñandú", "tildes y ñ intactas")
  } finally { await context.close() }
})

test("checkout_started: uno por sesión aunque se recargue o se vuelva a entrar", async () => {
  const { context, page, beacons } = await openStore()
  const checkouts = () => beacons.filter((beacon) => beacon.endpoint === "/api/analytics/checkout-started")
  try {
    await page.locator("#checkout").click()
    await page.locator("#checkout").click()
    await settle(page, beacons, 1)
    await page.reload()
    await page.locator("#checkout").click()
    await page.waitForTimeout(300)
    assert.equal(checkouts().length, 1)
    assert.deepEqual(Object.keys(checkouts()[0].body), ["sessionId"])
  } finally { await context.close() }
})
