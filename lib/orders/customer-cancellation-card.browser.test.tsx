import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser } from "playwright-core"

// Pantalla del cliente después de cancelar (CompraAyudaClient con el pedido ya
// cancelado), con el componente REAL y el CSS del proyecto: tarjeta opaca,
// título y texto breve, "Ver mi pedido" + "Volver al inicio", sin overflow.

const SHOTS = process.env.CUSTOMER_CANCELLATION_SHOTS

const stubs: Plugin = {
  name: "customer-cancellation-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `export function useAuth() { return { user: { id: "customer-1", email: "cliente@example.test" }, isLoading: false } }`,
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: 0, loading: false } }`,
      "next/navigation": `const router = { push(url) { window.__pushed = url }, replace() {}, refresh() {}, back() {}, prefetch() {} }
        export function useRouter() { return router }
        export function useSearchParams() { return new URLSearchParams() }`,
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
import { CompraAyudaClient } from "@/app/cuenta/cuenta-client"
const paid = new URLSearchParams(location.search).get("paid") === "1"
const order = {
  id: 2, usuario_id: "customer-1", estado: "cancelado", total: 1000, created_at: "2026-10-13T22:29:56Z",
  financial_status: paid ? "refund_pending" : "cancelled", payment_status: paid ? "approved" : "checkout_superseded",
  paid_at: paid ? "2026-10-13T22:30:30Z" : null, orden_items: [], order_audit_events: [], order_claims: [],
}
window.fetch = async (input) => {
  const url = String(input)
  if (url === "/api/orders/2") return Response.json({ order, server_now: "2026-10-13T23:00:00Z" })
  if (url === "/api/orders/2/claims") return Response.json({ claims: [] })
  return Response.json({ error: "Sin datos" }, { status: 404 })
}
createRoot(document.getElementById("root")).render(createElement(CompraAyudaClient, { orderId: 2 }))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  bundle = (await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "customer-cancellation-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs], alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://x.invalid"', "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"k"' },
    logLevel: "error",
  })).outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

for (const theme of ["dark", "light"] as const) {
  for (const width of [320, 390, 1280]) {
    test(`${theme} ${width}px: tarjeta opaca, clara y con "Ver mi pedido" + "Volver al inicio"`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      const html = `<!doctype html><html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`
      await page.route("**/*", (route) => route.request().url().startsWith("http://localhost/") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort())
      try {
        await page.goto(`http://localhost/ayuda?paid=${width === 390 ? "1" : "0"}`)
        const card = page.locator(".customer-cancellation-success-card")
        await card.waitFor()
        assert.equal(await page.getByRole("heading", { name: "Compra cancelada" }).count(), 1)
        const text = String(await card.textContent())
        assert.match(text, width === 390 ? /estado del reintegro/ : /No se realizó ningún cobro/)
        const surface = await card.evaluate((element) => {
          const style = getComputedStyle(element)
          return { background: style.backgroundColor, image: style.backgroundImage, opacity: style.opacity }
        })
        assert.match(surface.background, /^rgb\(/, "fondo sólido")
        assert.equal(surface.image, "none")
        assert.equal(surface.opacity, "1")
        const primary = page.getByRole("button", { name: "Ver mi pedido" })
        const secondary = page.getByRole("button", { name: "Volver al inicio" })
        const [p, s] = [await primary.boundingBox(), await secondary.boundingBox()]
        assert.ok(p && s && p.height >= 36 && s.height >= 36, "áreas táctiles")
        assert.ok(p!.x >= 0 && p!.x + p!.width <= width && s!.x + s!.width <= width, "dentro de la pantalla")
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/cliente-cancelado-${theme}-${width}.png` })
        await primary.click()
        assert.equal(await page.evaluate(() => (window as unknown as { __pushed?: string }).__pushed), "/cuenta/compras/2")
        assert.deepEqual(errors, [])
      } finally { await page.close() }
    })
  }
}
