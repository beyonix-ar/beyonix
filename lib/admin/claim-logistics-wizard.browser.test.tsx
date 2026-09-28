import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Wizard Admin de reclamos con logística por sucursal, con los componentes
// REALES (AdminClaimManager + panel de logística) y el CSS del proyecto:
// paso "Método" con radios accesibles, volver atrás sin / con efectos reales,
// buscador de sucursales y recepción compacta con ayudas (?).
// Stubs sólo de infraestructura: auth, Supabase, router y fetch (sin red ni Andreani).

const stubs: Plugin = {
  name: "claim-logistics-stubs",
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
const unit = (role, location, shipment_id = null) => ({ id: ++unitId, claim_id: 900, order_item_id: 71, role, location, shipment_id, incident_open: false, incident_type: null })
const leg = (overrides) => ({
  id: 1, claim_id: 900, direction: "cambio", attempt: 1, status: "pendiente", creation_status: "not_started", closed_at: null,
  branch_id: "4567", branch_name: "Sucursal Once", branch_address: "Av. Pueyrredón 100", legacy: false, ...overrides,
})
const scenarios = {
  sin_metodo: { shipments: [], units: [unit("original", "con_cliente")] },
  cambio_libre: { shipments: [leg({})], units: [unit("original", "con_cliente")] },
  cambio_generado: {
    shipments: [leg({ status: "generada", creation_status: "created", modality: "cambio_sucursal", andreani_tracking: "360000000801" })],
    units: [unit("original", "con_cliente", 1), unit("reemplazo", "reservada", 1)],
  },
  cambio_fallido: {
    shipments: [leg({ status: "en_sucursal", creation_status: "created", modality: "cambio_sucursal", exchange_outcome: "no_completado", closed_at: "2026-09-25T00:00:00Z" })],
    units: [unit("original", "con_cliente"), unit("reemplazo", "reincorporada_stock", 1)],
  },
  recepcion: {
    shipments: [leg({ direction: "devolucion", status: "entregada", creation_status: "created", modality: "despacho_sucursal", closed_at: "2026-09-25T00:00:00Z" })],
    units: [unit("original", "recibida_beyonix", 1)],
  },
}
const data = scenarios[scenario]
const producto = { id: 1, nombre: "Auricular Ñandú", slug: "a", descripcion: null, precio: 20000, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" }
const claim = {
  id: 900, order_id: 500, user_id: "c", claim_type: "garantia_beyonix", failure_type: "falla",
  status: "aprobado", resolution: "cambio_producto", resolution_summary: null, rejection_reason: null,
  description: "Producto afectado: Auricular Ñandú\\n\\nNo enciende.",
  affected_items: [{ order_item_id: 71, quantity: 1 }],
  order_claim_messages: [], order_claim_files: [],
  order_claim_shipments: data.shipments, order_claim_units: data.units, logistics_legacy: false,
  closed_at: null, created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-21T10:05:00Z",
}
const pedido = {
  id: 500, usuario_id: "c", estado: "entregado", delivered_at: "2026-09-18T12:00:00Z", total: 20000, created_at: "2026-09-15T12:00:00Z",
  payment_method_id: "mercadopago", shipping_type: "domicilio", order_credit_notes: [],
  orden_items: [{ id: 71, orden_id: 500, producto_id: 1, cantidad: 1, precio: 20000, productos: producto }],
  order_claims: [claim],
}
const branch = { id: "4567", name: "Sucursal Once", address: "Av. Pueyrredón 100", locality: "CABA", province: "Buenos Aires", postalCode: "1032" }
window.__posts = []
window.__claimChanges = 0
window.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes("/andreani-branches?")) {
    return url.includes("q=") ? Response.json({ branches: [branch] }) : Response.json({ branches: [], suggested: null })
  }
  if (url.endsWith("/andreani-shipment") && init && init.method === "POST") {
    window.__posts.push(JSON.parse(init.body))
    return Response.json({ claim })
  }
  return Response.json({ error: "sin datos en el test" }, { status: 404 })
}
createRoot(document.getElementById("admin-root")).render(createElement(AdminClaimManager, {
  pedido, mode: "all", onClaimChange: () => { window.__claimChanges += 1 }, onOpenBilling: () => {}, onInventoryUpdated: () => {},
  registeredReplacements: [], replacementLoadState: "ready",
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
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "claim-logistics-entry.tsx" },
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

async function open(scenario: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } })
  const html = pageHtml(css, bundle)
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://localhost/claim") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort(),
  )
  await page.goto(`http://localhost/claim?scenario=${scenario}`)
  await page.waitForSelector(".admin-claim-manage-panel")
  return page
}

const heading = (page: Page) => page.locator(".admin-claim-manage-heading").innerText()
const methodPanel = "[data-claim-logistics-section=method]"
const radio = (page: Page, name: RegExp) => page.locator(methodPanel).getByRole("radio", { name })
const posts = (page: Page) => page.evaluate(() => (window as unknown as { __posts: Array<Record<string, unknown>> }).__posts)

