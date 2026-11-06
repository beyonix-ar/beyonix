import assert from "node:assert/strict"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"

// Carrito tras una compra, con el CartProvider REAL: sólo se descuenta lo que
// el servidor confirma como propio y pagado (/api/checkout/purchase-status,
// simulado acá). Stubs sólo de infraestructura: sesión de Supabase (invitado o
// usuario según window.__user), router de Next, catálogo y reservas de stock.

const ORIGIN = "http://tienda.test"

const stubs: Plugin = {
  name: "purchased-cart-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/lib/supabase/client": `export const supabase = { auth: {
          getSession: async () => ({ data: { session: window.__user ? { user: window.__user } : null } }),
          getUser: async () => ({ data: { user: window.__user ?? null } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        } }
        export async function getSafeSupabaseSession() { return window.__user ? { user: window.__user } : null }`,
      "@/lib/supabase/queries/store": `export async function getStoreCartProducts() { return [] }`,
      "@/lib/cart/stock-reservations": `export async function reserveCartStock() { return { ok: true } }`,
      "@/lib/analytics/track-commerce": `export function trackAddToCart() {}`,
      "next/navigation": `export function useRouter() { return { push() {}, replace() {}, refresh() {}, prefetch() {} } } export function usePathname() { return "/productos" }`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const base = { precio: 10_000, precio_anterior: null, descuento: 0, sku: "SKU", activo: true, descripcion: "", video_url: null, categorias: null, imagenes_producto: [], imagen_principal: null, producto_especificaciones: [], producto_variantes: [] }

const ENTRY = `
import { createElement as h, StrictMode, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { CartProvider, useCart } from "@/context/cart-context"

const products = {
  A: ${JSON.stringify({ ...base, id: 7, nombre: "Auricular Ñandú", slug: "auricular", stock: 3 })},
  B: ${JSON.stringify({ ...base, id: 8, nombre: "Lámpara", slug: "lampara", stock: 3 })},
}

function Harness() {
  const cart = useCart()
  useEffect(() => {
    window.__cart = cart
    window.__add = (key) => cart.addToCart(products[key], "")
  })
  return h("output", { id: "cart", "data-ready": String(cart.isReady), "data-session": cart.cartSessionId },
    JSON.stringify(cart.cart.map((item) => [item.product.id, item.quantity])))
}

createRoot(document.getElementById("root")).render(h(StrictMode, null, h(CartProvider, null, h(Harness))))
`

type Line = [number, number]
type Status = { status: "paid" | "pending" | "void" | "unknown"; items?: Array<{ productId: number; quantity: number; variantId: null; conditionedStockId: null }> }

let browser: Browser
let bundle: string

test.before(async () => {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "purchased-cart-fixture.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

/** Servidor simulado: estado por pedido y registro de lo que pidió el navegador. */
async function store(user: { id: string } | null) {
  const context = await browser.newContext()
  const statuses = new Map<number, Status>()
  const requests: Array<{ orders: Array<{ orderId: number; guestToken: string | null }> }> = []
  if (user) await context.addInitScript((value) => { (window as Window & { __user?: unknown }).__user = value }, user)
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/checkout/purchase-status") {
      const body = JSON.parse(route.request().postData() ?? "{}") as { orders: Array<{ orderId: number; guestToken: string | null }> }
      requests.push(body)
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        orders: body.orders.map(({ orderId }) => ({ orderId, ...(statuses.get(orderId) ?? { status: "unknown" }) })),
      }) })
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>window.process={env:{NODE_ENV:"development"}}</script><script>${bundle}</script></body></html>`,
    })
  })
  return { context, statuses, requests }
}

async function open(context: BrowserContext) {
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${ORIGIN}/productos`)
  await page.locator("#cart[data-ready=true]").waitFor()
  // El dueño del carrito (invitado o cuenta) se resuelve después de hidratar.
  await page.waitForTimeout(100)
  return { page, errors }
}

const cartOf = async (page: Page) => JSON.parse(await page.locator("#cart").innerText()) as Line[]
const add = (page: Page, key: "A" | "B") => page.evaluate((value) => (window as unknown as { __add(key: string): void }).__add(value), key)
const track = (page: Page, orderId: number, token: string | null) =>
  page.evaluate(([id, value]) => (window as unknown as { __cart: { trackPurchase(id: number, token: string | null): void } }).__cart.trackPurchase(id as number, value as string | null), [orderId, token] as const)
const sync = async (page: Page) => {
  await page.evaluate(() => (window as unknown as { __cart: { syncPurchasedCart(): Promise<void> } }).__cart.syncPurchasedCart())
  await page.waitForTimeout(50)
}
const paid = (...lines: Line[]): Status => ({ status: "paid", items: lines.map(([productId, quantity]) => ({ productId, quantity, variantId: null, conditionedStockId: null })) })

