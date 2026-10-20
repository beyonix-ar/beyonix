import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Reclamo con resolución por producto (mixto), con los componentes REALES
// (AdminClaimManager + panel por producto) y el CSS del proyecto: reparto al
// aprobar, qué falta en cada producto, acciones pendientes agrupadas, cambio
// Reemplazo -> Reintegro/Saldo por falta de stock y cierre sólo con todo
// resuelto. Light/Dark a 390, 430, 1024 y 1440 px. Stubs sólo de
// infraestructura: auth, Supabase, router y fetch.

const stubs: Plugin = {
  name: "claim-mixed-stubs",
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
const unit = (order_item_id, role, location, shipment_id = null) => ({ id: ++unitId, claim_id: 900, order_item_id, role, location, shipment_id, incident_open: false, incident_type: null })
const leg = (overrides) => ({
  id: 1, claim_id: 900, direction: "reemplazo", attempt: 1, status: "pendiente", creation_status: "not_started", closed_at: null,
  branch_id: "4567", branch_name: "Sucursal Once", branch_address: "Av. Pueyrredón 100", legacy: false, ...overrides,
})
const lines = [
  { order_item_id: 71, solution: "replacement", quantity: 1 },
  { order_item_id: 71, solution: "refund", quantity: 1 },
  { order_item_id: 72, solution: "credit", quantity: 1 },
]
const kept = [unit(71, "original", "conservada_cliente"), unit(71, "original", "conservada_cliente"), unit(72, "original", "conservada_cliente")]
const settledNote = (destination, order_item_id, total_amount) => ({
  id: destination + order_item_id, order_id: 500, claim_id: 900, status: "authorized", destination, settlement_status: "completado",
  total_amount, order_credit_note_items: [{ order_item_id, quantity: 1 }],
})
const scenarios = {
  revision: { claim: { status: "en_revision", resolution: null }, shipments: [], units: [] },
  metodo: { claim: { resolution: "mixta", order_claim_item_resolutions: lines }, shipments: [], units: [] },
  pendiente: { claim: { resolution: "mixta", order_claim_item_resolutions: lines }, shipments: [leg({})], units: kept },
  parcial: {
    claim: { resolution: "mixta", order_claim_item_resolutions: [lines[0], lines[2]] },
    shipments: [leg({})], units: kept,
  },
  completo: {
    claim: { resolution: "mixta", order_claim_item_resolutions: lines },
    shipments: [leg({ status: "entregada", creation_status: "created", closed_at: "2026-10-19T10:00:00Z", andreani_tracking: "360000000901" })],
    units: [...kept, unit(71, "reemplazo", "entregada_cliente", 1)],
    replacements: [{ original_order_id: 500, claim_id: 900, original_order_item_id: 71, quantity: 1, reverted_quantity: 0 }],
    notes: [settledNote("external_refund", 71, 30000), settledNote("customer_balance", 72, 9000)],
  },
  simple: { claim: { resolution: "cambio_producto", affected_items: [{ order_item_id: 71, quantity: 2 }] }, shipments: [leg({})], units: kept.slice(0, 2) },
}
const data = scenarios[scenario]
const product = (id, nombre, precio) => ({ id, nombre, slug: "p" + id, descripcion: null, precio, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" })
const claim = {
  id: 900, order_id: 500, user_id: "c", claim_type: "garantia_beyonix", failure_type: "falla",
  status: "aprobado", resolution: "mixta", resolution_summary: null, rejection_reason: null,
  description: "Producto afectado: Auricular Ñandú\\n\\nNo enciende.",
  affected_items: [{ order_item_id: 71, quantity: 2 }, { order_item_id: 72, quantity: 1 }],
  order_claim_messages: [], order_claim_files: [], order_claim_item_resolutions: [],
  order_claim_shipments: data.shipments, order_claim_units: data.units, logistics_legacy: false,
  closed_at: null, created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-21T10:05:00Z",
  ...data.claim,
}
const pedido = {
  id: 500, usuario_id: "c", estado: "entregado", delivered_at: "2026-09-18T12:00:00Z", total: 69000, created_at: "2026-09-15T12:00:00Z",
  payment_method_id: "transferencia", shipping_type: "domicilio", invoice_status: "authorized", invoice_cae: "75123456789012",
  order_credit_notes: data.notes ?? [],
  orden_items: [
    { id: 71, orden_id: 500, producto_id: 1, cantidad: 2, precio: 30000, productos: product(1, "Auricular Ñandú negro", 30000) },
    { id: 72, orden_id: 500, producto_id: 2, cantidad: 1, precio: 9000, productos: product(2, "Encendedor recargable", 9000) },
  ],
  order_claims: [claim],
}
window.__patches = []
window.__billing = 0
window.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes("/andreani-shipment?capabilities=1")) return Response.json({ testStatusEnabled: false })
  if (url.includes("/andreani-branches?")) return Response.json({ branches: [], suggested: null })
  if (url.endsWith("/api/admin/order-claims/900") && init && init.method === "PATCH") {
    window.__patches.push(JSON.parse(init.body))
    return Response.json({ claim })
  }
  if (url.endsWith("/api/admin/order-claims/900")) return Response.json({ claim })
  return Response.json({ error: "sin datos en el test" }, { status: 404 })
}
createRoot(document.getElementById("admin-root")).render(createElement(AdminClaimManager, {
  pedido, mode: "all", onClaimChange: () => {}, onOpenBilling: () => { window.__billing += 1 }, onInventoryUpdated: () => {},
  registeredReplacements: data.replacements ?? [], replacementLoadState: "ready",
  onRegisterReplacement: (itemId) => { window.__reserved = itemId },
}))
`

const pageHtml = (css: string, bundle: string, theme: string) => `<!doctype html>
<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>
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
const SHOTS = join(tmpdir(), "beyonix-claim-mixed-shots")

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "claim-mixed-entry.tsx" },
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
  mkdirSync(SHOTS, { recursive: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(scenario: string, { width = 1280, theme = "dark" } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 1400 } })
  const html = pageHtml(css, bundle, theme)
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://localhost/claim") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort(),
  )
  await page.goto(`http://localhost/claim?scenario=${scenario}`)
  await page.waitForSelector(".admin-claim-manage-panel")
  return page
}

