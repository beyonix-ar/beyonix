import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Cuenta cliente con los componentes REALES (detalle de compra y Mis compras):
// un pedido Envío BEYONIX con TODOS los residuos Andreani posibles muestra sólo
// Preparando → En camino → Entregado según su estado local; Andreani moderno y
// legacy (sin shipping_provider) conservan su seguimiento. Light/Dark,
// escritorio y teléfono. CUSTOMER_SCREENSHOTS_DIR=<dir> guarda capturas.

const stubs: Plugin = {
  name: "customer-local-delivery-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `export function useAuth() { return { user: { id: "customer-1", email: "cliente@example.test" }, isLoading: false } }`,
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: 0, loading: false } }`,
      "next/navigation": `const router = { push(url) { (window.__pushes ||= []).push(url) }, replace() {}, refresh() {}, back() {}, prefetch() {} }
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
import { CompraAyudaClient, CompraDetalleClient } from "@/app/cuenta/cuenta-client"
import { MisOrdenes } from "@/components/account/account-orders"
const params = new URLSearchParams(location.search)
const paid = { payment_status: "approved", payment_method_id: "mercadopago", financial_status: "payment_confirmed", paid_at: "2026-11-03T12:05:00Z", total: 45000 }
const base = (id, extra) => ({ id, usuario_id: "customer-1", created_at: "2026-11-03T12:00:00Z", cliente_nombre: "María José Peña",
  cliente_direccion: "Córdoba 1234. Referencias: Portón verde", localidad: "Rosario", provincia: "Santa Fe", cp_destino: "2000",
  orden_items: [{ id, orden_id: id, producto_id: 9, cantidad: 1, precio: 45000, productos: { nombre: "Trípode Ñandú" } }],
  order_audit_events: [], order_claims: [], ...paid, ...extra })
// Todos los residuos Andreani posibles sobre un pedido Envío BEYONIX.
const RESIDUE = { shipping_provider: "beyonix", shipping_type: "sucursal", dispatch_progress: "dispatched",
  andreani_tracking: "360000009999", andreani_estado: "Entregado", tracking_number: "TRK-RESIDUAL",
  tracking_url: "https://www.andreani.com/?tab=seguir-envio", andreani_sucursal_nombre: "Sucursal Rosario Centro",
  andreani_sucursal_direccion: "San Lorenzo 1000", andreani_sucursal_localidad: "Rosario", andreani_sucursal_provincia: "Santa Fe", andreani_sucursal_cp: "2000" }
const orders = {
  601: base(601, { ...RESIDUE, estado: "pagado", dispatch_cutoff_reached: false }),
  602: base(602, { ...RESIDUE, estado: "en_camino", dispatch_cutoff_reached: true }),
  603: base(603, { ...RESIDUE, estado: "entregado", delivered_at: "2026-11-04T15:00:00Z", dispatch_cutoff_reached: true }),
  // Andreani moderno y legacy (sin shipping_provider): su seguimiento sigue igual.
  611: base(611, { shipping_provider: "andreani", shipping_type: "domicilio", estado: "en_camino", andreani_tracking: "360000000611", andreani_estado: "En distribución", dispatch_progress: "dispatched", dispatch_cutoff_reached: true }),
  612: base(612, { shipping_provider: null, envio_proveedor: null, shipping_type: "domicilio", estado: "enviado", andreani_tracking: "360000000612", andreani_estado: "En distribución", dispatch_cutoff_reached: true }),
  // Resultado del cadete (QR): el pedido sigue "en_camino" y el resumen local llega calculado por el servidor.
  621: base(621, { shipping_provider: "beyonix", estado: "en_camino", dispatch_cutoff_reached: true, local_delivery_outcome: { status: "first_attempt_failed", failedAttempts: 1, reservation: null } }),
  622: base(622, { shipping_provider: "beyonix", estado: "en_camino", dispatch_cutoff_reached: true, local_delivery_outcome: { status: "returning", failedAttempts: 2, reservation: null } }),
  623: base(623, { shipping_provider: "beyonix", estado: "en_camino", dispatch_cutoff_reached: true, local_delivery_outcome: { status: "returned", failedAttempts: 2, reservation: { status: "active", expiresAt: "2026-11-09T03:00:00.000Z" } } }),
  624: base(624, { shipping_provider: "beyonix", estado: "en_camino", dispatch_cutoff_reached: true, local_delivery_outcome: { status: "returned", failedAttempts: 2, reservation: { status: "expired", expiresAt: "2026-11-03T03:00:00.000Z" } } }),
}
window.fetch = async (input) => {
  const url = String(input)
  if (url === "/api/orders") return Response.json({ server_now: "2026-11-04T16:00:00Z", orders: Object.values(orders) })
  const match = url.match(/^\\/api\\/orders\\/(\\d+)$/)
  if (match && orders[match[1]]) return Response.json({ order: orders[match[1]], server_now: "2026-11-04T16:00:00Z" })
  if (/\\/claims$/.test(url)) return Response.json({ claims: [] })
  return Response.json({ error: "Sin datos" }, { status: 404 })
}
const root = createRoot(document.getElementById("root"))
const view = params.get("view")
root.render(view === "list" ? createElement(MisOrdenes, { onBack() {} })
  : view === "help" ? createElement(CompraAyudaClient, { orderId: Number(params.get("order")) })
  : createElement(CompraDetalleClient, { orderId: Number(params.get("order")) }))
