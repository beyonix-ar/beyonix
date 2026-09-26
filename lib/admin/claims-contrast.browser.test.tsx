import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// "Atención al cliente" con el AdminClaimManager REAL (bundle esbuild) dentro
// de la cadena real del detalle de pedido, con el CSS del proyecto compilado
// por Tailwind (mismas utilidades que producción). Audita el contraste de
// CADA texto visible contra su fondo efectivo, en Light y Dark.
//
// Regresión que cubre: en Light, las reglas legacy de Dark por
// [rounded][border] (no acotadas al tema) pintaban un gradiente navy sobre
// las superficies claras anidadas -> texto oscuro sobre navy en las tarjetas
// de resumen, Evidencia, chat y "Gestionar reclamo".
//
// Stubs sólo de infraestructura: auth (usuario admin) y cliente de Supabase
// (sin sesión ni red). Componente, marcado y estilos son los reales.

const stubs: Plugin = {
  name: "claims-test-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\/context\/auth-context$/ }, () => ({ path: "auth", namespace: "stub" }))
    pluginBuild.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: "supabase", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /^auth$/, namespace: "stub" }, () => ({
      contents: `export function useAuth() { return { user: { rol: "admin" } } }`,
      loader: "js",
    }))
    pluginBuild.onLoad({ filter: /^supabase$/, namespace: "stub" }, () => ({
      contents: `
        const channel = { on() { return channel }, subscribe() { return channel } }
        export const supabase = {
          auth: { getSession: async () => ({ data: { session: null }, error: null }) },
          channel: () => channel,
          removeChannel: async () => "ok",
        }
        export function createClient() { return supabase }
        export function isInvalidRefreshTokenError() { return false }
        export function isMissingAuthSessionError() { return false }
        export function clearSupabaseBrowserSession() {}
        export async function getSafeSupabaseSession() { return null }
      `,
      loader: "js",
    }))
  },
}

const ENTRY = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { AdminClaimManager } from "@/components/claims/admin-claim-manager"