const patches = (page: Page) => page.evaluate(() => (window as unknown as { __patches: Array<Record<string, unknown>> }).__patches)
const rows = async (page: Page, itemId: number) =>
  (await page.locator(`[data-claim-item-resolutions] [data-claim-item="${itemId}"] [data-claim-line]`).allInnerTexts())
    .map((text) => text.replace(/\s+/g, " ").trim())

test("aprobar: 'Una solución distinta por producto' reparte unidades sin superar lo reclamado", async () => {
  const page = await open("revision")
  try {
    await page.locator("[data-claim-review]").getByRole("button", { name: /El reclamo es válido/ }).click()
    const dialog = page.getByRole("dialog", { name: "El reclamo es válido" })
    await dialog.getByRole("radio", { name: "Cambiar por otro producto" }).check()
    assert.match(await dialog.locator("[data-claim-solution-hint]").innerText(), /saldo a favor para realizar una nueva compra/)

    await dialog.getByRole("radio", { name: "Una solución distinta por producto" }).check()
    const editor = dialog.locator("[data-claim-line-editor]")
    assert.match(await editor.locator('[data-claim-item="71"]').innerText(), /AURICULAR ÑANDÚ NEGRO[\s\S]*2 unidades reclamadas/i)
    const accept = dialog.getByRole("button", { name: "Aceptar reclamo" })
    assert.equal(await accept.isDisabled(), true, "sin repartir no se acepta")

    const auricular = editor.locator('[data-claim-item="71"]')
    await auricular.getByRole("button", { name: "Una unidad más: Reemplazar" }).click()
    await auricular.getByRole("button", { name: "Una unidad más: Reintegrar" }).click()
    assert.equal(await auricular.getByRole("button", { name: "Una unidad más: Saldo a favor" }).isDisabled(), true,
      "nunca más unidades que las reclamadas")
    await editor.locator('[data-claim-item="72"]').getByRole("button", { name: "Una unidad más: Saldo a favor" }).click()
    assert.equal(await accept.isDisabled(), false)
    await accept.click()
    await page.waitForFunction(() => (window as unknown as { __patches: unknown[] }).__patches.length > 0)
    const [patch] = await patches(page)
    assert.equal(patch.action, "set_item_resolutions")
    assert.deepEqual(patch.lines, [
      { order_item_id: 71, solution: "replacement", quantity: 1 },
      { order_item_id: 71, solution: "refund", quantity: 1 },
      { order_item_id: 72, solution: "credit", quantity: 1 },
    ])
  } finally { await page.close() }
})

