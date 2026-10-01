import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Wizard Admin de reclamos con logística por sucursal, con los componentes
// REALES (AdminClaimManager + panel de logística) y el CSS del proyecto:
// un paso por concepto (Revisión, Método, operación Andreani, Recepción,
// Reenvío, Finalización), Revisión editable al volver atrás, sucursal sugerida
// por el servidor, acciones de recepción visibles (sin desplegable) y legacy.
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
  sugerida: { shipments: [], units: [unit("original", "con_cliente")] },
  cancel_bloqueado_servidor: { shipments: [], units: [unit("original", "con_cliente")] },
  cambio_libre: { shipments: [leg({})], units: [unit("original", "con_cliente")] },
  cambio_reservado: { shipments: [leg({})], units: [unit("original", "con_cliente"), unit("reemplazo", "reservada")] },
  retiro_pendiente: { shipments: [leg({ direction: "devolucion" })], units: [unit("original", "con_cliente")] },
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
  en_camino: {
    shipments: [leg({ direction: "devolucion", status: "en_transito", creation_status: "created", modality: "despacho_sucursal", andreani_tracking: "360000000802" })],
    units: [unit("original", "en_andreani", 1)],
  },
  rechazado: {
    shipments: [], units: [unit("original", "conservada_cliente")],
    claim: { status: "rechazado", resolution: "rechazado", rejection_reason: "No corresponde: daño por mal uso.", closed_at: "2026-09-22T10:00:00Z" },
  },
  legacy: { shipments: [], units: [], claim: { logistics_legacy: true } },
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
  ...(data.claim ?? {}),
}
const pedido = {
  id: 500, usuario_id: "c", estado: "entregado", delivered_at: "2026-09-18T12:00:00Z", total: 20000, created_at: "2026-09-15T12:00:00Z",
  payment_method_id: "mercadopago", shipping_type: "domicilio", order_credit_notes: [],
  orden_items: [{ id: 71, orden_id: 500, producto_id: 1, cantidad: 1, precio: 20000, productos: producto }],
  order_claims: [claim],
}
const branch = { id: "4567", name: "Sucursal Once", address: "Av. Pueyrredón 100", locality: "CABA", province: "Buenos Aires", postalCode: "1032" }
const rosario = { id: "10179", name: "ROSARIO (AV EVA PERON)", address: "Av. Eva Perón 6243", locality: "Rosario", province: "Santa Fe", postalCode: "2000" }
window.__posts = []
window.__patches = []
window.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes("/andreani-branches?")) {
    return url.includes("q=") ? Response.json({ branches: [branch] }) : Response.json({ branches: [], suggested: scenario === "sugerida" ? rosario : null })
  }
  if (url.endsWith("/andreani-shipment") && init && init.method === "POST") {
    window.__posts.push(JSON.parse(init.body))
    return Response.json({ claim })
  }
  if (url.endsWith("/api/admin/order-claims/900") && init && init.method === "PATCH") {
    window.__patches.push(JSON.parse(init.body))
    if (scenario === "cancel_bloqueado_servidor") {
      return Response.json({ error: "No se puede cancelar todavía.", blockers: ["Hay un problema abierto."], blockerCodes: ["incident"] }, { status: 409 })
    }
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
const stepLabels = async (page: Page) =>
  (await page.locator(".admin-claim-wizard-step").allInnerTexts()).map((label) => label.replace(/\s+/g, " ").replace(/^[✓●○] ?/, ""))
const methodPanel = "[data-claim-logistics-section=method]"
const radio = (page: Page, name: RegExp) => page.locator(methodPanel).getByRole("radio", { name })
const posts = (page: Page) => page.evaluate(() => (window as unknown as { __posts: Array<Record<string, unknown>> }).__posts)
const patches = (page: Page) => page.evaluate(() => (window as unknown as { __patches: Array<Record<string, unknown>> }).__patches)
const back = (page: Page) => page.getByRole("button", { name: "Volver al paso anterior" }).click()
const reviewButton = (page: Page, name: RegExp) => page.locator("[data-claim-review]").getByRole("button", { name })

async function pickBranch(page: Page) {
  await page.getByRole("textbox", { name: "Buscar sucursal Andreani" }).fill("Once")
  await page.getByRole("button", { name: "Buscar" }).click()
  await page.locator("[data-claim-logistics-branches] button").first().click()
}

test("pasos: nombres de negocio en el orden real de cada método", async () => {
  const cases: Array<[string, string[], string]> = [
    ["sin_metodo", ["1. Revisión", "2. Método", "3. Finalización"], "Método"],
    ["cambio_libre", ["1. Revisión", "2. Método", "3. Cambio en sucursal", "4. Recepción", "5. Finalización"], "Cambio en sucursal"],
    ["recepcion", ["1. Revisión", "2. Método", "3. Retiro", "4. Recepción", "5. Reenvío", "6. Finalización"], "Recepción"],
  ]
  for (const [scenario, labels, current] of cases) {
    const page = await open(scenario)
    try {
      assert.deepEqual(await stepLabels(page), labels, scenario)
      assert.equal(await heading(page), current, scenario)
    } finally { await page.close() }
  }
})

test("Paso Método: sólo el método (sin recepción, unidades ni resumen); elegir muestra SOLO su formulario; cancelar limpia", async () => {
  const page = await open("sin_metodo")
  try {
    assert.equal(await page.locator(".admin-claim-reception-panel").count(), 0, "Recepción no aparece en Método")
    assert.equal(await page.locator("[data-claim-logistics-units], [data-claim-logistics-summary], [data-claim-replacement-reservation]").count(), 0)
    assert.equal(await page.locator("[data-claim-logistics-request]").count(), 0, "sin selección no hay formulario")
    const help = page.getByRole("button", { name: "Ayuda: Cambio directo por sucursal" })
    await help.focus()
    const bubble = page.locator(`[id="${await help.getAttribute("aria-describedby")}"]`)
    assert.equal(await bubble.isVisible(), true)
    assert.match(await bubble.innerText(), /Andreani lo entrega en la sucursal solo si el cliente entrega el producto original/)
    const retiroHelp = page.getByRole("button", { name: "Ayuda: Retiro + revisión + reenvío" })
    assert.match(await page.locator(`[id="${await retiroHelp.getAttribute("aria-describedby")}"]`).textContent() ?? "",
      /BEYONIX lo recibe e inspecciona y recién después se decide y envía el reemplazo/)

    await radio(page, /Cambio directo por sucursal/).check()
    await page.waitForSelector("[data-claim-logistics-branch-picker]")
    assert.equal(await page.locator("[data-claim-logistics-request]").count(), 1, "sólo el formulario elegido")
    const confirm = page.getByRole("button", { name: "Confirmar cambio" })
    assert.equal(await confirm.isDisabled(), true, "sin sucursal válida no se continúa")
    assert.match(await page.locator("[data-claim-logistics-branch]").innerText(), /Elegí una sucursal Andreani/)
    await pickBranch(page)
    assert.match(await page.locator("[data-claim-logistics-branch]").innerText(), /Sucursal Once · Av\. Pueyrredón 100/)
    assert.equal(await confirm.isDisabled(), false)
    await page.getByRole("button", { name: "Cancelar", exact: true }).click()
    assert.equal(await page.locator("[data-claim-logistics-request]").count(), 0)
    assert.equal(await radio(page, /Cambio directo por sucursal/).isChecked(), false)
    assert.equal((await posts(page)).length, 0, "cancelar no envía nada")
  } finally { await page.close() }
})

test("sucursal por defecto: la sugerida por el servidor (10179) queda elegida; 'Cambiar sucursal' permite otra", async () => {
  const page = await open("sugerida")
  try {
    await radio(page, /Cambio directo por sucursal/).check()
    await page.waitForFunction(() => /ROSARIO/.test(document.querySelector("[data-claim-logistics-branch]")?.textContent ?? ""))
    assert.equal(await page.locator("[data-claim-logistics-branch]").innerText(),
      "Sucursal: ROSARIO (AV EVA PERON) · Av. Eva Perón 6243 · Rosario, Santa Fe")
    assert.equal(await page.locator("[data-claim-logistics-branch-picker]").count(), 0, "no hace falta escribir 'Rosario'")
    const confirm = page.getByRole("button", { name: "Confirmar cambio" })
    assert.equal(await confirm.isDisabled(), false)
    await page.getByRole("button", { name: "Cambiar sucursal" }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Buscar sucursal Andreani")
    await pickBranch(page)
    assert.match(await page.locator("[data-claim-logistics-branch]").innerText(), /Sucursal Once/)
    await confirm.click()
    await page.waitForFunction(() => (window as unknown as { __posts: unknown[] }).__posts.length === 1)
    assert.deepEqual(await posts(page), [{ action: "request", direction: "cambio", branchId: "4567" }], "sólo el id: nombre/dirección los valida el servidor")
  } finally { await page.close() }
})

test("teclado: flechas entre métodos cambian el formulario sin perder el foco ('Confirmar retiro')", async () => {
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
    assert.deepEqual(await posts(page), [{ action: "request", direction: "devolucion", branchId: "4567" }])
  } finally { await page.close() }
})

test("Revisión editable sin efectos: 'Corresponde' marcado; se corrige a 'No corresponde' o se cambia la solución", async () => {
  const page = await open("sin_metodo")
  try {
    await back(page)
    assert.equal(await heading(page), "Revisión")
    assert.equal(await page.locator("[data-claim-review]").getAttribute("data-claim-review"), "edit")
    assert.match(await page.locator("[data-claim-review-current]").innerText(), /Decisión actual: Corresponde · Solución: Cambio de producto\. Todavía no hubo movimientos reales/)
    assert.equal(await reviewButton(page, /El reclamo es válido/).getAttribute("aria-pressed"), "true")
    assert.equal(await reviewButton(page, /El reclamo no corresponde/).getAttribute("aria-pressed"), "false")

    // Cambiar la solución: el formulario original, precargado con la actual.
    await reviewButton(page, /El reclamo es válido/).click()
    const modal = page.getByRole("dialog", { name: "Corregir la solución" })
    await modal.waitFor()
    assert.equal(await modal.getByRole("radio", { name: "Cambio del producto" }).isChecked(), true, "precarga la solución vigente")
    assert.equal(await modal.getByRole("radio", { name: "Reembolso" }).count(), 0, "desde aprobado no se salta a reintegro pendiente")
    const save = modal.getByRole("button", { name: "Guardar corrección" })
    assert.equal(await save.isDisabled(), true, "sin cambios no hay nada que guardar")
    await modal.getByRole("radio", { name: "Enviar unidad faltante" }).check()
    await save.click()
    await page.waitForFunction(() => (window as unknown as { __patches: unknown[] }).__patches.length === 1)
    const [solution] = await patches(page)
    assert.deepEqual([solution.status, solution.resolution], ["aprobado", "envio_unidad_faltante"])
    assert.equal(await heading(page), "Método", "guardada la corrección, el wizard sigue en el paso vigente")

    // Corresponde -> No corresponde (con motivo).
    await page.getByRole("button", { name: /1\. Revisión/ }).click()
    await reviewButton(page, /El reclamo no corresponde/).click()
    const reject = page.getByRole("dialog", { name: "El reclamo no corresponde" })
    await reject.waitFor()
    await reject.locator("textarea").fill("El daño fue por mal uso del producto.")
    await reject.getByRole("button", { name: "Rechazar reclamo" }).click()
    await page.waitForFunction(() => (window as unknown as { __patches: unknown[] }).__patches.length === 2)
    const rejection = (await patches(page))[1]
    assert.deepEqual([rejection.status, rejection.resolution], ["rechazado", "rechazado"])
    assert.match(String(rejection.rejection_reason), /mal uso/)
  } finally { await page.close() }
})

test("Revisión con No corresponde sin efectos: 'Corresponde' reabre la revisión con motivo (auditado)", async () => {
  const page = await open("rechazado")
  try {
    await back(page)
    assert.equal(await heading(page), "Revisión")
    assert.equal(await page.locator("[data-claim-review]").getAttribute("data-claim-review"), "reopen")
    assert.equal(await reviewButton(page, /El reclamo no corresponde/).getAttribute("aria-pressed"), "true")
    await reviewButton(page, /El reclamo es válido/).click()
    const form = page.locator("[data-claim-review-reopen]")
    await form.waitFor()
    const reopen = form.getByRole("button", { name: "Reabrir revisión" })
    await form.locator("textarea").fill("corto")
    assert.equal(await reopen.isDisabled(), true, "motivo mínimo 10 caracteres")
    await form.locator("textarea").fill("Me equivoqué: el reclamo sí corresponde")
    await reopen.click()
    await page.waitForFunction(() => (window as unknown as { __patches: unknown[] }).__patches.length === 1)
    const [payload] = await patches(page)
    assert.deepEqual([payload.action, payload.reason], ["reopen_review", "Me equivoqué: el reclamo sí corresponde"])
    assert.equal(payload.expectedUpdatedAt, "2026-09-21T10:05:00Z", "CAS: la base rechaza si el reclamo cambió")
  } finally { await page.close() }
})

test("con efectos reales: Revisión y Método bloqueados mostrando qué pasó; recepción fuera del paso del cambio", async () => {
  const page = await open("cambio_generado")
  try {
    assert.equal(await heading(page), "Cambio en sucursal")
    assert.equal(await page.locator(".admin-claim-reception-panel").count(), 0, "la recepción tiene su propio paso")
    assert.equal(await page.getByRole("button", { name: /Registrar llegada/ }).count(), 0)
    assert.equal(await page.getByText("No informado por Andreani").count(), 0, "sin datos técnicos que no ayudan")
    assert.equal(await page.getByText(/Contrato:/).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Cancelar operación" }).count(), 1, "corrección auditada disponible en su paso")

    await page.getByRole("button", { name: /1\. Revisión/ }).click()
    assert.equal(await page.locator("[data-claim-review]").getAttribute("data-claim-review"), "locked")
    const lock = await page.locator("[data-claim-review-lock]").innerText()
    assert.match(lock, /La decisión no se puede cambiar directamente/)
    assert.match(lock, /Operación generada: Cambio en sucursal Andreani \(360000000801\)/)
    assert.match(lock, /Stock reservado para el reemplazo: 1 unidad/)
    assert.equal(await reviewButton(page, /El reclamo no corresponde/).isDisabled(), true)
    assert.equal(await reviewButton(page, /El reclamo es válido/).isDisabled(), true)

    await page.getByRole("button", { name: /2\. Método/ }).click()
    const methodLock = await page.locator("[data-claim-method-lock=blocked]").innerText()
    assert.match(methodLock, /primero cancelá la operación Andreani con un motivo/)
    assert.equal(await radio(page, /Retiro \+ revisión \+ reenvío/).isDisabled(), true)
  } finally { await page.close() }
})

test("volver atrás y adelante sin efectos: de 'Cambio en sucursal' a 'Método', corregir y volver al paso vigente", async () => {
  const page = await open("cambio_libre")
  try {
    assert.equal(await heading(page), "Cambio en sucursal")
    await back(page)
    assert.equal(await heading(page), "Método")
    assert.match(await page.locator("[data-claim-method-lock]").innerText(), /Todavía no hay operaciones reales/)
    assert.match(await page.locator("[data-claim-logistics-method=cambio]").innerText(), /Actual/i)
    await back(page)
    assert.equal(await heading(page), "Revisión")
    await page.getByRole("button", { name: /2\. Método/ }).click()
    await radio(page, /Retiro \+ revisión \+ reenvío/).check()
    await page.waitForSelector("[data-claim-logistics-request=devolucion]")
    await pickBranch(page)
    await page.getByRole("button", { name: "Confirmar retiro" }).click()
    await page.waitForFunction(() => (window as unknown as { __posts: unknown[] }).__posts.length === 1)
    await page.waitForFunction(() => document.querySelector(".admin-claim-manage-heading")?.textContent === "Cambio en sucursal")
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

test("Recepción: pantalla propia, acciones visibles por producto (sin desplegable) y ayudas (?) de stock y baja", async () => {
  const page = await open("recepcion")
  try {
    assert.equal(await heading(page), "Recepción")
    const summary = (await page.locator("[data-claim-logistics-summary] dt").allInnerTexts()).map((label) => label.trim().toLowerCase())
    assert.deepEqual(summary, ["método", "sucursal", "estado", "problemas"])
    assert.equal(await page.locator("[data-claim-logistics-status]").innerText(), "Recibido")
    assert.equal(await page.locator("[data-claim-current-action]").count(), 0, "sin acciones de logística en Recepción")
    assert.equal(await page.locator(methodPanel).count(), 0, "el método se revisa en su propio paso")
    assert.equal(await page.locator("select").filter({ hasText: "Elegí una acción" }).count(), 0, "sin el desplegable genérico")
    assert.equal(await page.getByRole("button", { name: /Generar|Cancelar operación|Reservar reemplazo|Registrar reemplazo/ }).count(), 0,
      "nada de la operación Andreani ni del reemplazo en Recepción")
    const actions = page.locator("[data-claim-logistics-item-actions]").getByRole("button")
    assert.ok((await actions.allInnerTexts()).includes("Registrar problema"))
    await actions.filter({ hasText: "Registrar problema" }).click()
    await page.waitForSelector("[data-claim-logistics-unit-form=incident_open]")
    assert.equal(await page.getByRole("button", { name: "Registrar", exact: true }).isDisabled(), true, "problema: tipo obligatorio")
    await page.getByRole("button", { name: "Cancelar", exact: true }).click()

    const reception = page.locator(".admin-claim-reception-panel")
    for (const [label, text] of [
      ["Volver al stock", "Producto en buen estado y apto para volver a venderse."],
      ["Dar de baja", "Producto dañado o no apto para volver a venderse."],
    ]) {
      const trigger = reception.getByRole("button", { name: `Ayuda: ${label}` })
      assert.equal(await page.locator(`[id="${await trigger.getAttribute("aria-describedby")}"]`).textContent(), text)
    }
    assert.equal(await reception.getByRole("button", { name: "Confirmar recepción" }).isDisabled(), true, "sin elegir destino no se confirma")
    await reception.getByRole("button", { name: "Volver al stock", exact: true }).click()
    assert.equal(await reception.getByRole("button", { name: "Confirmar recepción" }).isDisabled(), false)
  } finally { await page.close() }
})

test("Recepción antes de que llegue: se registra la llegada; stock/baja recién cuando está en BEYONIX", async () => {
  const page = await open("en_camino")
  try {
    assert.equal(await heading(page), "Recepción")
    assert.equal(await page.locator("[data-claim-reception-waiting]").count(), 1)
    assert.equal(await page.locator(".admin-claim-reception-panel").getByRole("button", { name: "Volver al stock", exact: true }).count(), 0)
    const arrival = page.locator("[data-claim-logistics-item-actions]").getByRole("button", { name: /Registrar llegada/ })
    assert.match(await arrival.getAttribute("class") ?? "", /admin-ds-button-primary/, "la llegada es la acción principal del producto")
    const incident = page.locator("[data-claim-logistics-item-actions]").getByRole("button", { name: /Registrar problema/ })
    assert.doesNotMatch(await incident.getAttribute("class") ?? "", /admin-ds-button-primary/, "registrar un problema es secundario")
    assert.match(await page.locator("[data-claim-item-status]").innerText(), /Pendiente de llegada: 1/)
    await arrival.click()
    await page.waitForSelector("[data-claim-logistics-unit-form=arrival_original]")
  } finally { await page.close() }
})

test("legacy: se mantiene su flujo, con una ayuda corta y la opción de pasar al flujo nuevo si no tuvo movimientos", async () => {
  const page = await open("legacy")
  try {
    assert.ok(!(await stepLabels(page)).includes("2. Método"), "sin paso Método: flujo original")
    const badge = page.getByText("Reclamo anterior", { exact: true })
    assert.equal(await badge.count(), 1)
    assert.equal(await page.getByRole("button", { name: "Ayuda: Reclamo anterior" }).count(), 1)
    assert.equal(await page.locator("[data-claim-logistics-methods]").count(), 1, "sin movimientos: puede elegir un método")
  } finally { await page.close() }
})

const checklist = async (page: Page) =>
  (await page.locator("[data-claim-checklist] li").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim())
const primaries = (page: Page) => page.locator("[data-claim-logistics] .admin-ds-button-primary")

test("Cambio en sucursal: orden de arriba hacia abajo; sin reserva sólo 'Reservar reemplazo' (generar oculto)", async () => {
  const page = await open("cambio_libre")
  try {
    assert.deepEqual(await checklist(page), [
      "Reemplazo reservado (próximo)", "Cambio generado (pendiente)", "Intercambio realizado (pendiente)",
      "Producto recibido (pendiente)", "Producto inspeccionado (pendiente)", "Reclamo finalizado (pendiente)",
    ], "los checks tienen texto, no sólo color")
    assert.equal(await primaries(page).count(), 1, "una sola acción principal")
    assert.equal(await primaries(page).first().innerText(), "Reservar reemplazo")
    assert.equal(await page.getByRole("button", { name: /Generar cambio/ }).count(), 0, "generar no aparece antes de reservar")
    const tip = page.getByRole("button", { name: "Ayuda: Reservar reemplazo" })
    assert.equal(await page.locator(`[id="${await tip.getAttribute("aria-describedby")}"]`).textContent(), "Reserva una unidad para este reclamo.")
    // La acción principal aparece antes que las secundarias (orden visual real).
    const [actionBox, secondaryBox] = await Promise.all([
      page.locator("[data-claim-current-action]").boundingBox(), page.locator("[data-claim-secondary-actions]").boundingBox(),
    ])
    assert.ok(actionBox && secondaryBox && actionBox.y < secondaryBox.y, "las secundarias nunca desplazan a la principal")
    await primaries(page).first().click()
    assert.equal(await page.evaluate(() => (window as unknown as { __reserved: number | null }).__reserved), 71, "abre el formulario de reserva del ítem")
  } finally { await page.close() }
})

test("Cambio en sucursal: con la reserva hecha se marca el check y la acción pasa a 'Generar cambio en sucursal'", async () => {
  const page = await open("cambio_reservado")
  try {
    assert.equal((await checklist(page))[0], "Reemplazo reservado (listo)")
    assert.equal((await checklist(page))[1], "Cambio generado (próximo)")
    assert.equal(await primaries(page).count(), 1)
    assert.equal(await primaries(page).first().innerText(), "Generar cambio en sucursal")
    assert.equal(await page.getByRole("button", { name: "Reservar reemplazo" }).count(), 0)
    // Teclado: la acción principal es alcanzable y se activa con Enter.
    await primaries(page).first().focus()
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => (window as unknown as { __posts: unknown[] }).__posts.length === 1)
    assert.deepEqual(await posts(page), [{ action: "create", shipmentId: 1 }])
  } finally { await page.close() }
})

test("Cambio generado: estado de espera humano, sin acción principal; secundarias discretas", async () => {
  const page = await open("cambio_generado")
  try {
    assert.deepEqual((await checklist(page)).slice(0, 3), ["Reemplazo reservado (listo)", "Cambio generado (listo)", "Intercambio realizado (próximo)"])
    assert.equal(await page.locator("[data-claim-waiting]").innerText(), "Esperando que Andreani retire el reemplazo")
    assert.equal(await page.locator("[data-claim-logistics-status]").innerText(), "En Andreani")
    assert.equal(await primaries(page).count(), 0, "nada que hacer: sólo esperar")
    const cancel = page.getByRole("button", { name: "Cancelar operación" })
    assert.match(await cancel.getAttribute("class") ?? "", /admin-ds-button-ghost/, "secundaria")
  } finally { await page.close() }
})

test("Retiro: 'Generar retiro' como única acción, checklist en el orden del método", async () => {
  const page = await open("retiro_pendiente")
  try {
    assert.equal(await heading(page), "Retiro")
    assert.deepEqual((await checklist(page)).map((text) => text.replace(/ \(.*\)$/, "")),
      ["Retiro generado", "Producto recibido", "Producto inspeccionado", "Reemplazo reservado", "Reenvío generado", "Reclamo finalizado"])
    assert.equal(await primaries(page).count(), 1)
    assert.equal(await primaries(page).first().innerText(), "Generar retiro")
    assert.equal(await page.locator(".admin-claim-reception-panel").count(), 0)
  } finally { await page.close() }
})

const cancelTrigger = (page: Page) => page.locator("[data-claim-cancel]").getByRole("button", { name: "Cancelar reclamo", exact: true })

test("Cancelar reclamo limpio: acción secundaria, modal con motivo obligatorio y confirmación explícita", async () => {
  const page = await open("sin_metodo")
  try {
    const trigger = cancelTrigger(page)
    assert.equal(await trigger.count(), 1)
    assert.doesNotMatch(await trigger.getAttribute("class") ?? "", /admin-ds-button-primary|admin-ds-button-destructive/, "no compite con la acción principal")
    await trigger.click()
    const modal = page.getByRole("dialog", { name: "Cancelar reclamo" })
    await modal.waitFor()
    assert.match(await modal.innerText(), /Queda como Cancelado y se avisa al cliente|El reclamo queda como Cancelado y se avisa al cliente/)
    const confirm = modal.getByRole("button", { name: "Confirmar cancelación" })
    assert.equal(await confirm.isDisabled(), true, "motivo obligatorio")
    await modal.locator("textarea").fill("corto")
    assert.equal(await confirm.isDisabled(), true)
    await modal.locator("textarea").fill("El cliente desistió del reclamo")
    await confirm.click()
    await page.waitForFunction(() => (window as unknown as { __patches: unknown[] }).__patches.length === 1)
    assert.deepEqual(await patches(page), [{ action: "cancel_claim", reason: "El cliente desistió del reclamo", expectedUpdatedAt: "2026-09-21T10:05:00Z" }])
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"))
  } finally { await page.close() }
})

test("Cancelar reclamo con efectos pendientes: 'No se puede cancelar todavía' y qué resolver, sin opción de confirmar", async () => {
  const page = await open("cambio_generado")
  try {
    await cancelTrigger(page).click()
    const modal = page.getByRole("dialog", { name: "Cancelar reclamo" })
    await modal.waitFor()
    assert.match(await modal.innerText(), /No se puede cancelar todavía\./)
    const items = (await modal.locator("[data-claim-cancel-blockers] li").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim())
    assert.deepEqual(items, ["Hay una operación Andreani en curso. Ir a operación", "Hay un reemplazo reservado. Ir a liberar reserva"],
      "cada bloqueo dice qué pasa y cómo llegar")
    assert.equal(await modal.getByRole("button", { name: "Confirmar cancelación" }).count(), 0)
    assert.equal((await patches(page)).length, 0)

    // "Ir a operación": cierra el modal, abre el paso y resalta "Cancelar operación".
    await modal.getByRole("button", { name: "Ir a operación" }).click()
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"))
    assert.equal(await heading(page), "Cambio en sucursal")
    await page.waitForFunction(() => document.activeElement?.textContent === "Cancelar operación")
    assert.match(await page.getByRole("button", { name: "Cancelar operación" }).getAttribute("class") ?? "", /is-claim-highlight/)
  } finally { await page.close() }
})

test("'Ir a liberar reserva' lleva al paso exacto y resalta 'Liberar reserva' (desde otro paso)", async () => {
  const page = await open("cambio_reservado")
  try {
    await page.getByRole("button", { name: /1\. Revisión/ }).click()
    assert.equal(await heading(page), "Revisión")
    await cancelTrigger(page).click()
    const modal = page.getByRole("dialog", { name: "Cancelar reclamo" })
    await modal.getByRole("button", { name: "Ir a liberar reserva" }).click()
    await page.waitForFunction(() => document.querySelector(".admin-claim-manage-heading")?.textContent === "Cambio en sucursal")
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-claim-focus") === "release_reservation")
    const release = page.locator('[data-claim-focus="release_reservation"]')
    assert.equal(await release.innerText(), "Liberar reserva")
    assert.match(await release.getAttribute("class") ?? "", /is-claim-highlight/)
    // Teclado: el foco quedó en la acción; Enter la abre (con motivo y confirmación, como siempre).
    await page.keyboard.press("Enter")
    await page.waitForSelector("[data-claim-logistics-unit-form=release_reservation]")
  } finally { await page.close() }
})

test("Cancelar reclamo: si la base encuentra algo pendiente, se muestra y no se cancela", async () => {
  const page = await open("cancel_bloqueado_servidor")
  try {
    await cancelTrigger(page).click()
    const modal = page.getByRole("dialog", { name: "Cancelar reclamo" })
    await modal.locator("textarea").fill("El cliente desistió del reclamo")
    await modal.getByRole("button", { name: "Confirmar cancelación" }).click()
    await modal.locator("[data-claim-cancel-blockers]").waitFor()
    const items = (await modal.locator("[data-claim-cancel-blockers] li").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim())
    assert.deepEqual(items, ["Hay un problema abierto. Ir al problema"], "lo que devuelve la base también trae su acceso")
    assert.match(await modal.innerText(), /No se puede cancelar todavía\./)
  } finally { await page.close() }
})

test("Cancelar reclamo: arriba, a la izquierda de 'Conversación', mismo alto; fuera del bloque de Revisión", async () => {
  for (const scenario of ["sin_metodo", "cambio_generado"]) {
    const page = await open(scenario)
    try {
      const cancel = cancelTrigger(page)
      const chat = page.getByRole("button", { name: /Abrir conversación con el cliente/ })
      assert.equal(await page.locator(".admin-claim-wizard-header [data-claim-cancel]").count(), 1, "vive en el encabezado")
      assert.equal(await page.locator(".admin-claim-manage-panel [data-claim-cancel]").count(), 0, "ya no está en el panel de Revisión")
      const [cancelBox, chatBox] = await Promise.all([cancel.boundingBox(), chat.boundingBox()])
      assert.ok(cancelBox && chatBox)
      assert.ok(cancelBox.x + cancelBox.width <= chatBox.x, "a la izquierda de Conversación")
      assert.ok(Math.abs(cancelBox.height - chatBox.height) <= 1, `mismo alto (${cancelBox.height} vs ${chatBox.height})`)
      assert.ok(Math.abs((cancelBox.y + cancelBox.height / 2) - (chatBox.y + chatBox.height / 2)) <= 1, "alineados")
      assert.equal(await cancel.isDisabled(), false, `${scenario}: visible y usable (si hay pendientes, el modal explica qué falta)`)
      assert.equal(await page.locator("[data-claim-cancel]").getAttribute("data-blocked"), scenario === "cambio_generado" ? "true" : "false")
      await cancel.focus()
      assert.equal(await cancel.evaluate((element) => getComputedStyle(element).outlineStyle), "solid", "foco visible")
    } finally { await page.close() }
  }
})

test("Cancelar reclamo no se ofrece en reclamos rechazados", async () => {
  const page = await open("rechazado")
  try {
    assert.equal(await cancelTrigger(page).count(), 0)
  } finally { await page.close() }
})

test("ayuda (?) de 'Cancelar reclamo': nunca se corta (abre abajo si arriba no hay lugar), entra en móvil y funciona con teclado", async () => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 740 }]) {
    const page = await open("sin_metodo")
    try {
      await page.setViewportSize(viewport)
      await page.evaluate(() => window.scrollTo(0, 0))
      const help = page.locator("[data-claim-cancel]").getByRole("button", { name: "Ayuda: Cancelar reclamo" })
      await help.focus()
      const bubble = page.locator(`[id="${await help.getAttribute("aria-describedby")}"]`)
      await bubble.waitFor({ state: "visible" })
      assert.equal(await help.getAttribute("aria-expanded"), "true")
      const [box, trigger] = await Promise.all([bubble.boundingBox(), help.boundingBox()])
      assert.ok(box && trigger)
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, `${viewport.width}px: dentro del ancho (${box.x}..${box.x + box.width})`)
      assert.ok(box.y >= 0 && box.y + box.height <= viewport.height, `${viewport.width}px: dentro del alto`)
      assert.ok(box.width <= 256, "ancho máximo razonable")
      // No la recorta el overflow del panel (fixed respecto de la pantalla) y queda por encima de todo.
      const layout = await bubble.evaluate((element) => {
        const style = getComputedStyle(element)
        return { position: style.position, zIndex: Number(style.zIndex), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
      })
      assert.equal(layout.position, "fixed")
      assert.ok(layout.zIndex >= 1000, "z-index por encima del panel")
      assert.ok(layout.scrollWidth <= layout.clientWidth, "el texto no desborda la burbuja")
      if (trigger.y < box.height + 16) assert.ok(box.y >= trigger.y + trigger.height, "sin lugar arriba: abre hacia abajo")
      await page.keyboard.press("Escape")
      await bubble.waitFor({ state: "hidden" })
    } finally { await page.close() }
  }
})