const producto = { id: 1, nombre: "Auricular Ñandú", slug: "a", descripcion: null, precio: 20000, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" }
const claim = {
  id: 900, order_id: 500, user_id: "c", claim_type: "garantia_beyonix", failure_type: "falla",
  status: "aprobado", resolution: "cambio_producto", description: "Producto afectado: Auricular Ñandú\\n\\nNo enciende.",
  affected_items: [{ order_item_id: 71, quantity: 1 }],
  order_claim_messages: [
    { id: 1, claim_id: 900, author_role: "cliente", message: "El auricular no enciende.", created_at: "2026-09-20T10:00:00Z" },
    { id: 2, claim_id: 900, author_role: "admin", message: "Ya revisamos tu caso.", created_at: "2026-09-20T10:05:00Z" },
  ],
  order_claim_files: [{ id: 5, claim_id: 900, file_role: "evidencia", file_name: "foto-auricular.jpg", mime_type: "image/jpeg", file_size: 204800, storage_path: "x", signedUrl: "" }],
  created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:05:00Z",
}
const pedido = {
  id: 500, usuario_id: null, estado: "entregado", total: 20000, created_at: "2026-09-19T12:00:00Z",
  payment_method_id: "mercadopago", shipping_type: "domicilio",
  orden_items: [{ id: 71, orden_id: 500, producto_id: 1, cantidad: 1, precio: 20000, productos: producto }],
  order_claims: [claim],
}
createRoot(document.getElementById("claims-root")).render(createElement(AdminClaimManager, {
  pedido, mode: "all", onClaimChange: () => {}, onOpenBilling: () => {}, onInventoryUpdated: () => {},
  registeredReplacements: [], replacementLoadState: "ready",
}))
`

// Misma cadena que PedidoDetailModal embebido (admin-pedidos.tsx).
const pageHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div>
  <div class="admin-order-detail-scope bx-surface bx-surface-section mx-auto flex w-full max-w-[1420px] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#05070A]">
    <div class="bx-surface-inherit custom-scrollbar min-h-0 flex-1 bg-[#05070A]">
      <div class="flex min-w-0 flex-col gap-3 p-2.5 sm:p-3 lg:flex-row">
        <div class="admin-order-detail-content min-w-0 flex-1"><div id="claims-root"></div></div>
      </div>
    </div>
  </div>
</div></main></div>
<script>${bundle}</script></body></html>`

// Se ejecuta en el navegador como string (evita helpers inyectados por el
// transpilador). Colores vía canvas: acepta lab/oklab/color-mix de Tailwind v4.
const BROWSER_HELPERS = `
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  function parse(value) {
    if (!value || value === "transparent") return [0, 0, 0, 0]
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = "rgba(0,0,0,0)"
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  function firstStop(image) {
    const re = /(rgba?|lab|oklab|oklch|lch|hsla?|color)\\(/g
    const match = re.exec(image)
    if (!match) return null
    let i = match.index + match[0].length, level = 1
    while (i < image.length && level > 0) { if (image[i] === "(") level++; else if (image[i] === ")") level--; i++ }
    return image.slice(match.index, i)
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
      const s = getComputedStyle(node)
      const stop = firstStop(s.backgroundImage)
      if (stop) { const c = parse(stop); layers.push(c); if (c[3] >= 0.95) break }
      const color = parse(s.backgroundColor)
      if (color[3] > 0) { layers.push(color); if (color[3] >= 0.95) break }
    }
    let result = [255, 255, 255, 1]
    for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result)
    return result
  }
`

const AUDIT = `(() => {
  ${BROWSER_HELPERS}
  const failures = []
  let audited = 0
  for (const el of document.getElementById("claims-root").querySelectorAll("*")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim()
    const control = el.matches("input, textarea, button")
    const text = own || (control ? (el.getAttribute("placeholder") || el.textContent || "").trim() : "")
    if (!text) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const s = getComputedStyle(el)
    if (s.visibility === "hidden" || parseFloat(s.opacity) === 0) continue
    audited++
    const bg = background(el)
    const fg = over(parse(s.color), bg)
    const r = ratio(fg, bg)
    const size = parseFloat(s.fontSize)
    const large = size >= 18.66 || (size >= 14 && parseInt(s.fontWeight) >= 700)
    if (r < (large ? 3 : 4.5)) failures.push(text.slice(0, 40) + " -> " + r.toFixed(2) + " (" + el.className.toString().slice(0, 70) + ")")
  }
  return { audited, failures }
})()`

const BLOCK_LUMINANCE = `(() => {
  ${BROWSER_HELPERS}
  const blocks = {
    resumen: ".admin-claim-summary .admin-claim-card",
    chat: ".admin-claim-wizard-chat-drawer .admin-claim-chat-header",
    gestionar: ".admin-claim-manage-panel",
    composer: ".admin-claim-composer",
    recepcion: ".admin-claim-reception-panel",
  }
  const out = {}
  for (const [name, selector] of Object.entries(blocks)) {
    const el = document.querySelector(selector)
    out[name] = el ? lum(background(el)) : null
  }
  return out
})()`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "claims-contrast-entry.tsx" },
    bundle: true,
    format: "iife",
    write: false,
    jsx: "automatic",
    plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } })
  await page.route("**/*", (route) => route.abort())
  await page.setContent(pageHtml(theme, css, bundle))
  await page.waitForSelector(".admin-claim-manage-panel")
  return page
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: chat lateral abre, conserva borrador, cierra afuera y mantiene contraste`, async () => {
    const page = await open(theme)
    try {
      await page.getByRole("button", { name: /Abrir conversación con el cliente/ }).click()
      const drawer = page.getByRole("dialog", { name: "Conversación con el cliente" })
      await drawer.waitFor()
      const input = drawer.getByPlaceholder("Responder al cliente")
      await input.fill("Respuesta de prueba")
      const result = (await page.evaluate(AUDIT.replace('document.getElementById("claims-root")', 'document.querySelector(".admin-claim-wizard-chat-drawer")'))) as { audited: number; failures: string[] }
      assert.ok(result.audited >= 8, `se auditaron ${result.audited} textos del drawer`)
      const controlColors = await drawer.evaluate((element) => [".admin-claim-chat-input", ".admin-claim-chat-send"].map((selector) => {
        const style = getComputedStyle(element.querySelector(selector)!)
        return { selector, color: style.color, background: style.backgroundColor, image: style.backgroundImage, opacity: style.opacity, variable: style.getPropertyValue("--claim-chat-input"), drawer: getComputedStyle(element).getPropertyValue("--claim-chat-input") }
      }))
      assert.deepEqual(result.failures, [], JSON.stringify(controlColors))
      const colors = await drawer.evaluate((element) => {
        const title = getComputedStyle(element.querySelector(".admin-claim-chat-title")!).color
        const surface = getComputedStyle(element.querySelector(".admin-claim-chat-panel")!).backgroundColor
        return { title, surface }
      })
      assert.notEqual(colors.title, colors.surface)
      await page.locator(".admin-claim-wizard-chat-overlay").click({ position: { x: 8, y: 8 } })
      assert.equal(await drawer.count(), 0, "clic fuera cierra")
      await page.getByRole("button", { name: /Abrir conversación con el cliente/ }).click()
      assert.equal(await page.getByPlaceholder("Responder al cliente").inputValue(), "Respuesta de prueba")
      await page.getByRole("button", { name: "Cerrar conversación" }).click()
      assert.equal(await drawer.count(), 0, "X cierra")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: todo texto de Atención al cliente cumple contraste AA contra su fondo real`, async () => {
    const page = await open(theme)
    try {
      const { audited, failures } = (await page.evaluate(AUDIT)) as { audited: number; failures: string[] }
      assert.ok(audited > 45, `se auditaron ${audited} textos del paso actual`)
      assert.deepEqual(failures, [])
    } finally {
      await page.close()
    }
  })
}

