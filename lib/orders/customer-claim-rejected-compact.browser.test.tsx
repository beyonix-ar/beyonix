import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Chat del cliente para un reclamo RECHAZADO con el CustomerClaimExperience
// REAL (bundle esbuild) y el CSS del proyecto, dentro del marco real de
// /cuenta/compras/[id]/ayuda, en Light y Dark del storefront:
// - encabezado sin el texto "Producto afectado… BEYONIX revisará el caso";
// - bloque de resolución compacto: título, resolución y motivo (sin "Detalle");
// - aviso final en una sola línea con el mail como texto (no botón);
// - todo el texto de esos bloques cumple contraste AA.

const SHOTS = process.env.CLAIM_COMPACT_SHOTS

const stubs: Plugin = {
  name: "customer-claim-compact-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `export function useAuth() { return { user: { id: "c", rol: "cliente" } } }`,
      "next/navigation": `const router = { push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }
        export function useRouter() { return router }
        export function usePathname() { return "/cuenta/compras/500/ayuda" }
        export function useSearchParams() { return new URLSearchParams() }`,
      "@/lib/supabase/client": `
        const channel = { on() { return channel }, subscribe() { return channel } }
        export const supabase = { auth: { getSession: async () => ({ data: { session: null }, error: null }) }, channel: () => channel, removeChannel: async () => "ok" }
        export function createClient() { return supabase }
        export function isInvalidRefreshTokenError() { return false }
        export function isMissingAuthSessionError() { return false }
        export function clearSupabaseBrowserSession() {}
        export async function getSafeSupabaseSession() { return null }`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const ENTRY = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { CustomerClaimExperience } from "@/components/claims/customer-claim-experience"

const structured = new URLSearchParams(location.search).get("scenario") === "structured"
const producto = { id: 1, nombre: "Auricular Ñandú", slug: "a", descripcion: null, precio: 20000, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" }
const claim = {
  id: 900, order_id: 500, user_id: "c", claim_type: "garantia_beyonix", failure_type: "falla",
  status: "rechazado", resolution: "rechazado",
  resolution_summary: structured ? { kind: "rechazado", label: "Reclamo no aprobado", detail: "Motivo: El producto presenta daño por mal uso.", amount: null, notice: "El reclamo no fue aprobado." } : null,
  rejection_reason: "El producto presenta daño por mal uso.",
  description: "Producto afectado: Auricular Ñandú\\n\\nNo enciende.",
  affected_items: [{ order_item_id: 71, quantity: 1 }],
  order_claim_messages: [
    { id: 1, claim_id: 900, author_role: "cliente", message: "El auricular no enciende.", created_at: "2026-09-20T10:00:00Z" },
    { id: 2, claim_id: 900, author_role: "admin", message: "BEYONIX resolvió el reclamo.\\nResolución: Reclamo no aprobado.", created_at: "2026-09-21T10:05:00Z" },
  ],
  order_claim_files: [],
  closed_at: "2026-09-21T10:05:00Z", created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-21T10:05:00Z",
}
const pedido = {
  id: 500, usuario_id: "c", estado: "entregado", delivered_at: "2026-09-18T12:00:00Z", total: 20000, created_at: "2026-09-15T12:00:00Z",
  payment_method_id: "mercadopago", shipping_type: "domicilio",
  orden_items: [{ id: 71, orden_id: 500, producto_id: 1, cantidad: 1, precio: 20000, productos: producto }],
  order_claims: [claim],
}
window.fetch = async (input) => {
  const url = String(input)
  if (url.endsWith("/api/orders/500/claims")) return Response.json({ claims: [claim] })
  if (url.endsWith("/claims/read")) return Response.json({ ok: true })
  return Response.json({ error: "sin datos en el test" }, { status: 404 })
}
createRoot(document.getElementById("customer-root")).render(createElement(CustomerClaimExperience, { order: pedido, claimsVerified: true }))
`

const pageHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head>
<body class="bg-beyonix-page"><div class="relative z-10">
<main class="customer-claim-create-page min-h-screen px-3 pt-20 font-heading sm:px-5 sm:pt-24 lg:px-8">
  <div class="customer-claim-page-frame w-full py-2"><div id="customer-root"></div></div>
</main></div>
<script>window.process = { env: { NODE_ENV: "production" } }</script>
<script>${bundle}</script></body></html>`

const BROWSER_HELPERS = `
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  function parse(value) {
    if (!value || value === "transparent") return [0, 0, 0, 0]
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  function lum(c) {
    const ch = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
  }
  function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  function over(top, bottom) { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1] }
  function background(el) {
    const layers = []
    for (let node = el; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor)
      if (color[3] > 0) { layers.push(color); if (color[3] >= 0.95) break }
    }
    let result = [255, 255, 255, 1]
    for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result)
    return result
  }
`

const MEASURE = `(() => {
  ${BROWSER_HELPERS}
  const header = document.querySelector(".customer-claim-chat-header")
  const resolution = document.querySelector("[data-testid=customer-claim-resolution]")
  const notice = document.querySelector("[data-testid=customer-claim-finished-notice]")
  const failures = []
  for (const block of [header, resolution, notice]) {
    for (const el of block.querySelectorAll("*")) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim()
      if (!own) continue
      const bg = background(el)
      const r = ratio(over(parse(getComputedStyle(el).color), bg), bg)
      if (r < 4.5) failures.push(own.slice(0, 40) + " -> " + r.toFixed(2))
    }
  }
  const lineHeight = parseFloat(getComputedStyle(notice).lineHeight)
  return {
    headerText: header.innerText.replace(/\\s+/g, " ").trim(),
    headerHeight: Math.round(header.getBoundingClientRect().height),
    resolutionText: resolution.innerText.replace(/\\s+/g, " ").trim(),
    resolutionHeight: Math.round(resolution.getBoundingClientRect().height),
    noticeText: notice.innerText.replace(/\\s+/g, " ").trim(),
    noticeLines: Math.round(notice.getBoundingClientRect().height / lineHeight - 0.4),
    noticeHasLink: notice.querySelector("a, button") !== null,
    failures,
  }
})()`

type Measure = {
  headerText: string; headerHeight: number; resolutionText: string; resolutionHeight: number
  noticeText: string; noticeLines: number; noticeHasLink: boolean; failures: string[]
}

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "customer-claim-compact-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light", scenario: string, width = 1280): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 1100 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://claim.test/")
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml(theme, css, bundle) })
      : route.abort(),
  )
  await page.goto(`http://claim.test/?scenario=${scenario}`)
  try {
    await page.waitForSelector("[data-testid=customer-claim-finished-notice]", { timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

for (const theme of ["light", "dark"] as const) {
  for (const scenario of ["structured", "legacy"] as const) {
    test(`${theme}/${scenario}: reclamo rechazado compacto y legible`, async () => {
      const page = await open(theme, scenario)
      try {
        const data = (await page.evaluate(MEASURE)) as Measure
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/claim-${theme}-${scenario}.png`, fullPage: true })

        assert.doesNotMatch(data.headerText, /Producto afectado|revisará el caso/)
        assert.match(data.headerText, /Chat del reclamo/)
        assert.ok(data.headerHeight <= 80, `header ${data.headerHeight}px`)

        if (scenario === "structured") {
          assert.equal(data.resolutionText, "Resolución del reclamo Resolución: Reclamo no aprobado Motivo: El producto presenta daño por mal uso.")
        } else {
          // Histórico sin resolution_summary: sin motivo inventado.
          assert.equal(data.resolutionText, "Resolución del reclamo Resolución: Reclamo no aprobado")
        }
        assert.doesNotMatch(data.resolutionText, /Detalle/)
        assert.ok(data.resolutionHeight <= 84, `bloque de resolución ${data.resolutionHeight}px`)

        assert.equal(data.noticeText, "Reclamo finalizado. Por otras consultas, escribinos a beyonix.ar@gmail.com")
        assert.equal(data.noticeLines, 1, "aviso en una sola línea")
        assert.equal(data.noticeHasLink, false, "el mail es texto, no botón ni link")

        assert.deepEqual(data.failures, [])
      } finally {
        await page.close()
      }
    })
  }
}

test("mobile (390px): los bloques compactos no desbordan horizontalmente", async () => {
  const page = await open("light", "structured", 390)
  try {
    const overflow = await page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/claim-light-mobile.png`, fullPage: true })
    assert.equal(overflow, false)
  } finally {
    await page.close()
  }
})
