import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Mis compras con el componente REAL (MisOrdenes) y el CSS del proyecto:
// accesos directos por tarjeta (factura, NC, reclamo) sólo cuando existen,
// visor existente sin descarga automática, Light/Dark, escritorio y teléfono.

const stubs: Plugin = {
  name: "customer-order-actions-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `export function useAuth() { return { user: { id: "customer-1", email: "cliente@example.test" }, isLoading: false } }`,
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: 0, loading: false } }`,
      "next/navigation": `const router = { push(url) { window.__pushes.push(url) }, replace() {}, refresh() {}, back() {}, prefetch() {} }
        export function useRouter() { return router }
        export function usePathname() { return "/cuenta" }
        export function useSearchParams() { return new URLSearchParams() }`,
      "next/link": `import { createElement } from "react"; export default function Link(props) { return createElement("a", { href: props.href, className: props.className }, props.children) }`,
      "@/lib/supabase/client": `const channel = { on() { return channel }, subscribe() { return channel } }
        export const supabase = { channel: () => channel, removeChannel: async () => "ok",
          auth: { getSession: async () => ({ data: { session: null }, error: null }), onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } } } } }
        export function createClient() { return supabase }`,
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
import { MisOrdenes } from "@/components/account/account-orders"
const item = (id) => [{ id, orden_id: id, producto_id: 9, cantidad: 1, productos: { nombre: "Trípode Ñandú" } }]
const base = (id, extra) => ({ id, created_at: "2026-10-20T12:00:00Z", total: 899, estado: "entregado", payment_status: "approved",
  payment_method_id: "transferencia", financial_status: "payment_confirmed", paid_at: "2026-10-20T12:05:00Z",
  delivered_at: "2026-10-22T12:00:00Z", orden_items: item(id), order_claims: [], order_audit_events: [], ...extra })
const invoiced = { invoice_status: "authorized", invoice_cae: "123" }
const note = { credit_note_status: "authorized", credit_note_number: "8", credit_note_point: 3, credit_note_cae: "456" }
const claim = (id, status, failure_type) => ({ id, status, failure_type, created_at: "2026-10-21T12:00:00Z", order_claim_messages: [] })
window.__pushes = []
window.__requests = []
window.fetch = async (input) => {
  const url = String(input)
  window.__requests.push(url)
  if (url === "/api/orders") return Response.json({ server_now: "2026-10-23T12:00:00Z", orders: [
    base(1, {}),                                                             // H: sin documentos
    base(2, invoiced),                                                       // I: factura
    base(3, { ...invoiced, ...note }),                                       // J/K: factura + NC
    base(4, { order_claims: [claim(40, "en_revision", "producto_danado")] }), // L: reclamo abierto
    base(5, { order_claims: [claim(50, "cerrado", "producto_danado")] }),     // M: reclamo cerrado
    // N/O: BX-1014 cancelado, facturado con NC y una consulta cerrada (claim 5).
    base(14, { ...invoiced, ...note, estado: "cancelado", financial_status: "refunded", delivered_at: null,
      cancelled_at: "2026-10-21T10:00:00Z", refunded_at: "2026-10-22T10:00:00Z",
      order_claims: [claim(5, "cerrado", "consulta_pedido"), claim(6, "cerrado", "cancelar_compra")] }),
  ] })
  if (url.includes("/invoice")) return new Response(new Blob(["%PDF-1.4\\n%%EOF"], { type: "application/pdf" }), { headers: { "Content-Type": "application/pdf" } })
  return Response.json({ error: "Sin datos" }, { status: 404 })
}
createRoot(document.getElementById("root")).render(createElement(MisOrdenes, { onBack() {} }))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "customer-order-actions-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://x.invalid"', "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"k"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(theme: "dark" | "light", width: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, acceptDownloads: true })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const html = `<!doctype html><html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>window.process = { env: {} }</script><script>${bundle}</script></body></html>`
  await page.route("**/*", (route) => route.request().url().startsWith("http://localhost/cuenta") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort())
  await page.goto("http://localhost/cuenta")
  await page.waitForSelector("[data-testid='customer-order-actions']", { timeout: 15000 }).catch(async (error) => {
    throw new Error(`${error}\nerrores: ${errors.join(" | ")}\ntexto: ${(await page.locator("body").innerText()).slice(0, 400)}`)
  })
  return { page, errors }
}

const actionsOf = (page: Page) => page.locator("[data-testid='customer-order-actions']").evaluateAll((rows) =>
  rows.map((row) => [...row.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "")))

test("H-O: cada compra muestra sólo los accesos que existen, en orden", async () => {
  const { page, errors } = await open("dark", 1280)
  try {
    assert.deepEqual(await actionsOf(page), [
      ["Ver compra"],
      ["Ver compra", "Ver factura"],
      ["Ver compra", "Ver factura", "Ver nota de crédito"],
      ["Ver compra", "Ver reclamo"],
      ["Ver compra", "Ver reclamo"],
      ["Ver compra", "Ver factura", "Ver nota de crédito", "Ver reclamo"],
    ])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Ver factura / Ver nota de crédito abren el visor existente (sin descarga automática); Ver reclamo abre esa conversación", async () => {
  const { page } = await open("light", 1280)
  let downloads = 0
  page.on("download", () => { downloads++ })
  try {
    await page.getByRole("button", { name: /^Ver factura del pedido .*1002$/ }).click()
    const viewer = page.getByRole("dialog")
    await viewer.waitFor()
    assert.match(await viewer.innerText(), /Factura/)
    await page.waitForFunction(() => (window as unknown as { __requests: string[] }).__requests.includes("/api/orders/2/invoice"))
    await viewer.getByRole("button", { name: "Cerrar" }).first().click()
    await page.getByRole("button", { name: /^Ver nota de crédito del pedido .*1014$/ }).click()
    await page.getByRole("dialog").waitFor()
    assert.match(await page.getByRole("dialog").innerText(), /Nota de crédito/)
    await page.waitForFunction(() => (window as unknown as { __requests: string[] }).__requests.includes("/api/orders/14/invoice?type=credit_note"))
    assert.equal(downloads, 0, "el cliente primero visualiza el documento")
    await page.getByRole("dialog").getByRole("button", { name: "Cerrar" }).first().click()
    // N/O: la consulta cerrada de un pedido cancelado sigue siendo visible (nunca la solicitud de cancelación).
    await page.getByRole("button", { name: /^Ver reclamo del pedido .*1014/ }).click()
    await page.getByRole("button", { name: /^Ver reclamo del pedido .*1005/ }).click()
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __pushes: string[] }).__pushes), ["/cuenta/compras/14/ayuda?claim=5", "/cuenta/compras/5/ayuda?claim=50"])
  } finally { await page.close() }
})

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`Q/R ${theme} ${width}px: botones compactos, legibles, sin huecos ni scroll horizontal`, async () => {
      const { page } = await open(theme, width)
      try {
        const layout = await page.evaluate(() => {
          const rows = [...document.querySelectorAll<HTMLElement>("[data-testid='customer-order-actions']")]
          const last = rows.at(-1)!
          const row = last.getBoundingClientRect()
          const buttons = [...last.querySelectorAll("button")].map((button) => {
            const box = button.getBoundingClientRect()
            const style = getComputedStyle(button)
            return { left: box.left, right: box.right, top: box.top, width: box.width, height: box.height, visible: style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.5 }
          })
          return { docOverflow: document.documentElement.scrollWidth > window.innerWidth, row: { left: row.left, right: row.right }, buttons }
        })
        assert.equal(layout.docOverflow, false, "sin scroll horizontal")
        assert.equal(layout.buttons.length, 4)
        for (const button of layout.buttons) {
          assert.ok(button.visible && button.width > 40 && button.height >= 28 && button.height <= 48, `botón visible y compacto ${JSON.stringify(button)}`)
          assert.ok(button.left >= layout.row.left - 0.5 && button.right <= layout.row.right + 0.5, "dentro de la tarjeta")
        }
        const lines = new Set(layout.buttons.map((button) => Math.round(button.top))).size
        if (width === 1280) assert.equal(lines, 1, "escritorio: en una línea")
        else assert.ok(lines >= 2, "teléfono: los botones bajan de línea")
        // Texto legible sobre su propio fondo en cada tema.
        // Como string: el transform de tsx agrega helpers (__name) que el navegador no tiene.
        const contrast = await page.evaluate(`(() => {
          // Canvas: acepta oklch/oklab/color-mix y devuelve RGBA real.
          const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1
          const ctx = canvas.getContext("2d", { willReadFrequently: true })
          const parse = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
          const luminance = (rgb) => rgb.slice(0, 3).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
            .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
          const opaque = (node) => {
            for (; node; node = node.parentElement) {
              const style = getComputedStyle(node)
              const stop = (style.backgroundImage.match(/(?:rgba?|oklch|oklab|color)\([^)]+\)/) || [])[0]
              if (stop) return stop
              const color = parse(style.backgroundColor)
              if (color[3] > 0.5) return style.backgroundColor
            }
            return "rgb(255, 255, 255)"
          }
          const buttons = [...[...document.querySelectorAll("[data-testid='customer-order-actions']")].at(-1).querySelectorAll("button")]
          return buttons.map((button) => {
            const [a, b] = [luminance(parse(getComputedStyle(button).color)), luminance(parse(opaque(button)))].sort((x, y) => y - x)
            return (a + 0.05) / (b + 0.05)
          })
        })()`) as number[]
        for (const ratio of contrast) assert.ok(ratio >= 4.5, `contraste ${theme} ${ratio.toFixed(2)}`)
      } finally { await page.close() }
    })
  }
}