test("mixto recién aprobado: el paso Logística ofrece devolución o reenvío sin devolución, nunca cambio directo", async () => {
  const page = await open("metodo")
  try {
    assert.match(await page.locator(".admin-claim-manage-heading").innerText(), /Logística/)
    assert.deepEqual(await page.locator("[data-claim-logistics-section=method]").getByRole("radio").evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value)), ["devolucion", "sin_devolucion"])
  } finally { await page.close() }
})

test("mixto en curso: qué recibe cada unidad, acciones pendientes agrupadas y nada de cerrar todavía", async () => {
  const page = await open("pendiente")
  try {
    assert.equal(await page.locator("[data-claim-solution]").innerText(), "Solución por producto: 1 reemplazo · 1 reintegro · 1 saldo a favor")
    assert.match(await page.getByTestId("admin-claim-status-badge").innerText(), /Solución por producto en proceso/i)
    assert.deepEqual(await rows(page, 71), [
      "1 → Reemplazo Pendiente Registrar reemplazo",
      "1 → Reintegro Pendiente Calcular reintegro",
    ])
    assert.deepEqual(await rows(page, 72), ["1 → Saldo a favor Pendiente Calcular saldo a favor"])
    const actions = page.locator("[data-claim-line-actions]")
    assert.equal(await actions.getByRole("button", { name: /Calcular saldo a favor/ }).count(), 1)
    assert.equal(await actions.getByRole("button", { name: /Calcular reintegro/ }).count(), 1)
    await actions.getByRole("button", { name: /Calcular saldo a favor/ }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { __billing: number }).__billing), 1, "abre el asistente de NC existente")
    // Un solo bloque financiero: nada de logística/finanzas repetida por unidad.
    assert.equal(await page.locator("[data-claim-financial]").count(), 0)
    assert.equal(await page.locator("[data-claim-finish-action]").count(), 0, "un mixto no usa 'Confirmar entrega' del reemplazo simple")
  } finally { await page.close() }
})

test("reemplazo sin stock: pasa a reintegro con confirmación; sólo para el producto a reemplazar", async () => {
  const page = await open("pendiente")
  try {
    assert.equal(await page.locator("[data-claim-line-switch]").count(), 1, "el Encendedor (saldo) no ofrece el cambio")
    await page.locator('[data-claim-line-switch="71"]').getByRole("button", { name: "Pasar a reintegro" }).click()
    const confirm = page.getByRole("button", { name: "Pasar a reintegro" }).last()
    assert.match(await page.locator("body").innerText(), /Pasar a reintegro por falta de stock/)
    await confirm.click()
    await page.waitForFunction(() => (window as unknown as { __patches: unknown[] }).__patches.length > 0)
    const [patch] = await patches(page)
    assert.deepEqual({ action: patch.action, order_item_id: patch.order_item_id, target: patch.target },
      { action: "switch_replacement_resolution", order_item_id: 71, target: "refund" })
  } finally { await page.close() }
})

test("reclamo simple de reemplazo: la salida segura por falta de stock aparece en su paso", async () => {
  const page = await open("simple")
  try {
    assert.equal(await page.locator("[data-claim-item-resolutions]").count(), 0, "un reclamo simple no cambia de interfaz")
    const row = page.locator("[data-claim-replacement-switch]")
    assert.equal(await row.count(), 1)
    await row.getByRole("button", { name: "Pasar a saldo a favor" }).click()
    await page.getByRole("button", { name: "Pasar a saldo a favor" }).last().click()
    await page.waitForFunction(() => (window as unknown as { __patches: unknown[] }).__patches.length > 0)
    const [patch] = await patches(page)
    assert.deepEqual({ action: patch.action, order_item_id: patch.order_item_id, target: patch.target },
      { action: "switch_replacement_resolution", order_item_id: null, target: "credit" })
  } finally { await page.close() }
})