`

let browser: Browser
let css: string
let bundle: string
const screenshotsDir = process.env.CUSTOMER_SCREENSHOTS_DIR

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "customer-local-delivery-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://x.invalid"', "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"k"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  if (screenshotsDir) mkdirSync(screenshotsDir, { recursive: true })
})

test.after(async () => { await browser?.close() })

async function open(query: string, theme: "dark" | "light", width: number, ready: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  page.on("requestfailed", (request) => errors.push(`requestfailed ${request.url()}`))
  const html = `<!doctype html><html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>window.process = { env: {} }</script><script>${bundle}</script></body></html>`
  await page.route("**/*", (route) => {
    const url = route.request().url()
    if (url.startsWith("http://localhost/cuenta")) return route.fulfill({ contentType: "text/html", body: html })
    // Sin servidor Next: next/image (ícono de BEYONIX) recibe un PNG vacío.
    if (url.startsWith("http://localhost/_next/image")) return route.fulfill({ contentType: "image/png", body: Buffer.from(EMPTY_PNG, "base64") })
    return route.abort()
  })
  await page.goto(`http://localhost/cuenta?${query}`)
  await page.getByText(ready).first().waitFor({ timeout: 15000 }).catch(async (error) => {
    throw new Error(`${error}\nerrores: ${errors.join(" | ")}\ntexto: ${(await page.locator("body").innerText()).slice(0, 600)}`)
  })
  return { page, errors }
}

const EMPTY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const ANDREANI_RESIDUE =/Andreani|Sucursal|San Lorenzo 1000|360000009999|TRK-RESIDUAL|Ver seguimiento|Seguimiento no disponible|Despachado|retir/i

for (const [orderId, estado, current] of [[601, "pagado", "Preparando"], [602, "en_camino", "En camino"], [603, "entregado", "Entregado"]] as const) {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 390]) {
      test(`detalle BEYONIX ${estado} con residuos Andreani (${theme}, ${width}px): sólo etapas locales, sin seguimiento ni sucursal`, async () => {
        const { page, errors } = await open(`order=${orderId}`, theme, width, "Productos comprados")
        try {
          const text = await page.locator("body").innerText()
          assert.doesNotMatch(text, ANDREANI_RESIDUE)
          assert.equal(await page.locator("a[href*='andreani']").count(), 0, "sin URL Andreani")
          for (const step of ["Preparando", "En camino", "Entregado"]) assert.match(text, new RegExp(step))
          // Etapa actual del timeline (círculo azul) o, entregado, todo completo (círculo verde).
          // (Sin funciones con nombre dentro de evaluate: tsx les agrega un helper que el navegador no tiene.)
          const timeline = await page.locator("section").filter({ has: page.locator("p", { hasText: /^Estado del pedido$/i }) }).first().evaluate((section) => {
            const result: { current: string[]; done: string[] } = { current: [], done: [] }
            for (const [key, selector] of [["current", "[class*='bg-beyonix-blue-700']"], ["done", "[class*='account-success-bg']"]] as const) {
              for (const circle of section.querySelectorAll(selector)) {
                let node: Element | null = circle
                while (node && !/[a-z]/i.test(node.textContent ?? "")) node = node.parentElement
                result[key].push(node?.textContent ?? "")
              }
            }
            return result
          })
          if (estado === "entregado") assert.ok(timeline.done.some((step) => step.includes(current)) && timeline.current.length === 0, JSON.stringify(timeline))
          else assert.ok(timeline.current.length === 1 && timeline.current[0].includes(current), JSON.stringify(timeline))
          if (estado !== "entregado") assert.match(text, /Envío BEYONIX: entrega local, sin número de seguimiento\./)
          assert.deepEqual(errors, [])
          if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `cuenta-beyonix-${estado}-${theme}-${width}.png`), fullPage: true })
        } finally { await page.close() }
      })
    }
  }
}