test("Light: resumen, wizard, chat, composer y recepción son superficies claras", async () => {
  const page = await open("light")
  try {
    await page.getByRole("button", { name: /Abrir conversación con el cliente/ }).click()
    const blocks = (await page.evaluate(BLOCK_LUMINANCE)) as Record<string, number | null>
    for (const [name, value] of Object.entries(blocks)) {
      assert.ok(value !== null, `${name}: bloque presente`)
      assert.ok(value > 0.5, `${name}: fondo claro en Light (luminancia ${value?.toFixed(3)})`)
    }
  } finally {
    await page.close()
  }
})

test("Dark: los mismos bloques siguen oscuros", async () => {
  const page = await open("dark")
  try {
    await page.getByRole("button", { name: /Abrir conversación con el cliente/ }).click()
    const blocks = (await page.evaluate(BLOCK_LUMINANCE)) as Record<string, number | null>
    for (const [name, value] of Object.entries(blocks)) {
      assert.ok(value !== null && value < 0.05, `${name}: fondo oscuro en Dark (luminancia ${value?.toFixed(3)})`)
    }
  } finally {
    await page.close()
  }
})

test("CSS: los colores de las superficies legacy de Dark están acotados al tema oscuro", () => {
  const source = readFileSync("app/globals.css", "utf8").replace(/\r\n/g, "\n")
  const darkOnly = ':where(html:not([data-admin-theme="light"]))'
  // Nivel 1 y anidado: fondo navy sólo en Dark; el radio queda compartido.
  assert.ok(source.includes(`${darkOnly} :is(.admin-ds-surface, .admin-ds-card),\n${darkOnly} .beyonix-admin-main :where(section, article, aside, details, form, div)[class*="rounded"][class*="border"] {\n  background:\n    linear-gradient(145deg, rgba(7, 17, 27, 0.98)`))
  assert.ok(source.includes(`${darkOnly} .beyonix-admin-main :where(section, article, aside, details, form, div)[class*="rounded"][class*="border"]\n  :where(section, article, aside, details, div, label)[class*="rounded"][class*="border"] {\n  background:\n    linear-gradient(145deg, rgba(11, 22, 34, 0.98)`))
  assert.ok(source.includes(`${darkOnly} .beyonix-admin-main .admin-claim-composer {\n  background-color: rgba(6, 13, 22, 0.96) !important;`))
  // Ninguna regla SIN acotar al tema vuelve a pintar esos gradientes.
  const unscoped = source
    .split("}")
    .filter((rule) => /linear-gradient\(145deg, rgba\((7, 17, 27|11, 22, 34), 0\.98\)/.test(rule))
    .filter((rule) => /\[class\*="rounded"\]\[class\*="border"\]/.test(rule))
    .filter((rule) => !rule.includes(darkOnly))
  assert.deepEqual(unscoped, [])
  // Miniatura del producto con fondo propio (bg-white se remapea en Light).
  const claims = readFileSync("components/claims/admin-claim-manager.tsx", "utf8")
  assert.match(claims, /className="admin-claim-summary-thumb flex size-9/)
})
