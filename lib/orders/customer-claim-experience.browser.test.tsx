import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Pantalla del reclamo del cliente con el CustomerClaimExperience REAL (bundle
// esbuild) y el CSS del proyecto, dentro del marco real de
// /cuenta/compras/[id]/ayuda, en Light y Dark y en 390/430/1024/1440 px:
// - un solo estado arriba (qué pasa, qué hacer, qué esperar), sin depender del color;
// - historial plegado por defecto, sin IDs ni estados técnicos;
// - el chat sólo con mensajes escritos por personas (sin repetir el estado);
// - nunca "forzado", "simulación" ni datos internos;
// - contraste AA y sin desborde horizontal.

const SHOTS = process.env.CLAIM_EXPERIENCE_SHOTS

const stubs: Plugin = {
  name: "customer-claim-experience-stubs",
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

const scenario = new URLSearchParams(location.search).get("scenario")
const producto = { id: 1, nombre: "Auricular Ñandú", slug: "a", descripcion: null, precio: 20000, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" }
const msg = (id, author_role, message, system_key = null) => ({ id, claim_id: 900, author_role, message, system_key, created_at: "2026-10-1" + Math.min(9, id) + "T10:00:00Z" })
const replacementSummary = { kind: "cambio_producto", label: "Reemplazo del producto", detail: "Se registró el reemplazo correspondiente.", amount: null, notice: "Se resolvió con el reemplazo del producto." }
const rejectedSummary = { kind: "rechazado", label: "Reclamo no aprobado", detail: "Motivo: El producto presenta daño por mal uso.", amount: null, notice: "El reclamo no fue aprobado." }
const automatic = [
  msg(2, "admin", "BEYONIX aceptó el cambio del producto.", "change_accepted"),
  msg(3, "admin", "Generamos la devolución con Andreani.", "return_generated:2"),
  msg(4, "admin", "Recibimos tu producto en BEYONIX. Lo vamos a revisar.", "original_received"),
  msg(5, "admin", "Revisamos tu producto y te enviamos el reemplazo.", "replacement_dispatched:3"),
  msg(6, "admin", "Seguimiento Andreani: 360003134242400\\nRetiralo en ROSARIO cuando Andreani te avise.", "replacement_dispatch_details:3"),
]
const scenarios = {
  delivered: {
    status: "cerrado", resolution: "cambio_producto", resolution_summary: replacementSummary, closed_at: "2026-10-20T23:00:00Z",
    order_claim_shipments: [
      { id: 2, direction: "devolucion", status: "generada", closed_at: "2026-10-19T01:40:00Z" },
      { id: 3, direction: "reemplazo", status: "entregada", andreani_tracking: "360003134242400", branch_name: "ROSARIO (AV EVA PERON)", branch_address: "Av. Eva Perón 6243, Rosario", delivered_at: "2026-10-20T22:56:00Z", closed_at: "2026-10-20T22:56:00Z" },
    ],
    order_claim_messages: [
      msg(1, "cliente", "El producto llegó fallado."),
      ...automatic,
      msg(7, "admin", "Registramos la entrega de tu producto de reemplazo.", "replacement_delivered:3"),
      msg(8, "super_admin", "¡Gracias por la paciencia! Cualquier cosa nos escribís."),
      msg(9, "super_admin", "BEYONIX resolvió el reclamo.\\nResolución: Reemplazo del producto.\\nSe registró el reemplazo correspondiente."),
    ],
  },
  transit: {
    status: "aprobado", resolution: "cambio_producto", resolution_summary: null, closed_at: null,
    order_claim_shipments: [
      { id: 3, direction: "reemplazo", status: "en_transito", andreani_tracking: "360003134242400", branch_name: "ROSARIO (AV EVA PERON)", branch_address: "Av. Eva Perón 6243, Rosario", closed_at: null },
    ],
    order_claim_messages: [msg(1, "cliente", "El producto llegó fallado."), ...automatic],
  },
  dropoff: {
    status: "aprobado", resolution: "cambio_producto", resolution_summary: null, closed_at: null,
    order_claim_shipments: [{ id: 2, direction: "devolucion", status: "generada", andreani_tracking: "360003134242399", closed_at: null }],
    order_claim_messages: [msg(1, "cliente", "El producto llegó fallado."), ...automatic.slice(0, 2)],
  },
  rejected: {
    status: "rechazado", resolution: "rechazado", resolution_summary: rejectedSummary, closed_at: "2026-09-21T10:05:00Z",
    rejection_reason: "El producto presenta daño por mal uso.",
    order_claim_messages: [
      msg(1, "cliente", "El auricular no enciende."),
      msg(2, "admin", "BEYONIX resolvió el reclamo.\\nResolución: Reclamo no aprobado.\\nMotivo: El producto presenta daño por mal uso."),
    ],
  },
}
const claim = {
  id: 900, order_id: 500, user_id: "c", claim_type: "garantia_beyonix", failure_type: "falla",
  description: "Producto afectado: Auricular Ñandú\\n\\nNo enciende.",
  affected_items: [{ order_item_id: 71, quantity: 1 }], order_claim_files: [],
  created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-20T23:00:00Z",
  ...scenarios[scenario],
}
const pedido = {
  id: 500, usuario_id: "c", estado: "entregado", delivered_at: "2026-10-08T12:00:00Z", total: 20000, created_at: "2026-10-05T12:00:00Z",
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
<html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
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
  const clean = (el) => el ? el.innerText.replace(/\\s+/g, " ").trim() : ""
  const status = document.querySelector("[data-testid=customer-claim-status]")
  const history = document.querySelector("[data-testid=customer-claim-history]")
  const conversation = document.querySelector("[data-testid=customer-claim-conversation]")
  const notice = document.querySelector("[data-testid=customer-claim-finished-notice]")
  const failures = []
  const conversationLabel = conversation?.previousElementSibling
  for (const block of [status, history?.querySelector("summary"), conversationLabel, notice].filter(Boolean)) {
    for (const el of [block, ...block.querySelectorAll("*")]) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim()
      if (!own) continue
      const bg = background(el)
      const r = ratio(over(parse(getComputedStyle(el).color), bg), bg)
      if (r < 4.5) failures.push(own.slice(0, 40) + " -> " + r.toFixed(2))
    }
  }
  const buttons = [...(status?.querySelectorAll("a, button") ?? [])].map((el) => Math.round(el.getBoundingClientRect().height))
  return {
    statusText: clean(status),
    tone: status?.getAttribute("data-tone") ?? null,
    historyOpen: history ? history.open : null,
    historySummary: history?.querySelector("summary")?.textContent.trim() ?? "",
    historySteps: [...(history?.querySelectorAll("li") ?? [])].map((li) => [...li.querySelectorAll("span")].map((span) => span.textContent.trim()).join(" · ")),
    conversationText: clean(conversation),
    noticeText: clean(notice),
    shellText: clean(document.querySelector(".customer-claim-followup-shell")),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    buttons,
    failures,
  }
})()`

type Measure = {
  statusText: string; tone: string | null; historyOpen: boolean | null; historySummary: string; historySteps: string[]
  conversationText: string; noticeText: string; shellText: string; overflow: boolean; buttons: number[]; failures: string[]
}

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "customer-claim-experience-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function measure(theme: "dark" | "light", scenario: string, width = 1280): Promise<Measure> {
  const page: Page = await browser.newPage({ viewport: { width, height: 1100 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("**/*", (route) =>
      route.request().url().startsWith("http://claim.test/")
        ? route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml(theme, css, bundle) })
        : route.abort(),
    )
    await page.goto(`http://claim.test/?scenario=${scenario}`)
    try {
      await page.waitForSelector("[data-testid=customer-claim-status]", { timeout: 10_000 })
    } catch (error) {
      throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/claim-${scenario}-${theme}-${width}.png`, fullPage: true })
    return (await page.evaluate(MEASURE)) as Measure
  } finally {
    await page.close()
  }
}

const FORBIDDEN = /forzad|simulaci|override|super ?admin|Registramos la entrega|Seguimiento Andreani|Andreani informó|Resolución del reclamo|Resolución:/i

test("reemplazo entregado y reclamo resuelto: estado simple, historial plegado y sólo la conversación real", async () => {
  const data = await measure("dark", "delivered")
  assert.equal(data.tone, "done")
  assert.equal(data.statusText, "Listo Reclamo resuelto Te enviamos un producto nuevo. El reemplazo fue entregado.")
  assert.equal(data.historyOpen, false, "historial cerrado por defecto")
  assert.equal(data.historySummary, "Ver historial del reclamo")
  assert.deepEqual(data.historySteps, [
    "Reclamo recibido · 10/10/2026",
    "Reclamo aprobado · 12/10/2026",
    "Devolución lista para llevar a Andreani · 13/10/2026",
    "Producto recibido · 14/10/2026",
    "Reemplazo enviado · 15/10/2026",
    "Reemplazo entregado · 17/10/2026",
    "Reclamo resuelto · 20/10/2026",
  ])
  assert.match(data.conversationText, /El producto llegó fallado\./)
  assert.match(data.conversationText, /¡Gracias por la paciencia! Cualquier cosa nos escribís\./, "los mensajes escritos siguen visibles")
  assert.doesNotMatch(data.conversationText, /aceptó el cambio|te enviamos el reemplazo|Recibimos tu producto|resolvió el reclamo/, "sin mensajes automáticos en el chat")
  assert.doesNotMatch(data.shellText, FORBIDDEN)
  assert.equal(data.noticeText, "Si necesitás ayuda, escribinos a beyonix.ar@gmail.com")
})

test("reemplazo en camino: estado y seguimiento arriba; el número es un dato secundario copiable", async () => {
  const data = await measure("light", "transit")
  assert.equal(data.tone, "progress")
  assert.match(data.statusText, /^En curso Tu reemplazo está en camino Lo vas a retirar en una sucursal Andreani\. Te avisamos cuando llegue\. Sucursal: ROSARIO \(AV EVA PERON\) · Av\. Eva Perón 6243, Rosario Ver seguimiento Número de envío: 360003134242400 Copiar$/)
  assert.equal(data.conversationText, data.conversationText.replace(/te enviamos el reemplazo|Seguimiento Andreani/i, ""), "el chat no repite el estado")
  assert.doesNotMatch(data.shellText, FORBIDDEN)
})

test("llevar el producto a Andreani: acción clara con botones grandes", async () => {
  const data = await measure("light", "dropoff", 390)
  assert.equal(data.tone, "action")
  assert.match(data.statusText, /^Tenés que hacer algo Llevá el producto a Andreani /)
  assert.match(data.statusText, /Descargar etiqueta Ver seguimiento/)
  assert.ok(data.buttons.filter((height) => height >= 44).length >= 2, `botones grandes: ${data.buttons.join(",")}`)
})

test("rechazo: motivo una sola vez, sin repetir el cierre en el chat", async () => {
  const data = await measure("dark", "rejected")
  assert.equal(data.tone, "rejected")
  assert.equal(data.statusText, "No aprobado Tu reclamo no fue aprobado Motivo: El producto presenta daño por mal uso.")
  assert.equal(data.shellText.split("daño por mal uso").length - 1, 1)
})

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 430, 1024, 1440]) {
    test(`${theme} ${width}px: legible (AA) y sin desborde horizontal`, async () => {
      for (const scenario of ["delivered", "transit", "dropoff", "rejected"]) {
        const data = await measure(theme, scenario, width)
        assert.equal(data.overflow, false, `${scenario}: desborde horizontal`)
        assert.deepEqual(data.failures, [], `${scenario}: contraste`)
      }
    })
  }
}