test("Mis compras: BEYONIX con residuos muestra su etapa local sin tracking; Andreani moderno y legacy conservan el seguimiento", async () => {
  for (const theme of ["light", "dark"] as const) {
    const { page, errors } = await open("view=list", theme, 1280, "Ver compra")
    try {
      // Texto de cada tarjeta: desde su "Pedido #BX-…" hasta el siguiente.
      const cards = new Map((await page.locator("body").innerText()).split("Pedido #BX-").slice(1).map((chunk) => [Number(chunk.slice(0, 4)) - 1000, chunk]))
      const card = (id: number) => cards.get(id) ?? ""
      for (const [id, label] of [[601, "Preparando"], [602, "En camino"], [603, "Entregado"]] as const) {
        assert.match(card(id), new RegExp(`ENVÍO\\s+${label}`, "i"), `${id}`)
        assert.doesNotMatch(card(id), ANDREANI_RESIDUE, `${id}`)
      }
      assert.match(card(602), /Tu pedido está en camino/, "sin 'Te avisaremos cuando…' contradictorio")
      assert.match(card(611), /360000000611/)
      assert.match(card(612), /360000000612/)
      assert.deepEqual(errors, [])
      if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `cuenta-mis-compras-${theme}.png`), fullPage: true })
    } finally { await page.close() }
  }
})

test("detalle Andreani moderno y legacy: número de seguimiento y botón Ver seguimiento intactos", async () => {
  for (const [orderId, tracking] of [[611, "360000000611"], [612, "360000000612"]] as const) {
    const { page, errors } = await open(`order=${orderId}`, "light", 1280, "Productos comprados")
    try {
      const text = await page.locator("body").innerText()
      assert.match(text, new RegExp(tracking))
      assert.equal(await page.getByRole("link", { name: /Ver seguimiento del pedido/ }).count(), 1)
      assert.doesNotMatch(text, /entrega local, sin número de seguimiento/)
      assert.deepEqual(errors, [])
      if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `cuenta-andreani-${orderId}.png`), fullPage: true })
    } finally { await page.close() }
  }
})

test("Ayuda/reclamo del cliente: un BEYONIX con tracking Andreani residual nunca muestra 'Seguimiento' del envío original", async () => {
  for (const [orderId, theme] of [[601, "light"], [602, "dark"], [603, "light"]] as const) {
    const { page, errors } = await open(`view=help&order=${orderId}`, theme, 1280, "Volver a la compra")
    await page.waitForLoadState("networkidle")
    if (orderId === 601) assert.match(await page.locator("body").innerText(), /Cancelar compra/, "Preparando con residuos: se puede cancelar")
    try {
      const text = await page.locator("body").innerText()
      assert.doesNotMatch(text, /Seguimiento:|360000009999|TRK-RESIDUAL|Andreani|Sucursal/i, String(orderId))
      assert.equal(await page.locator("a[href*='andreani']").count(), 0)
      assert.deepEqual(errors, [])
      if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `ayuda-beyonix-${orderId}-${theme}.png`), fullPage: true })
    } finally { await page.close() }
  }
})

