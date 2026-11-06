import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Wizard Admin de reclamos de un pedido Envío BEYONIX con los componentes
// REALES (AdminClaimManager + panel de logística) y el CSS del proyecto:
// retiro por cadete (coordinar, retirado, recepción parcial con confirmación)
// y nunca sucursales, etiquetas ni Andreani. Stubs sólo de infraestructura.

const stubs: Plugin = {
  name: "claim-local-pickup-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\/context\/auth-context$/ }, () => ({ path: "auth", namespace: "stub" }))
    pluginBuild.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: "supabase", namespace: "stub" }))
    pluginBuild.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /^auth$/, namespace: "stub" }, () => ({
      contents: `export function useAuth() { return { user: { rol: "admin" } } }`,
      loader: "js",
    }))
    pluginBuild.onLoad({ filter: /^navigation$/, namespace: "stub" }, () => ({
      contents: `const router = { push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }
        export function useRouter() { return router }
        export function usePathname() { return "/admin" }
        export function useSearchParams() { return new URLSearchParams() }`,
      loader: "js",
    }))
    pluginBuild.onLoad({ filter: /^supabase$/, namespace: "stub" }, () => ({
      contents: `
        const channel = { on() { return channel }, subscribe() { return channel } }
        export const supabase = {
          auth: { getSession: async () => ({ data: { session: { access_token: "token-de-test" } }, error: null }) },
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

const scenario = new URLSearchParams(location.search).get("scenario")
let unitId = 0
const unit = (role, location) => ({ id: ++unitId, claim_id: 900, order_item_id: 71, role, location, shipment_id: null, incident_open: false, incident_type: null })
const pickup = (status, extra = {}) => ({ id: 5, claim_id: 900, status, agreed_for: null, picked_up_at: null, received_at: null, cancelled_at: null, incident_note: null, ...extra })
const scenarios = {
  sin_metodo: { units: [], pickups: [] },
  pendiente: { units: [unit("original", "con_cliente"), unit("original", "con_cliente")], pickups: [pickup("pendiente_coordinacion")] },
  retirado: { units: [unit("original", "con_cliente"), unit("original", "con_cliente")], pickups: [pickup("retirado", { picked_up_at: "2026-11-06T13:00:00Z" })] },
  inspeccionado: {
    units: [unit("original", "reincorporada_stock"), unit("original", "baja")],
    pickups: [pickup("recibido", { picked_up_at: "2026-11-06T13:00:00Z", received_at: "2026-11-06T15:00:00Z" })],
  },
}
const data = scenarios[scenario]
const producto = { id: 1, nombre: "Auricular Ñandú", slug: "a", descripcion: null, precio: 20000, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" }
const claim = {
  id: 900, order_id: 500, user_id: "c", claim_type: "garantia_beyonix", failure_type: "falla",
  status: "aprobado", resolution: "cambio_producto", resolution_summary: null, rejection_reason: null,
  description: "Producto afectado: Auricular Ñandú\\n\\nNo enciende.",
  affected_items: [{ order_item_id: 71, quantity: 2 }],
  order_claim_messages: [], order_claim_files: [],
  order_claim_shipments: [], order_claim_units: data.units, order_claim_local_pickups: data.pickups, logistics_legacy: false,
  closed_at: null, created_at: "2026-11-05T10:00:00Z", updated_at: "2026-11-05T10:05:00Z",
}
const pedido = {
  id: 500, usuario_id: "c", estado: "entregado", delivered_at: "2026-11-04T12:00:00Z", total: 40000, created_at: "2026-11-01T12:00:00Z",
  payment_method_id: "mercadopago", shipping_type: "domicilio", shipping_provider: "beyonix", envio_proveedor: "beyonix", order_credit_notes: [],
  orden_items: [{ id: 71, orden_id: 500, producto_id: 1, cantidad: 2, precio: 20000, productos: producto }],
  order_claims: [claim],
}
window.__posts = []
window.__requests = []
window.fetch = async (input, init) => {
  const url = String(input)
  window.__requests.push(url)
  if (url.includes("/andreani-shipment?capabilities=1")) return Response.json({ testStatusEnabled: false })
  if (url.endsWith("/local-pickup") && init && init.method === "POST") {
    window.__posts.push(JSON.parse(init.body))
    await new Promise((resolve) => setTimeout(resolve, 150))
    return Response.json({ claim })
  }
  return Response.json({ error: "sin datos en el test" }, { status: 404 })
}
createRoot(document.getElementById("admin-root")).render(createElement(AdminClaimManager, {
  pedido, mode: "all", onClaimChange: () => {}, onOpenBilling: () => {}, onInventoryUpdated: () => {},
  registeredReplacements: [], replacementLoadState: "ready",
  onRegisterReplacement: (itemId) => { window.__reserved = itemId },
}))
`

const pageHtml = (css: string, bundle: string) => `<!doctype html>
<html data-admin-theme="dark"><head><style>${css}</style></head><body>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div>
  <div class="admin-order-detail-scope bx-surface bx-surface-section mx-auto flex w-full max-w-[1420px] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#05070A]">
    <div class="bx-surface-inherit min-h-0 flex-1 bg-[#05070A]">
      <div class="admin-order-detail-content min-w-0 flex-1"><div id="admin-root"></div></div>
    </div>
  </div>
</div></main></div>
<script>${bundle}</script></body></html>`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "claim-local-pickup-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(scenario: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const html = pageHtml(css, bundle)
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://localhost/claim") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort(),
  )
  await page.goto(`http://localhost/claim?scenario=${scenario}`)
  await page.waitForSelector(".admin-claim-manage-panel")
  return { page, errors }
}

const stepLabels = async (page: Page) =>
  (await page.locator(".admin-claim-wizard-step").allInnerTexts()).map((label) => label.replace(/\s+/g, " ").replace(/^[✓●○] ?/, ""))
const heading = (page: Page) => page.locator(".admin-claim-manage-heading").innerText()
const posts = (page: Page) => page.evaluate(() => (window as unknown as { __posts: Array<Record<string, unknown>> }).__posts)
const requests = (page: Page) => page.evaluate(() => (window as unknown as { __requests: string[] }).__requests)

test("Logística (Envío BEYONIX): retiro por cadete o sin devolución; nunca sucursales ni Andreani", async () => {
  const { page, errors } = await open("sin_metodo")
  try {
    assert.deepEqual(await stepLabels(page), ["1. Revisar", "2. Logística", "3. Finalizar"])
    const panel = page.locator("[data-claim-logistics-section=method]")
    assert.deepEqual(await panel.getByRole("radio").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
      ["retiro_cadete", "sin_devolucion_local"])
    assert.doesNotMatch(await panel.innerText(), /sucursal|Andreani|etiqueta/i)
    await panel.getByRole("radio", { name: /Retiro por cadete y posterior reemplazo/ }).check()
    const form = page.locator("[data-claim-local-method=retiro_cadete]")
    assert.match(await form.innerText(), /Coordinaremos con vos el retiro del producto en tu domicilio/)
    assert.equal(await page.getByRole("textbox", { name: "Buscar sucursal Andreani" }).count(), 0)
    await form.getByRole("button", { name: "Coordinar retiro por cadete" }).click()
    await page.waitForFunction(() => (window as unknown as { __posts: unknown[] }).__posts.length === 1)
    assert.deepEqual(await posts(page), [{ action: "request" }])

    // "No requiere devolución" (elegida aun con la solicitud anterior en vuelo):
    // su formulario no se cierra solo; motivo obligatorio y segunda confirmación.
    await panel.getByRole("radio", { name: /No requiere devolución/ }).check()
    const waive = page.locator("[data-claim-local-method=sin_devolucion_local]")
    const confirm = waive.getByRole("button", { name: "Confirmar sin devolución" })
    assert.equal(await confirm.isDisabled(), true)
    await waive.getByRole("textbox").fill("Producto de bajo valor: no requiere devolución")
    await confirm.click()
    await waive.getByRole("button", { name: "Sí, confirmar" }).click()
    await page.waitForFunction(() => (window as unknown as { __posts: unknown[] }).__posts.length === 2)
    assert.deepEqual((await posts(page))[1], { action: "waive", notes: "Producto de bajo valor: no requiere devolución" })
    assert.ok((await requests(page)).every((url) => !url.includes("andreani-branches")), "nunca se consultan sucursales")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Retiro pendiente: coordinar sin fecha obligatoria y marcar retirado (sin recepción ni stock)", async () => {
  const { page, errors } = await open("pendiente")
  try {
    assert.deepEqual(await stepLabels(page), ["1. Revisar", "2. Retiro", "3. Inspección", "4. Entrega", "5. Finalizar"])
    assert.equal(await heading(page), "Retiro")
    const pickup = page.locator("[data-claim-local-pickup]")
    assert.match(await pickup.innerText(), /Retiro por cadete:\s*Pendiente de coordinación/)
    const actions = pickup.locator("[data-claim-local-pickup-actions]")
    assert.deepEqual((await actions.getByRole("button").allInnerTexts()).map((text) => text.trim()),
      ["Marcar como retirado", "Registrar fecha acordada", "Retiro fallido", "Cancelar retiro"])
    assert.equal(await page.getByRole("button", { name: "Confirmar recepción" }).count(), 0, "sin retirar no se recibe")
    assert.doesNotMatch(await page.locator("[data-claim-logistics]").first().innerText(), /Andreani|sucursal|etiqueta/i)

    await actions.getByRole("button", { name: "Marcar como retirado" }).click()
    const form = pickup.locator("[data-claim-local-pickup-form=collected]")
    assert.match(await form.innerText(), /No es la recepción en BEYONIX/)
    await form.getByRole("textbox").fill("Retiró Juan en moto")
    await form.getByRole("button", { name: "Guardar" }).click()
    await page.waitForFunction(() => (window as unknown as { __posts: unknown[] }).__posts.length === 1)
    assert.deepEqual(await posts(page), [{ action: "collected", notes: "Retiró Juan en moto" }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Retirado: recepción parcial con cantidades por producto, confirmación explícita y un solo envío ante doble clic", async () => {
  const { page, errors } = await open("retirado")
  try {
    const pickup = page.locator("[data-claim-local-pickup]")
    assert.match(await pickup.innerText(), /Retirado por cadete/)
    assert.match(await pickup.innerText(), /todavía no llegó a BEYONIX/)
    assert.equal(await pickup.getByRole("button", { name: "Cancelar retiro" }).count(), 0, "retirado: ya no se cancela")
    await pickup.getByRole("button", { name: "Confirmar recepción" }).click()
    const item = pickup.locator("[data-claim-local-reception-item='71']")
    assert.match(await item.innerText(), /Auricular Ñandú[\s\S]*Esperadas: 2/)
    const received = item.getByRole("spinbutton", { name: /Unidades recibidas/ })
    assert.equal(await received.inputValue(), "2")
    await received.fill("5")
    assert.equal(await received.inputValue(), "2", "nunca más que lo esperado")
    await received.fill("1")
    const submit = pickup.getByRole("button", { name: "Confirmar recepción" })
    await submit.click()
    assert.match(await pickup.locator("[data-claim-local-reception-confirm]").innerText(), /1 de 2 unidades esperadas[\s\S]*el resto queda pendiente[\s\S]*pendientes de inspección/)
    const confirm = pickup.getByRole("button", { name: "Sí, confirmar" })
    await confirm.dblclick()
    await page.waitForFunction(() => (window as unknown as { __posts: unknown[] }).__posts.length >= 1)
    await page.waitForTimeout(400)
    const sent = await posts(page)
    assert.equal(sent.length, 1, "doble clic: una sola recepción")
    const [reception] = sent as Array<{ action: string; items: unknown; idempotencyKey: string }>
    assert.equal(reception.action, "receive")
    assert.deepEqual(reception.items, [{ orderItemId: 71, quantity: 1 }])
    assert.match(reception.idempotencyKey, /^[A-Za-z0-9._:-]{8,200}$/)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Recibido e inspeccionado: Entrega del reemplazo (reservar) sin Andreani", async () => {
  const { page, errors } = await open("inspeccionado")
  try {
    assert.equal(await heading(page), "Entrega")
    const reserve = page.getByRole("button", { name: "Reservar reemplazo", exact: true })
    assert.equal(await reserve.isDisabled(), false)
    await reserve.click()
    assert.equal(await page.evaluate(() => (window as unknown as { __reserved: number | null }).__reserved), 71)
    assert.doesNotMatch(await page.locator("[data-claim-logistics]").first().innerText(), /Andreani|sucursal/i)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