test("parcial: una unidad sin definir bloquea el cierre y se completa sin tocar lo asignado", async () => {
  const page = await open("parcial")
  try {
    assert.deepEqual(await rows(page, 71), ["1 → Reemplazo Pendiente Registrar reemplazo", "1 → Sin definir Pendiente"])
    await page.locator("[data-claim-line-actions]").getByRole("button", { name: "Definir unidades pendientes" }).click()
    const dialog = page.getByRole("dialog")
    const auricular = dialog.locator('[data-claim-line-editor] [data-claim-item="71"]')
    assert.equal(await auricular.getByRole("button", { name: "Una unidad menos: Reemplazar" }).isDisabled(), true,
      "lo ya asignado no se reduce desde acá")
    await auricular.getByRole("button", { name: "Una unidad más: Reintegrar" }).click()
    await dialog.getByRole("button", { name: /Guardar corrección|Aceptar reclamo/ }).click()
    await page.waitForFunction(() => (window as unknown as { __patches: unknown[] }).__patches.length > 0)
    const [patch] = await patches(page)
    assert.equal(patch.action, "set_item_resolutions")
    assert.deepEqual(patch.lines, [
      { order_item_id: 71, solution: "replacement", quantity: 1 },
      { order_item_id: 72, solution: "credit", quantity: 1 },
      { order_item_id: 71, solution: "refund", quantity: 1 },
    ])
  } finally { await page.close() }
})

test("completo: todas las ramas terminadas -> listo para finalizar con un solo botón", async () => {
  const page = await open("completo")
  try {
    assert.deepEqual(await rows(page, 71), ["1 → Reemplazo Entregado", "1 → Reintegro Reintegrado"])
    assert.deepEqual(await rows(page, 72), ["1 → Saldo a favor Acreditado"])
    assert.match(await page.getByTestId("admin-claim-status-badge").innerText(), /Listo para finalizar/i)
    const finish = page.getByRole("button", { name: /Finalizar reclamo/ })
    assert.equal(await finish.count(), 1)
    assert.equal(await finish.isDisabled(), false)
  } finally { await page.close() }
})

test("visual: panel y editor legibles y sin desborde en Light/Dark a 390, 430, 1024 y 1440 px", async () => {
  for (const theme of ["light", "dark"]) for (const width of [390, 430, 1024, 1440]) {
    const page = await open("pendiente", { width, theme })
    try {
      const panel = page.locator("[data-claim-item-resolutions]")
      assert.equal(await panel.isVisible(), true, `${theme} ${width}`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `sin desborde ${theme} ${width}`)
      const name = await panel.locator(".admin-claim-lines-name").first().evaluate((el) => getComputedStyle(el).color)
      assert.equal(name, theme === "light" ? "rgb(15, 23, 42)" : "rgb(248, 250, 252)", `${theme} ${width}`)
      const background = await panel.evaluate((el) => getComputedStyle(el).backgroundColor)
      if (theme === "light") assert.equal(background, "rgb(255, 255, 255)", `${theme} ${width}`)
      for (const pill of await panel.locator(".admin-claim-pill").all()) {
        const [color, bg] = await pill.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor])
        assert.notEqual(color, bg, `pastilla legible ${theme} ${width}`)
      }
      await panel.screenshot({ path: join(SHOTS, `panel-${theme}-${width}.png`) })

      await page.locator('[data-claim-line-switch="71"]').getByRole("button", { name: "Pasar a reintegro" }).isVisible()
      if (width <= 430) {
        const box = await panel.boundingBox()
        assert.ok(box && box.width <= width, `panel dentro del ancho ${theme} ${width}`)
      }
    } finally { await page.close() }

    const review = await open("revision", { width, theme })
    try {
      await review.locator("[data-claim-review]").getByRole("button", { name: /El reclamo es válido/ }).click()
      const dialog = review.getByRole("dialog", { name: "El reclamo es válido" })
      await dialog.getByRole("radio", { name: "Una solución distinta por producto" }).check()
      const editor = dialog.locator("[data-claim-line-editor]")
      assert.equal(await editor.isVisible(), true)
      assert.ok(await review.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `modal sin desborde ${theme} ${width}`)
      const stepper = editor.getByRole("button", { name: "Una unidad más: Reemplazar" }).first()
      const box = await stepper.boundingBox()
      assert.ok(box && box.width >= 28 && box.height >= 28, `botón táctil ${theme} ${width}`)
      await dialog.screenshot({ path: join(SHOTS, `editor-${theme}-${width}.png`) })
      // Celular con poca altura: el modal se desplaza y la confirmación queda alcanzable.
      await review.setViewportSize({ width, height: 640 })
      const accept = dialog.getByRole("button", { name: "Aceptar reclamo" })
      await accept.scrollIntoViewIfNeeded()
      const acceptBox = await accept.boundingBox()
      assert.ok(acceptBox && acceptBox.y >= 0 && acceptBox.y + acceptBox.height <= 640, `confirmación alcanzable ${theme} ${width}`)
    } finally { await review.close() }
  }
})