// ── Resultado de la entrega local (QR del cadete) ────────────────────────────

const OUTCOME_CASES = [
  { id: 621, name: "primer-intento", texts: [
    "El cadete visitó tu domicilio, pero no pudo concretar la entrega porque no había nadie presente.",
    "Realizaremos un segundo intento de entrega.",
    "Si en el segundo intento tampoco podemos completar la entrega, el pedido regresará a BEYONIX y, para coordinar un nuevo envío, deberás abonar nuevamente el costo de entrega correspondiente.",
  ], contact: false },
  { id: 622, name: "regresando", texts: [
    "Regresando a BEYONIX",
    "Realizamos un segundo intento de entrega y nuevamente no pudimos encontrar a nadie en el domicilio.",
    "El pedido regresará a BEYONIX.",
    "Para coordinar un nuevo envío, deberás abonar nuevamente el costo de entrega correspondiente.",
  ], contact: false },
  { id: 623, name: "devuelto-reserva-activa", texts: [
    "Tu pedido regresó a BEYONIX.",
    "Mantendremos tus productos reservados hasta el 09/11.",
    "Para solicitar un nuevo envío, contactanos antes de esa fecha.",
    "El nuevo envío tendrá costo.",
  ], contact: true },
  { id: 624, name: "devuelto-reserva-vencida", texts: [
    "Tu pedido regresó a BEYONIX.",
    "La reserva de los productos venció y la disponibilidad deberá confirmarse nuevamente.",
  ], contact: true },
] as const

for (const item of OUTCOME_CASES) {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 360]) {
      test(`detalle BEYONIX ${item.name} (${theme}, ${width}px): aviso formal${item.contact ? " y Contactar a BEYONIX" : ""}`, async () => {
        const { page, errors } = await open(`order=${item.id}`, theme, width, "Productos comprados")
        try {
          const notice = page.locator("[data-local-delivery-outcome]")
          assert.equal(await notice.count(), 1)
          const text = await notice.innerText()
          for (const expected of item.texts) assert.ok(text.includes(expected), `${item.name}: ${expected}\n${text}`)
          // Nunca códigos técnicos, cálculos ni datos del cadete.
          assert.doesNotMatch(text, /72 ?h|horas|incident|returning|token|00:00/i)
          const contact = page.getByRole("button", { name: /Contactar a BEYONIX/ })
          assert.equal(await contact.count(), item.contact ? 1 : 0)
          if (item.contact) {
            // Mismo chat de ayuda del pedido (sin duplicar el bloque genérico "¿Necesitás ayuda?").
            assert.equal(await page.getByText("¿Necesitás ayuda?").count(), 0)
            await contact.click()
            assert.deepEqual(await page.evaluate(() => (window as unknown as { __pushes?: string[] }).__pushes), [`/cuenta/compras/${item.id}/ayuda`])
          }
          // El aviso entra en el ancho del teléfono sin desbordar.
          const overflow = await notice.evaluate((element) => element.scrollWidth > element.clientWidth + 1)
          assert.equal(overflow, false)
          assert.deepEqual(errors, [])
          if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `cuenta-beyonix-${item.name}-${theme}-${width}.png`), fullPage: true })
        } finally { await page.close() }
      })
    }
  }
}

test("Mis compras: la tarjeta muestra el estado del resultado local (intento fallido, regresando, devuelto)", async () => {
  const { page, errors } = await open("view=list", "light", 1280, "Ver compra")
  try {
    const cards = new Map((await page.locator("body").innerText()).split("Pedido #BX-").slice(1).map((chunk) => [Number(chunk.slice(0, 4)) - 1000, chunk]))
    assert.match(cards.get(621) ?? "", /Intento de entrega fallido/)
    assert.match(cards.get(622) ?? "", /Regresando a BEYONIX/)
    assert.match(cards.get(623) ?? "", /Devuelto a BEYONIX/)
    assert.match(cards.get(624) ?? "", /Devuelto a BEYONIX/)
    assert.deepEqual(errors, [])
    if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, "cuenta-mis-compras-resultado-local.png"), fullPage: true })
  } finally { await page.close() }
})