async function pickBranch(page: Page) {
  await page.getByRole("textbox", { name: "Buscar sucursal Andreani" }).fill("Once")
  await page.getByRole("button", { name: "Buscar" }).click()
  await page.locator("[data-claim-logistics-branches] button").first().click()
}

test("sin método: paso 'Método' con radios; elegir muestra SOLO ese formulario; sucursal obligatoria; cancelar limpia", async () => {
  const page = await open("sin_metodo")
  try {
    assert.equal(await heading(page), "Método")
    const steps = (await page.locator(".admin-claim-wizard-step").allInnerTexts()).map((label) => label.replace(/\s+/g, " ").replace(/^[✓●○] ?/, ""))
    assert.deepEqual(steps, ["1. Revisión", "2. Método", "3. Finalización"])
    assert.equal(await page.locator("[data-claim-logistics-request]").count(), 0, "sin selección no hay formulario")
    assert.equal(await radio(page, /Cambio directo por sucursal/).isChecked(), false)

    // Ayudas (?) con los textos pedidos, accesibles por teclado.
    const help = page.getByRole("button", { name: "Ayuda: Cambio directo por sucursal" })
    await help.focus()
    const bubble = page.locator(`[id="${await help.getAttribute("aria-describedby")}"]`)
    assert.equal(await bubble.isVisible(), true)
    assert.match(await bubble.innerText(), /Andreani lo entrega en la sucursal solo si el cliente entrega el producto original/)
    const retiroHelp = page.getByRole("button", { name: "Ayuda: Retiro + revisión + reenvío" })
    assert.match(await page.locator(`[id="${await retiroHelp.getAttribute("aria-describedby")}"]`).textContent() ?? "",
      /BEYONIX lo recibe e inspecciona y recién después se decide y envía el reemplazo/)

    await radio(page, /Cambio directo por sucursal/).check()
    await page.waitForSelector("[data-claim-logistics-request=cambio]")
    assert.equal(await page.locator("[data-claim-logistics-request]").count(), 1, "sólo el formulario elegido")
    const confirm = page.getByRole("button", { name: "Confirmar cambio" })
    assert.equal(await confirm.isDisabled(), true, "sin sucursal no se continúa")
    assert.match(await page.locator("[data-claim-logistics-branch]").innerText(), /Elegí una sucursal Andreani/)
    await pickBranch(page)
    assert.match(await page.locator("[data-claim-logistics-branch]").innerText(), /Sucursal Once · Av\. Pueyrredón 100/)
    assert.equal(await confirm.isDisabled(), false)

    await page.getByRole("button", { name: "Cancelar" }).click()
    assert.equal(await page.locator("[data-claim-logistics-request]").count(), 0)
    assert.equal(await radio(page, /Cambio directo por sucursal/).isChecked(), false)
    assert.equal((await posts(page)).length, 0, "cancelar no envía nada")
  } finally { await page.close() }
})

test("teclado: flechas entre métodos cambian el formulario ('Confirmar retiro'); confirmar envía sólo el id de sucursal", async () => {
  const page = await open("sin_metodo")
  try {
    await radio(page, /Cambio directo por sucursal/).focus()
    await page.keyboard.press("Space")
    await page.waitForSelector("[data-claim-logistics-request=cambio]")
    await page.keyboard.press("ArrowDown")
    await page.waitForSelector("[data-claim-logistics-request=devolucion]")
    assert.equal(await radio(page, /Retiro \+ revisión \+ reenvío/).isChecked(), true)
    assert.equal(await page.locator("[data-claim-logistics-request=cambio]").count(), 0)
    await pickBranch(page)
    await page.getByRole("button", { name: "Confirmar retiro" }).click()
    await page.waitForFunction(() => (window as unknown as { __posts: unknown[] }).__posts.length === 1)
    assert.deepEqual(await posts(page), [{ action: "request", direction: "devolucion", branchId: "4567" }],
      "nombre/dirección nunca salen del navegador")
  } finally { await page.close() }
})

test("volver al paso anterior sin efectos reales: desde 'Reserva' vuelve a 'Método' y el método se corrige sin motivo", async () => {
  const page = await open("cambio_libre")
  try {
    assert.equal(await heading(page), "Reserva")
    await page.getByRole("button", { name: "Volver al paso anterior" }).click()
    assert.equal(await heading(page), "Método")
    assert.match(await page.locator("[data-claim-method-lock]").innerText(), /Todavía no hay operaciones reales/)
    assert.equal(await radio(page, /Cambio directo por sucursal/).isDisabled(), true, "el vigente no se vuelve a elegir")
    assert.match(await page.locator("[data-claim-logistics-method=cambio]").innerText(), /Actual/i)
    await radio(page, /Retiro \+ revisión \+ reenvío/).check()
    await page.waitForSelector("[data-claim-logistics-request=devolucion]")
    assert.match(await page.locator("[data-claim-logistics-request=devolucion]").innerText(), /Motivo \(opcional\)/)
    await pickBranch(page)
    await page.getByRole("button", { name: "Confirmar retiro" }).click()
    await page.waitForFunction(() => (window as unknown as { __posts: unknown[] }).__posts.length === 1)
    // Corregido el método, el wizard vuelve al paso vigente.
    await page.waitForFunction(() => document.querySelector(".admin-claim-manage-heading")?.textContent === "Reserva")
  } finally { await page.close() }
})