test("invitado: pendiente no toca; confirmado descuenta sólo lo comprado; lo agregado después queda; webhook repetido y recarga no repiten", async () => {
  const server = await store(null)
  try {
    const { page, errors } = await open(server.context)
    await add(page, "A")
    const sessionBefore = await page.locator("#cart").getAttribute("data-session")
    await track(page, 50, "token-firmado-50")
    server.statuses.set(50, { status: "pending" })
    await sync(page)
    assert.deepEqual(await cartOf(page), [[7, 1]], "pago pendiente: el carrito no cambia")
    assert.deepEqual(server.requests.at(-1), { orders: [{ orderId: 50, guestToken: "token-firmado-50" }] }, "el invitado prueba posesión con su token")

    // Mientras el pago está pendiente agrega B y otra unidad de A.
    await add(page, "B")
    await add(page, "A")
    server.statuses.set(50, paid([7, 1]))
    await sync(page)
    assert.deepEqual(await cartOf(page), [[7, 1], [8, 1]], "confirmado: sólo la unidad comprada de A")
    assert.notEqual(await page.locator("#cart").getAttribute("data-session"), sessionBefore, "la identidad de checkout del pedido pagado no se reutiliza")

    // Webhook repetido / más revisiones: nada más se descuenta (ni siquiera se vuelve a preguntar).
    const asked = server.requests.length
    await sync(page)
    await sync(page)
    assert.deepEqual(await cartOf(page), [[7, 1], [8, 1]])
    assert.equal(server.requests.length, asked)

    // Recarga: el carrito guardado ya viene descontado y no se vuelve a restar.
    await page.reload()
    await page.locator("#cart[data-ready=true]").waitFor()
    await page.waitForTimeout(150)
    assert.deepEqual(await cartOf(page), [[7, 1], [8, 1]])
    assert.equal(server.requests.length, asked, "lo aplicado no se vuelve a consultar tras recargar")
    assert.deepEqual(errors, [])
  } finally { await server.context.close() }
})

test("rechazado/cancelado y pedido ajeno: el carrito queda intacto y se deja de consultar", async () => {
  const server = await store(null)
  try {
    const { page } = await open(server.context)
    await add(page, "A")
    await add(page, "B")
    await track(page, 60, "token-60")
    await track(page, 61, "token-de-otro")
    server.statuses.set(60, { status: "void" })
    // 61 no está en el servidor para este navegador (ajeno o token inválido): "unknown".
    await sync(page)
    assert.deepEqual(await cartOf(page), [[7, 1], [8, 1]])
    const asked = server.requests.length
    await sync(page)
    assert.equal(server.requests.length, asked, "registros descartados: no se insiste")
    // Llegar a una URL de éxito no vacía nada: sin compra confirmada el carrito sigue igual.
    assert.deepEqual(await cartOf(page), [[7, 1], [8, 1]])
  } finally { await server.context.close() }
})

test("cuenta con varias pestañas: cada carrito cargado antes se descuenta una vez; una pestaña nueva no repite", async () => {
  const server = await store({ id: "usuario-1" })
  try {
    const first = await open(server.context)
    await add(first.page, "A")
    await add(first.page, "B")
    await first.page.waitForTimeout(50)
    // Segunda pestaña abierta antes de la confirmación: restaura el carrito de la cuenta.
    const second = await open(server.context)
    assert.deepEqual(await cartOf(second.page), [[7, 1], [8, 1]])

    await track(first.page, 70, "no-se-usa-con-sesion")
    server.statuses.set(70, paid([7, 1]))
    await sync(first.page)
    assert.deepEqual(await cartOf(first.page), [[8, 1]])
    assert.deepEqual(server.requests.at(-1), { orders: [{ orderId: 70, guestToken: null }] }, "con sesión el servidor reconoce al dueño; no viaja token")

    // La otra pestaña (cargada antes) también descuenta al revisar, una sola vez.
    await sync(second.page)
    assert.deepEqual(await cartOf(second.page), [[8, 1]])
    await sync(second.page)
    assert.deepEqual(await cartOf(second.page), [[8, 1]])

    // Pestaña nueva: lee el carrito ya descontado; lo que agregue después queda.
    const third = await open(server.context)
    assert.deepEqual(await cartOf(third.page), [[8, 1]])
    await add(third.page, "A")
    await sync(third.page)
    assert.deepEqual(await cartOf(third.page), [[8, 1], [7, 1]], "volver a agregar el producto comprado no se descuenta otra vez")
    assert.deepEqual([...first.errors, ...second.errors, ...third.errors], [])
  } finally { await server.context.close() }
})
