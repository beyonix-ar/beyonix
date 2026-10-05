import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser } from "playwright-core"

const stubs: Plugin = {
  name: "customer-credit-note-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `export function useAuth() { return { user: { id: "customer-1", email: "cliente@example.test" }, isLoading: false } }`,
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: 0, loading: false } }`,
      "next/navigation": `const router = { push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }
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
import { CompraDetalleClient } from "@/app/cuenta/cuenta-client"
const withNote = new URLSearchParams(location.search).get("note") !== "no"
const activeOrder = new URLSearchParams(location.search).get("status") === "active"
const financialStatus = new URLSearchParams(location.search).get("finance") ?? "refunded"
const order = {
  id: 500, usuario_id: "customer-1", cliente_nombre: "María Núñez", estado: activeOrder ? "entregado" : "cancelado",
  financial_status: financialStatus, payment_status: "approved", total: 45000,
  invoice_status: "authorized", invoice_number: 5, invoice_point: 1, invoice_cae: "12345678901234",
  credit_note_status: withNote ? "authorized" : null,
  credit_note_number: withNote ? 9 : null, credit_note_point: withNote ? 1 : null,
  credit_note_cae: withNote ? "98765432109876" : null,
  created_at: "2026-09-20T12:00:00Z", cancelled_at: "2026-09-22T12:00:00Z",
  orden_items: [{ id: 1, producto_id: 9, cantidad: 1, precio: 45000, productos: { nombre: "Producto de prueba" } }],
  order_audit_events: [], order_claims: [],
}
window.__pdfRequests = []
window.fetch = async (input) => {
  const url = String(input)
  if (url === "/api/orders/500") return Response.json({ order, server_now: "2026-09-23T12:00:00Z" })
  if (url === "/api/orders/500/claims") return Response.json({ claims: [] })
  if (url === "/api/orders/500/invoice?type=credit_note") {
    window.__pdfRequests.push(url)
    return new Response(new Blob(["%PDF-1.4\\n%%EOF"], { type: "application/pdf" }), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="Nota-Credito-BEYONIX.pdf"' } })
  }
  return Response.json({ error: "Sin datos" }, { status: 404 })
}
createRoot(document.getElementById("root")).render(createElement(CompraDetalleClient, { orderId: 500 }))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "customer-credit-note-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://x.invalid"', "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"k"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: pedido cancelado muestra la nota, permite verla y descargarla sobre una superficie opaca`, async () => {
    const page = await browser.newPage({ viewport: { width: theme === "dark" ? 390 : 1280, height: 900 }, acceptDownloads: true })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const html = `<!doctype html><html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`
    await page.route("**/*", (route) => route.request().url().startsWith("http://localhost/compras") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort())
    try {
      await page.goto("http://localhost/compras")
      const note = page.getByRole("region", { name: "Nota de crédito emitida" })
      await note.waitFor()
      assert.match(String(await note.textContent()), /0001-00000009/)
      const surface = await page.locator(".customer-cancelled-order-surface").evaluate((element) => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, image: style.backgroundImage, opacity: style.opacity }
      })
      assert.equal(surface.image, "none")
      assert.equal(surface.opacity, "1")
      assert.match(surface.background, /^rgb\(/)
      const noteBackground = await note.evaluate((element) => getComputedStyle(element).backgroundColor)
      assert.match(noteBackground, /^rgb\(/)
      const noteSurface = await note.evaluate((element) => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, image: style.backgroundImage, opacity: style.opacity }
      })
      assert.equal(noteSurface.image, "none")
      assert.equal(noteSurface.opacity, "1")
      assert.match(noteSurface.background, /^rgb\(/)
      const cardSurfaces = await page.locator(".customer-cancelled-order-surface section, .customer-cancelled-order-surface dl > div, .customer-cancelled-order-surface .size-12, .customer-cancelled-order-surface section:has(h2:text-is('Productos comprados')) .mt-2\\.5 > div").evaluateAll((elements) =>
        elements.map((element) => ({ background: getComputedStyle(element).backgroundColor, opacity: getComputedStyle(element).opacity })),
      )
      assert.ok(cardSurfaces.length >= 8)
      for (const card of cardSurfaces) {
        assert.match(card.background, /^rgb\(/)
        assert.equal(card.opacity, "1")
      }
      assert.equal(await page.locator(".customer-cancelled-order-page").evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)")
      await note.getByRole("button", { name: "Ver nota de crédito" }).click()
      const modal = page.locator(".beyonix-modal-shell")
      await modal.getByRole("button", { name: "Descargar nota de crédito" }).waitFor()
      assert.match(await modal.evaluate((element) => getComputedStyle(element).backgroundColor), /^rgb\(/)
      assert.deepEqual(await page.evaluate(() => (window as unknown as { __pdfRequests: string[] }).__pdfRequests), ["/api/orders/500/invoice?type=credit_note"])
      await modal.getByRole("button", { name: "Cerrar" }).click()
      const downloadPromise = page.waitForEvent("download")
      await note.getByRole("button", { name: "Descargar nota de crédito" }).click()
      const download = await downloadPromise
      assert.equal(download.suggestedFilename(), "Nota-Credito-BEYONIX.pdf")
      assert.equal(await page.locator(".customer-cancelled-order-page").getByText("No se pudo descargar la nota de crédito.").count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

for (const finance of ["refund_pending", "cancelled"] as const) {
  test(`pedido ${finance}: las cards mantienen fondo opaco en móvil y escritorio`, async () => {
    for (const [theme, width] of [["dark", 390], ["light", 1280]] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const html = `<!doctype html><html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`
      await page.route("**/*", (route) => route.request().url().startsWith("http://localhost/compras") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort())
      try {
        await page.goto(`http://localhost/compras?finance=${finance}`)
        await page.getByRole("heading", { name: "Pedido cancelado correctamente" }).waitFor()
        const backgrounds = await page.locator(".customer-cancelled-order-surface section, .customer-cancelled-order-surface dl > div, .customer-cancelled-order-surface .size-12, .customer-cancelled-order-surface section:has(h2:text-is('Productos comprados')) .mt-2\\.5 > div").evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).backgroundColor),
        )
        assert.ok(backgrounds.length >= 7)
        for (const background of backgrounds) assert.match(background, /^rgb\(/)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      } finally { await page.close() }
    }
  })
}

test("sin nota autorizada no se muestra el acceso fiscal", async () => {
  const page = await browser.newPage()
  const html = `<!doctype html><html data-account-theme="dark" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`
  await page.route("**/*", (route) => route.request().url().startsWith("http://localhost/compras") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort())
  try {
    await page.goto("http://localhost/compras?note=no")
    await page.getByRole("heading", { name: "Pedido cancelado correctamente" }).waitFor()
    assert.equal(await page.getByRole("region", { name: "Nota de crédito emitida" }).count(), 0)
  } finally { await page.close() }
})

test("un pedido activo con nota autorizada también muestra el acceso fiscal", async () => {
  const page = await browser.newPage()
  const html = `<!doctype html><html data-account-theme="dark" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`
  await page.route("**/*", (route) => route.request().url().startsWith("http://localhost/compras") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort())
  try {
    await page.goto("http://localhost/compras?status=active")
    const note = page.getByRole("region", { name: "Nota de crédito emitida" })
    await note.waitFor()
    const surface = await note.evaluate((element) => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, image: style.backgroundImage, opacity: style.opacity }
    })
    assert.equal(surface.image, "none")
    assert.equal(surface.opacity, "1")
    assert.match(surface.background, /^rgb\(/)
    await note.getByRole("button", { name: "Ver nota de crédito" }).click()
    await page.locator(".beyonix-modal-shell").getByRole("button", { name: "Descargar nota de crédito" }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __pdfRequests: string[] }).__pdfRequests), ["/api/orders/500/invoice?type=credit_note"])
  } finally { await page.close() }
})