test("volver con operación Andreani generada: se ven los efectos reales y el método queda bloqueado (corrección auditada)", async () => {
  const page = await open("cambio_generado")
  try {
    assert.equal(await heading(page), "Cambio en sucursal")
    await page.getByRole("button", { name: /2\. Método/ }).click()
    assert.equal(await heading(page), "Método")
    const lock = await page.locator("[data-claim-method-lock=blocked]").innerText()
    assert.match(lock, /El método no se puede cambiar directamente/)
    assert.match(lock, /Operación generada: Cambio en sucursal Andreani \(360000000801\)/)
    assert.match(lock, /Stock reservado para el reemplazo: 1 unidad/)
    assert.match(lock, /primero cancelá la operación Andreani con un motivo/)
    assert.equal(await radio(page, /Retiro \+ revisión \+ reenvío/).isDisabled(), true)
    assert.equal(await radio(page, /Cambio directo por sucursal/).isDisabled(), true)
    assert.equal(await page.locator("[data-claim-logistics-request]").count(), 0)
  } finally { await page.close() }
})

test("con operación real previa (cambio no completado): corregir el método exige motivo y segunda confirmación", async () => {
  const page = await open("cambio_fallido")
  try {
    await page.getByRole("button", { name: /2\. Método/ }).click()
    assert.match(await page.locator("[data-claim-method-lock=reason]").innerText(), /requiere motivo y queda auditado/)
    await radio(page, /Retiro \+ revisión \+ reenvío/).check()
    await page.waitForSelector("[data-claim-logistics-request=devolucion]")
    await pickBranch(page)
    const confirm = page.getByRole("button", { name: "Confirmar retiro" })
    assert.equal(await confirm.isDisabled(), true, "motivo obligatorio")
    await page.locator("[data-claim-logistics-request] textarea").fill("Cliente no pudo ir a la sucursal")
    await confirm.click()
    assert.match(await page.locator("[data-claim-logistics-request] [role=alert]").innerText(), /queda auditado/)
    assert.equal((await posts(page)).length, 0, "el primer click sólo pide confirmación")
    await page.getByRole("button", { name: "Sí, confirmar" }).click()
    await page.waitForFunction(() => (window as unknown as { __posts: unknown[] }).__posts.length === 1)
    assert.equal((await posts(page))[0].notes, "Cliente no pudo ir a la sucursal")
  } finally { await page.close() }
})

test("recepción compacta: resumen de logística + recepción del original con ayudas (?) de stock y baja", async () => {
  const page = await open("recepcion")
  try {
    assert.equal(await heading(page), "Retiro e inspección")
    const summary = (await page.locator("[data-claim-logistics-summary] dt").allInnerTexts()).map((label) => label.trim().toLowerCase())
    assert.deepEqual(summary, ["método", "sucursal", "andreani", "inspección", "incidencias", "intervención manual"])
    assert.equal(await page.locator(`${methodPanel}`).count(), 0, "el método se revisa en su propio paso")
    assert.match(await page.locator("[data-claim-logistics-next]").innerText(), /Acción recomendada:/)
    const reception = page.locator(".admin-claim-reception-panel")
    assert.equal(await reception.getByText("Registrá cómo volvió el producto", { exact: false }).isVisible(), false, "la explicación vive en el (?)")
    for (const [label, text] of [
      ["Volver al stock", "Usar solo si el producto está en buen estado y puede venderse nuevamente."],
      ["Dar de baja", "Usar si el producto está dañado o no es apto para venta."],
    ]) {
      const trigger = reception.getByRole("button", { name: `Ayuda: ${label}` })
      assert.equal(await page.locator(`[id="${await trigger.getAttribute("aria-describedby")}"]`).textContent(), text)
    }
    assert.equal(await reception.getByRole("button", { name: "Confirmar recepción" }).isDisabled(), true, "sin elegir destino no se confirma")
    await reception.getByRole("button", { name: "Volver al stock", exact: true }).click()
    assert.equal(await reception.getByRole("button", { name: "Confirmar recepción" }).isDisabled(), false)
    const box = await reception.boundingBox()
    assert.ok(box && box.height < 520, `recepción compacta (alto ${box?.height})`)
  } finally { await page.close() }
})
