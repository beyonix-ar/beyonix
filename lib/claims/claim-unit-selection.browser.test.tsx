import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// "Iniciar reclamo" con el CustomerClaimExperience REAL (bundle esbuild) y el
// CSS del proyecto, en Light y Dark: selección por UNIDAD, aviso para varias
// unidades, check verde con tilde blanca y el caso de una única unidad.

const SHOTS = process.env.CLAIM_UNITS_SHOTS

const stubs: Plugin = {
  name: "claim-units-stubs",
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

const single = new URLSearchParams(location.search).get("scenario") === "single"
const product = (id, nombre) => ({ id, nombre, slug: "p" + id, descripcion: null, precio: 20000, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" })
const items = single
  ? [{ id: 71, orden_id: 500, producto_id: 1, cantidad: 1, precio: 20000, productos: product(1, "Auricular Ñandú") }]
  : [
      { id: 71, orden_id: 500, producto_id: 1, cantidad: 2, precio: 20000, productos: product(1, "Auricular Ñandú") },
      { id: 72, orden_id: 500, producto_id: 2, cantidad: 1, precio: 9000, productos: product(2, "Cargador") },
    ]
const pedido = {
  id: 500, usuario_id: "c", estado: "entregado", delivered_at: new Date(Date.now() - 86400000).toISOString(), total: 49000,
  created_at: "2026-09-15T12:00:00Z", payment_method_id: "mercadopago", shipping_type: "domicilio",
  orden_items: items, order_claims: [],
}
window.fetch = async (input) => {
  const url = String(input)
  if (url.endsWith("/api/orders/500/claims")) return Response.json({ claims: [] })
  return Response.json({ error: "sin datos en el test" }, { status: 404 })
}
createRoot(document.getElementById("customer-root")).render(createElement(CustomerClaimExperience, { order: pedido, claimsVerified: true, initialProblem: "falla" }))
`

const pageHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head>
<body class="bg-beyonix-page"><div class="relative z-10">
<main class="customer-claim-create-page min-h-screen px-3 pt-20 font-heading sm:px-5 sm:pt-24 lg:px-8">
  <div class="customer-claim-page-frame w-full py-2"><div id="customer-root"></div></div>
</main></div>
<script>window.process = { env: { NODE_ENV: "production" } }</script>
<script>${bundle}</script></body></html>`

const CONTRAST = `((el) => {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const parse = (v) => { if (!v || v === "transparent") return [0,0,0,0]; ctx.clearRect(0,0,1,1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = v; ctx.fillRect(0,0,1,1); const d = ctx.getImageData(0,0,1,1).data; return [d[0],d[1],d[2],d[3]/255] }
  const lum = (c) => { const ch = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126*ch(c[0]) + 0.7152*ch(c[1]) + 0.0722*ch(c[2]) }
  const over = (t, b) => [t[0]*t[3]+b[0]*(1-t[3]), t[1]*t[3]+b[1]*(1-t[3]), t[2]*t[3]+b[2]*(1-t[3]), 1]
  const layers = []
  for (let node = el; node; node = node.parentElement) { const c = parse(getComputedStyle(node).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 0.95) break } }
  let bg = document.documentElement.dataset.accountTheme === "light" ? [255,255,255,1] : [5,8,12,1]
  for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg)
  const fg = over(parse(getComputedStyle(el).color), bg)
  const a = lum(fg), b = lum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
})`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "claim-units-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light", scenario: "multi" | "single", width = 1280): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 1100 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://claims.test/")
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml(theme, css, bundle) })
      : route.abort(),
  )
  await page.goto(`http://claims.test/?scenario=${scenario}`)
  try {
    await page.waitForSelector("[data-claim-unit]", { timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: varias unidades -> una tarjeta por unidad, ninguna marcada, aviso destacado y envío deshabilitado`, async () => {
    const page = await open(theme, "multi")
    try {
      const units = page.locator("[data-claim-unit]")
      assert.equal(await units.count(), 3, "2 unidades del mismo producto + 1 de otro")
      assert.deepEqual(
        await units.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-pressed"))),
        ["false", "false", "false"],
      )
      assert.match(await units.nth(0).innerText(), /Unidad 1 de 2/)
      assert.match(await units.nth(1).innerText(), /Unidad 2 de 2/)

      const hint = page.locator("[data-claim-units-hint]")
      assert.equal(await hint.innerText(), "Marcá únicamente las unidades con falla")
      const style = await hint.evaluate((node) => ({ weight: Number(getComputedStyle(node).fontWeight), line: getComputedStyle(node).textDecorationLine }))
      assert.ok(style.weight >= 700, "negrita")
      assert.equal(style.line, "underline")
      const hintRatio = (await page.evaluate(`${CONTRAST}(document.querySelector("[data-claim-units-hint]"))`)) as number
      assert.ok(hintRatio >= 4.5, `contraste del aviso ${hintRatio.toFixed(2)}`)

      const submit = page.getByRole("button", { name: "Enviar reclamo" })
      assert.equal(await submit.isDisabled(), true, "0 unidades: no se envía")

      await units.nth(1).click()
      assert.equal(await units.nth(1).getAttribute("aria-pressed"), "true")
      assert.equal(await units.nth(1).locator("[data-claim-unit-check]").getAttribute("data-claim-unit-check"), "on")
      // Como string: el transpilador no inyecta helpers dentro del navegador.
      const colors = (await page.evaluate(`(() => {
        const node = document.querySelectorAll("[data-claim-unit]")[1].querySelector("[data-claim-unit-check]")
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1
        const ctx = canvas.getContext("2d", { willReadFrequently: true })
        const rgb = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)) }
        return { background: rgb(getComputedStyle(node).backgroundColor), tick: rgb(getComputedStyle(node.querySelector("svg")).color) }
      })()`)) as { background: number[]; tick: number[] }
      assert.deepEqual(colors.tick, [255, 255, 255], "tilde blanca")
      const [red, green, blue] = colors.background
      assert.ok(green > red + 60 && green > blue + 20 && green >= 150, `círculo verde claro (${colors.background})`)
      assert.equal(await units.nth(0).locator("[data-claim-unit-check]").getAttribute("data-claim-unit-check"), "off")

      await units.nth(1).click()
      assert.equal(await units.nth(1).getAttribute("aria-pressed"), "false", "se puede destildar")
      // Unidad seleccionada = mismo fondo de acento que un motivo seleccionado
      // (medido después de la transición de 200 ms de la tarjeta).
      await units.nth(0).click()
      await page.mouse.move(0, 0)
      await page.evaluate("Promise.all(document.getAnimations().map((animation) => animation.finished))")
      const backgrounds = (await page.evaluate(`[
        getComputedStyle(document.querySelector("[data-claim-unit]")).backgroundColor,
        getComputedStyle(document.querySelector(".customer-claim-problem-option[aria-pressed=true]")).backgroundColor,
      ]`)) as [string, string]
      assert.equal(backgrounds[0], backgrounds[1], "la unidad marcada usa el acento de selección")
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/claim-units-${theme}.png`, fullPage: false })
    } finally {
      await page.close()
    }
  })

  test(`${theme}: una sola unidad -> seleccionada, fija y sin aviso`, async () => {
    const page = await open(theme, "single")
    try {
      const unit = page.locator("[data-claim-unit]")
      assert.equal(await unit.count(), 1)
      assert.equal(await unit.getAttribute("aria-pressed"), "true")
      assert.equal(await unit.getAttribute("aria-disabled"), "true")
      // aria-disabled: Playwright no la considera accionable; se fuerza el clic.
      await unit.click({ force: true })
      assert.equal(await unit.getAttribute("aria-pressed"), "true", "no se puede destildar")
      assert.match(await unit.innerText(), /Única unidad del pedido/)
      assert.equal(await page.locator("[data-claim-units-hint]").count(), 0)
    } finally {
      await page.close()
    }
  })
}
