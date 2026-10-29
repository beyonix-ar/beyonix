import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Estados de recuperación del cliente con los componentes REALES y el CSS del
// proyecto: carrito vacío con "Explorar productos", resumen con "Subtotal
// estimado", pago pendiente con "Ir a Mis compras" y los estados del catálogo
// (error / vacío / sin coincidencias). Sin overflow ni botones cortados.

const stubs: Plugin = {
  name: "customer-recovery-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: window.__creditBalance ?? 0, loading: false, appliedAmount: 0, setAppliedAmount() {} } }`,
      "@/hooks/use-site-settings": `import { DEFAULT_SHIPPING_SETTINGS } from "./lib/store-config.ts"
        export function useSiteSettings() { return { shipping: DEFAULT_SHIPPING_SETTINGS, interestFreeOffer: null } }`,
      "@/components/footer": `export function Footer() { return null }`,
      "@/components/public-minimal-header": `export function PublicMinimalHeader() { return null }`,
      "next/navigation": `const router = { push(url) { window.__pushed = url }, replace() {}, refresh() {}, back() {}, prefetch() {} }
        export function useRouter() { return router }
        export function useSearchParams() { return new URLSearchParams() }
        export function usePathname() { return "/" }`,
      "next/link": `import { createElement } from "react"; export default function Link(props) { return createElement("a", { href: props.href, className: props.className, "aria-label": props["aria-label"], title: props.title }, props.children) }`,
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
import { CartDrawer } from "@/components/cart/cart-drawer"
import { CartSummary } from "@/components/cart/cart-summary"
import CheckoutPendingPage from "@/app/checkout/pending/page"
import { CatalogStatus } from "@/components/products/catalog-status"

const params = new URLSearchParams(location.search)
const view = params.get("view")
window.__creditBalance = Number(params.get("credit") ?? 0)
const noop = () => {}
const element =
  view === "cart-empty"
    ? createElement(CartDrawer, { isOpen: true, onClose: () => { window.__closed = true }, items: [], onUpdateQuantity: noop, onRemoveItem: noop })
    : view === "cart-summary"
      ? createElement(CartSummary, { subtotal: 50000, items: [{ product: { id: 1, precio: 50000 }, quantity: 1 }], onCheckout: noop, onContinueShopping: noop })
      : view === "pending"
        ? createElement(CheckoutPendingPage)
        : createElement(CatalogStatus, {
            state: view,
            onRetry: () => { window.__retried = true },
            onClearFilters: () => { window.__cleared = true },
          })
createRoot(document.getElementById("root")).render(element)
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  bundle = (await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "customer-recovery-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs], alias: { "@": process.cwd() },
    banner: { js: "var process = { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://x.invalid"', "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"k"' },
    logLevel: "error",
  })).outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(theme: "light" | "dark", width: number, query: string) {
  const page = await browser.newPage({ viewport: { width, height: 844 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const html = `<!doctype html><html data-account-theme="${theme}" data-account-scope="tienda"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root" style="padding:0 16px"></div><script>${bundle}</script></body></html>`
  await page.route("**/*", (route) => route.request().url().startsWith("http://localhost/") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort())
  await page.goto(`http://localhost/?${query}`)
  return { page, errors }
}

async function assertFits(page: Page, name: string, width: number) {
  const button = page.getByRole(name === "Ir a Mis compras" ? "link" : "button", { name })
  await button.waitFor()
  // El drawer entra con slide-in: se mide la posición final, no la animación.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)))
  const box = await button.boundingBox()
  assert.ok(box, `${name} sin caja`)
  assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${name} se sale del viewport (${box.x}+${box.width} > ${width})`)
  const clipped = await button.evaluate((node) => node.scrollWidth > node.clientWidth + 1)
  assert.equal(clipped, false, `${name} tiene el texto cortado`)
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  assert.equal(pageOverflow, false, "hay scroll horizontal")
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [390, 430, 768]) {
    test(`${theme} ${width}px: carrito vacío mantiene el mensaje y agrega "Explorar productos" -> /productos`, async () => {
      const { page, errors } = await open(theme, width, "view=cart-empty")
      try {
        await page.getByText("Tu carrito está vacío").waitFor()
        await assertFits(page, "Explorar productos", width)
        await page.getByRole("button", { name: "Explorar productos" }).click()
        assert.equal(await page.evaluate(() => (window as unknown as { __pushed?: string }).__pushed), "/productos")
        assert.equal(await page.evaluate(() => (window as unknown as { __closed?: boolean }).__closed), true)
        assert.deepEqual(errors, [])
      } finally {
        await page.close()
      }
    })

    test(`${theme} ${width}px: resumen con envío a definir dice "Subtotal estimado" + aclaración`, async () => {
      const { page, errors } = await open(theme, width, "view=cart-summary")
      try {
        await page.getByText("Subtotal estimado").waitFor()
        assert.equal(await page.getByText("El envío se calcula en el checkout.").isVisible(), true)
        assert.equal(await page.getByText("Total", { exact: true }).count(), 0)
        await assertFits(page, "Finalizar compra", width)
        assert.deepEqual(errors, [])
      } finally {
        await page.close()
      }
    })

    test(`${theme} ${width}px: pago pendiente ofrece "Ir a Mis compras" sin perder "Volver al inicio"`, async () => {
      const { page, errors } = await open(theme, width, "view=pending")
      try {
        await page.getByText("Podés seguir el estado desde Mis compras.").waitFor()
        await assertFits(page, "Ir a Mis compras", width)
        assert.equal(await page.getByRole("link", { name: "Ir a Mis compras" }).getAttribute("href"), "/cuenta?tab=ordenes")
        assert.equal(await page.getByRole("link", { name: "Volver al inicio" }).getAttribute("href"), "/")
        assert.deepEqual(errors, [])
      } finally {
        await page.close()
      }
    })

    test(`${theme} ${width}px: catálogo distingue error (Reintentar), vacío y sin coincidencias (Limpiar filtros)`, async () => {
      const error = await open(theme, width, "view=error")
      try {
        await error.page.getByText("No pudimos cargar los productos.").waitFor()
        await assertFits(error.page, "Reintentar", width)
        await error.page.getByRole("button", { name: "Reintentar" }).click()
        assert.equal(await error.page.evaluate(() => (window as unknown as { __retried?: boolean }).__retried), true)
        assert.equal(await error.page.getByText("Todavía no hay productos disponibles.").count(), 0)
        assert.deepEqual(error.errors, [])
      } finally {
        await error.page.close()
      }

      const noMatches = await open(theme, width, "view=no-matches")
      try {
        await noMatches.page.getByText("No encontramos productos con esos filtros.").waitFor()
        await assertFits(noMatches.page, "Limpiar filtros", width)
        await noMatches.page.getByRole("button", { name: "Limpiar filtros" }).click()
        assert.equal(await noMatches.page.evaluate(() => (window as unknown as { __cleared?: boolean }).__cleared), true)
        assert.deepEqual(noMatches.errors, [])
      } finally {
        await noMatches.page.close()
      }

      const empty = await open(theme, width, "view=empty")
      try {
        await empty.page.getByText("Todavía no hay productos disponibles.").waitFor()
        assert.equal(await empty.page.getByRole("button").count(), 0)
        assert.deepEqual(empty.errors, [])
      } finally {
        await empty.page.close()
      }
    })
  }
}

test("con saldo a favor el envío queda a cargo de BEYONIX y el resumen sí muestra \"Total\"", async () => {
  const { page, errors } = await open("dark", 390, "view=cart-summary&credit=1000")
  try {
    await page.getByText("Total", { exact: true }).waitFor()
    assert.equal(await page.getByText("Subtotal estimado").count(), 0)
    assert.equal(await page.getByText("El envío se calcula en el checkout.").count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
