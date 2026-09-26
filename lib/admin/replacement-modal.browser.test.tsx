import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// PASO 2 "Preparar reemplazo" -> formulario "Reemplazo del pedido".
// Bundle real (esbuild) de AdminClaimManager + OrderReplacementManager,
// conectados igual que admin-pedidos.tsx (openRequest con nonce), dentro de la
// cadena real del detalle de pedido y con el CSS del proyecto compilado por
// Tailwind. Stubs sólo de infraestructura: auth, cliente de Supabase (sesión
// falsa) y fetch (datos de reemplazos; registra los POST).

const stubs: Plugin = {
  name: "replacement-test-stubs",
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
          auth: { getSession: async () => ({ data: { session: { access_token: "test" } }, error: null }) },
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
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { AdminClaimManager } from "@/components/claims/admin-claim-manager"
import { OrderReplacementManager } from "@/app/admin/sections/pedidos/order-replacements"

window.__posts = []
window.__scrollIntoViewCalls = 0
const nativeScrollIntoView = Element.prototype.scrollIntoView
Element.prototype.scrollIntoView = function (...args) { window.__scrollIntoViewCalls++; return nativeScrollIntoView.apply(this, args) }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

// Escenarios (?scenario=): el pedido tiene el trípode (producto 1, ítem 71,
// reclamado) y un aro de luz (producto 2, ítem 72). El GET, como el servidor,
// devuelve variantes activas de AMBOS productos: el modal debe filtrar.
const scenario = new URLSearchParams(location.search).get("scenario") || "normal"
const v = (id, producto_id, nombre, sku, stock) => ({ id, producto_id, nombre, sku, stock, productos: { nombre: producto_id === 1 ? "Trípode Ñandú" : "Aro de luz" } })
const aro = v(20, 2, "Blanco", "ARO1", 4)
const variantsByScenario = {
  normal: [v(9, 1, "Negro", "TRIO1", 3), v(10, 1, "Azul", "TRIO2", 1), v(11, 1, "Rojo", "TRIO3", 0), aro],
  multi: [v(9, 1, "Negro", "TRIO1", 3), v(10, 1, "Azul", "TRIO2", 1), aro],
  "original-sin-stock": [v(9, 1, "Negro", "TRIO1", 0), v(10, 1, "Azul", "TRIO2", 2), v(11, 1, "Rojo", "TRIO3", 0), aro],
  "una-variante": [v(9, 1, "Negro", "TRIO1", 3), aro],
  "sin-variantes": [v(30, 1, "Única", "TRIPODE", 2), aro],
  "sin-stock": [v(9, 1, "Negro", "TRIO1", 0), v(10, 1, "Azul", "TRIO2", 0), aro],
  "sin-variantes-activas": [aro],
}
// Historial del flujo anterior (reason otro_producto) sobre el aro.
const history = scenario === "multi"
  ? [{ id: 3, original_order_id: 500, original_order_item_id: 72, claim_id: null, replacement_variant_id: 999, quantity: 1, reason: "otro_producto", unit_cost: 1000, created_at: "2026-09-21T10:00:00Z", notes: "Reemplazo previo por otro producto" }]
  : []

window.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes("/replacements")) {
    if (init && init.method === "POST") { window.__posts.push(JSON.parse(init.body)); return json({ ok: true }) }
    return json({ replacements: history, variants: variantsByScenario[scenario] })
  }
  return json({ error: "sin datos en el test" }, 404)
}

const producto = { id: 1, nombre: "Trípode Ñandú", slug: "t", descripcion: null, precio: 20000, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" }
const productoAro = { ...producto, id: 2, nombre: "Aro de luz", slug: "a" }
const withoutVariants = scenario === "sin-variantes"
const claim = {
  id: 900, order_id: 500, user_id: "c", claim_type: "garantia_beyonix", failure_type: "falla",
  status: "aprobado", resolution: "cambio_producto", description: "Producto afectado: Trípode Ñandú\\n\\nNo gira.",
  affected_items: scenario === "multi" ? [{ order_item_id: 71, quantity: 1 }, { order_item_id: 72, quantity: 1 }] : [{ order_item_id: 71, quantity: 1 }],
  order_claim_messages: [], order_claim_files: [],
  created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:05:00Z",
}
const pedido = {
  id: 500, usuario_id: null, estado: "entregado", total: 80000, created_at: "2026-09-19T12:00:00Z",
  payment_method_id: "mercadopago", shipping_type: "domicilio",
  orden_items: [
    { id: 71, orden_id: 500, producto_id: 1, variante_id: withoutVariants ? null : 9, cantidad: 3, precio: 20000, productos: producto, producto_variantes: withoutVariants ? null : { nombre: "Negro" }, return_restocked_quantity: 1, return_written_off_quantity: 0 },
    { id: 72, orden_id: 500, producto_id: 2, variante_id: 20, cantidad: 2, precio: 20000, productos: productoAro, producto_variantes: { nombre: "Blanco" }, return_restocked_quantity: 1, return_written_off_quantity: 0 },
  ],
  order_claims: [claim],
}

function Harness() {
  const [openRequest, setOpenRequest] = useState(null)
  return (
    <>
      <div style={{ height: 700 }} aria-hidden="true" />
      <OrderReplacementManager pedido={pedido} onUpdated={async () => {}} openRequest={openRequest} />
      <div style={{ height: 1800 }} aria-hidden="true" />
      <AdminClaimManager
        pedido={pedido}
        mode="all"
        onClaimChange={() => {}}
        onOpenBilling={() => {}}
        onInventoryUpdated={() => {}}
        registeredReplacements={[]}
        replacementLoadState="ready"
        onRegisterReplacement={(orderItemId) => setOpenRequest((current) => ({ nonce: (current?.nonce ?? 0) + 1, orderItemId }))}
      />
    </>
  )
}

createRoot(document.getElementById("detail-root")).render(<Harness />)
`

const pageHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div>
  <div class="admin-order-detail-scope bx-surface bx-surface-section mx-auto flex w-full max-w-[1420px] flex-col rounded-xl border border-white/10 bg-[#05070A]">
    <div class="bx-surface-inherit min-h-0 flex-1 bg-[#05070A]">
      <div class="flex min-w-0 flex-col gap-3 p-2.5 sm:p-3 lg:flex-row">
        <div class="admin-order-detail-content min-w-0 flex-1"><div id="detail-root"></div></div>
      </div>
    </div>
  </div>
</div></main></div>
<script>${bundle}</script></body></html>`

// Se ejecuta en el navegador como string (sin helpers del transpilador).
const CONTRAST_AUDIT = `(() => {
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
  const dialog = document.querySelector('[role="dialog"]')
  const failures = []
  let audited = 0
  for (const el of dialog.querySelectorAll("*")) {
    if (el.closest('[role="tooltip"]') || el.tagName === "OPTION") continue
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim()
    const control = el.matches("input:not([type=checkbox]), textarea, select")
    if (!own && !control) continue
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
    const min = el.matches(":disabled") ? 3 : large ? 3 : 4.5
    if (r < min) failures.push((own || el.tagName) .slice(0, 40) + " -> " + r.toFixed(2) + " (" + el.className.toString().slice(0, 60) + ")")
    if (control) {
      const border = over(parse(s.borderTopColor), background(el.parentElement))
      const fieldRatio = ratio(border, background(el.parentElement))
      if (fieldRatio < 1.9) failures.push("borde " + el.tagName + " -> " + fieldRatio.toFixed(2))
    }
  }
  const dialogLum = lum(background(dialog))
  return { audited, failures, dialogLum }
})()`

let browser: Browser
let css: string
// Hoja como la que servía producción: todo globals.css MENOS el bloque del
// modal de reemplazo (deploy con CSS desfasado). Con ella el modal tiene que
// seguir siendo un overlay fijo: sin crecer el documento ni mover el scroll.
let staleCss: string
let bundle: string

// `from` distinto por variante: @tailwindcss/postcss cachea por archivo.
async function compileCss(source: string, from: string) {
  return (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from })).css
}

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8").replace(/\r\n/g, "\n")
  const blockStart = source.lastIndexOf("/* ====", source.indexOf('Modal "Reemplazo del pedido"'))
  // Se quita sólo el bloque del modal (hasta el encabezado del siguiente).
  const nextBlock = source.indexOf("/* ====", blockStart + 1)
  const blockEnd = nextBlock === -1 ? source.length : nextBlock
  assert.ok(blockStart > 0 && source.slice(blockStart, blockEnd).includes(".admin-replacement-modal__backdrop {"), "bloque del modal ubicado")
  css = await compileCss(source, "app/globals.css")
  const compactStart = source.indexOf("/* Reemplazo: mismas acciones y datos")
  assert.ok(compactStart > blockEnd, "ajustes compactos ubicados")
  staleCss = await compileCss(source.slice(0, compactStart).replace(source.slice(blockStart, blockEnd), ""), "app/globals.stale.css")
  assert.ok(css.includes("admin-replacement-modal__backdrop") && !staleCss.includes("admin-replacement-modal"))
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "replacement-modal-entry.tsx" },
    bundle: true,
    format: "iife",
    write: false,
    jsx: "automatic",
    plugins: [stubs],
    alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light", width = 1440, height = 1000, stylesheet = css, scenario = "normal"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } })
  // Origen localhost = contexto seguro (crypto.randomUUID, como en producción HTTPS).
  const html = pageHtml(theme, stylesheet, bundle)
  await page.route("**/*", (route) =>
    new URL(route.request().url()).href.startsWith("http://localhost/replacement") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort(),
  )
  await page.goto(`http://localhost/replacement?scenario=${scenario}`)
  await page.waitForSelector(".admin-claim-wizard-steps")
  return page
}

const stepButton = (page: Page) => page.locator(".admin-claim-wizard-action button", { hasText: "Registrar reemplazo" })
const dialog = (page: Page) => page.locator('[role="dialog"]')

async function openFromStep(page: Page) {
  // Datos cargados (el GET lleva un debounce de 300 ms): lista o estado vacío.
  await page.waitForFunction(`(() => {
    const section = document.getElementById("order-replacements-500")
    return Boolean(section && (section.querySelector("li") || section.textContent.includes("Todavía no hay reemplazos")))
  })()`)
  const button = stepButton(page)
  await button.scrollIntoViewIfNeeded()
  await page.evaluate("window.__scrollIntoViewCalls = 0")
  await button.click()
  await dialog(page).waitFor()
  // El GET de variantes lleva un debounce de 300 ms.
  await page.waitForFunction(`!document.querySelector('[role="dialog"]').textContent.includes("Cargando")`)
}

const variantSelect = (page: Page) => dialog(page).locator("select").last()

async function fillValidForm(page: Page) {
  const modal = dialog(page)
  await modal.locator("textarea").fill("La unidad llegó con el motor dañado.")
  await variantSelect(page).selectOption("9")
  // Deja terminar la transición de color del botón primario (150 ms).
  await page.waitForTimeout(250)
}

// Estado observable del documento para detectar saltos de scroll, crecimiento
// del documento y nodos que queden al cerrar.
const SNAPSHOT = `(() => {
  const d = document.querySelector('[role="dialog"]')
  const r = d ? d.getBoundingClientRect() : null
  const backdrop = d ? d.parentElement : null
  return {
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    bodyChildren: document.body.childElementCount,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    backdrops: document.querySelectorAll(".admin-replacement-modal__backdrop").length,
    visibleTooltips: [...document.querySelectorAll('[role="tooltip"]')].filter((t) => getComputedStyle(t).visibility !== "hidden" && t.getBoundingClientRect().width > 0).length,
    htmlOverflow: document.documentElement.style.overflow,
    bodyOverflow: document.body.style.overflow,
    dialog: d && {
      inBody: backdrop.parentElement === document.body,
      outsideScope: !d.closest(".admin-order-detail-scope, #order-replacements-500, .admin-claim-manage-panel"),
      backdropFixed: getComputedStyle(backdrop).position === "fixed",
      top: r.top, bottom: r.bottom, left: r.left, right: r.right,
      centered: Math.abs(r.left + r.width / 2 - window.innerWidth / 2) <= 1,
      focusInside: d.contains(document.activeElement),
      heading: d.querySelector("h2").textContent,
    },
  }
})()`

type Snapshot = {
  scrollY: number
  scrollHeight: number
  bodyChildren: number
  dialogs: number
  backdrops: number
  visibleTooltips: number
  htmlOverflow: string
  bodyOverflow: string
  dialog: null | {
    inBody: boolean
    outsideScope: boolean
    backdropFixed: boolean
    top: number
    bottom: number
    left: number
    right: number
    centered: boolean
    focusInside: boolean
    heading: string
  }
}

const snapshot = async (page: Page) => (await page.evaluate(SNAPSHOT)) as Snapshot
const sectionButton = (page: Page) => page.locator("#order-replacements-500 button", { hasText: "Registrar reemplazo" })

type Trigger = "sección" | "paso 2"
const triggers: Record<Trigger, (page: Page) => ReturnType<Page["locator"]>> = { "sección": sectionButton, "paso 2": stepButton }
const closers = {
  X: (page: Page) => dialog(page).getByRole("button", { name: "Cerrar", exact: true }).click(),
  Cancelar: (page: Page) => dialog(page).getByRole("button", { name: "Cancelar" }).click(),
  Escape: (page: Page) => page.keyboard.press("Escape"),
}

// Deja el botón en el medio de la pantalla (scrollY > 0, lejos de ambos bordes)
// después de la carga inicial de la sección, para que cualquier salto se note.
async function prepare(page: Page, trigger: Trigger) {
  await page.getByText("Todavía no hay reemplazos registrados.").waitFor()
  await triggers[trigger](page).evaluate((node) => {
    const rect = node.getBoundingClientRect()
    window.scrollTo(0, window.scrollY + rect.top - window.innerHeight / 2)
  })
  await page.evaluate("window.__scrollIntoViewCalls = 0")
  const before = await snapshot(page)
  assert.ok(before.scrollY > 300, `scroll inicial lejos del inicio (${before.scrollY})`)
  return before
}

const stylesheets = { "CSS completo": () => css, "CSS desfasado (producción)": () => staleCss }

for (const [cssName, stylesheet] of Object.entries(stylesheets)) {
  for (const [label, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    for (const trigger of ["sección", "paso 2"] as const) {
      test(`${cssName} · ${label}: "Registrar reemplazo" (${trigger}) abre el modal centrado, en body, sin scroll ni espacio extra`, async () => {
        const page = await open("dark", width, height, stylesheet())
        try {
          const before = await prepare(page, trigger)
          await triggers[trigger](page).click()
          await dialog(page).waitFor()
          await page.waitForTimeout(350)
          const opened = await snapshot(page)
          assert.equal(await page.evaluate("window.__scrollIntoViewCalls"), 0, "sin scrollIntoView")
          assert.equal(opened.scrollY, before.scrollY, "la página no se desplaza")
          assert.ok(opened.scrollHeight <= before.scrollHeight + 1, `el documento no crece (${before.scrollHeight} -> ${opened.scrollHeight})`)
          assert.equal(opened.bodyChildren, before.bodyChildren + 1, "sólo se agrega el backdrop del Portal")
          assert.equal(opened.dialogs, 1)
          assert.equal(opened.visibleTooltips, 0, "ningún tooltip visible sin interacción")
          assert.equal(opened.htmlOverflow, "hidden", "scroll del fondo bloqueado")
          assert.ok(opened.dialog, "diálogo presente")
          assert.equal(opened.dialog.heading, "Reemplazo del pedido #500")
          assert.equal(opened.dialog.inBody, true, "body > backdrop > dialog")
          assert.equal(opened.dialog.outsideScope, true, "fuera del detalle, la sección y Atención al cliente")
          assert.equal(opened.dialog.backdropFixed, true)
          assert.equal(opened.dialog.focusInside, true)
          assert.ok(opened.dialog.top >= 0 && opened.dialog.top < height, `visible en pantalla (top ${opened.dialog.top})`)
          assert.ok(opened.dialog.left >= 0 && opened.dialog.right <= width, "dentro del ancho")
          assert.equal(opened.dialog.centered, true, "centrado horizontalmente")
          // La rueda sobre el fondo no desplaza la página.
          await page.mouse.move(5, 5)
          await page.mouse.wheel(0, 600)
          await page.waitForTimeout(150)
          assert.equal((await snapshot(page)).scrollY, before.scrollY, "fondo quieto con la rueda")
          // Único ítem reclamado: el original se muestra fijo con ambos botones.
          assert.match(await dialog(page).getByTestId("replacement-original-item").innerText(), /Trípode Ñandú/)
        } finally {
          await page.close()
        }
      })
    }
  }

  for (const [closerName, close] of Object.entries(closers)) {
    test(`${cssName}: cerrar con ${closerName} restaura la posición y no deja nodos`, async () => {
      const page = await open("light", 1440, 900, stylesheet())
      try {
        const before = await prepare(page, "paso 2")
        await stepButton(page).click()
        await dialog(page).waitFor()
        await dialog(page).locator(".admin-claim-help-trigger").first().hover()
        await close(page)
        await dialog(page).waitFor({ state: "detached" })
        const after = await snapshot(page)
        assert.equal(after.scrollY, before.scrollY, "misma posición")
        assert.equal(after.scrollHeight, before.scrollHeight, "mismo alto de documento")
        assert.equal(after.bodyChildren, before.bodyChildren, "sin nodos residuales en body")
        assert.equal(after.dialogs + after.backdrops, 0)
        assert.equal(after.visibleTooltips, 0, "sin tooltips visibles")
        assert.equal(after.htmlOverflow, before.htmlOverflow, "overflow de html restaurado")
        assert.equal(after.bodyOverflow, before.bodyOverflow, "overflow de body restaurado")
      } finally {
        await page.close()
      }
    })
  }

  test(`${cssName}: abrir y cerrar 3 veces con ambos botones no duplica modales ni mueve el scroll`, async () => {
    const page = await open("dark", 1440, 900, stylesheet())
    try {
      const before = await prepare(page, "sección")
      for (let round = 0; round < 3; round++) {
        for (const trigger of ["sección", "paso 2"] as const) {
          // El botón del paso 2 queda fuera de pantalla: se hace click sin
          // desplazar la página (dispatch), como lo haría el usuario tras llegar.
          await triggers[trigger](page).dispatchEvent("click")
          await dialog(page).waitFor()
          const opened = await snapshot(page)
          assert.equal(opened.dialogs, 1, `ronda ${round + 1} (${trigger}): un solo modal`)
          assert.equal(opened.backdrops, 1)
          assert.equal(opened.scrollY, before.scrollY)
          await page.keyboard.press("Escape")
          await dialog(page).waitFor({ state: "detached" })
          const closed = await snapshot(page)
          assert.equal(closed.scrollY, before.scrollY, `ronda ${round + 1} (${trigger}): scroll intacto`)
          assert.equal(closed.bodyChildren, before.bodyChildren, "sin nodos acumulados")
          assert.equal(closed.scrollHeight, before.scrollHeight)
        }
      }
    } finally {
      await page.close()
    }
  })
}

const REASON = "La unidad llegó con el motor dañado."
const statTexts = async (page: Page) =>
  (await dialog(page).locator(".admin-replacement-modal__stat").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim())
const optionTexts = async (page: Page) =>
  (await variantSelect(page).locator("option").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim())
const stockText = async (page: Page) => (await dialog(page).locator(".admin-replacement-modal__stock").innerText()).replace(/\s+/g, " ")
const primaryButton = (page: Page) => dialog(page).locator(".admin-replacement-modal__button.is-primary")
const missingText = (page: Page) => dialog(page).locator(".admin-replacement-modal__missing")
const noticeText = (page: Page) => dialog(page).locator(".admin-replacement-modal__notice")

async function submitAndReadPayload(page: Page) {
  await primaryButton(page).click()
  await primaryButton(page).click()
  await dialog(page).waitFor({ state: "detached" })
  const posts = (await page.evaluate("window.__posts")) as Array<Record<string, unknown>>
  assert.equal(posts.length, 1)
  const { idempotencyKey, ...payload } = posts[0]
  assert.equal(typeof idempotencyKey, "string")
  return payload
}

test("caso normal: ítem fijo, sin buscador, variante original preseleccionada y mismo payload", async () => {
  const page = await open("dark")
  try {
    await openFromStep(page)
    const modal = dialog(page)
    // 1. Un solo ítem reclamado: informativo, sin selector de ítem.
    assert.match(await modal.getByTestId("replacement-original-item").innerText(), /Trípode Ñandú[\s\S]*Negro[\s\S]*SKU TRIO1/)
    assert.equal(await modal.locator("select").count(), 1, "sólo el select de variante")
    // 3. Sin buscador global.
    assert.equal(await modal.locator('input:not([type="checkbox"]):not([type="number"])').count(), 0)
    assert.equal(await modal.getByText("Buscar producto de reemplazo").count(), 0)
    assert.equal(await modal.getByText("Producto de reemplazo", { exact: true }).count(), 0)
    // 14. Pendientes de reemplazo = cálculo actual (recibidas − ya reemplazadas).
    assert.deepEqual(await statTexts(page), ["Recibimos 1", "Ya reemplazadas 0", "Pendientes de reemplazo 1"])
    // 4. Sólo variantes del mismo producto (no el aro del mismo pedido).
    assert.deepEqual(await optionTexts(page), [
      "Elegir variante",
      "Negro (original) · SKU TRIO1 · Stock 3",
      "Azul · SKU TRIO2 · Stock 1",
      "Rojo · SKU TRIO3 · Sin stock",
    ])
    // 5. Variante original con stock: preseleccionada.
    assert.equal(await variantSelect(page).inputValue(), "9")
    assert.match(await stockText(page), /Stock disponible 3 unidades Stock después del reemplazo 2 unidades/)
    assert.equal(await missingText(page).innerText(), "Escribí el motivo del reemplazo (mínimo 10 caracteres).")

    await modal.locator("textarea").fill(REASON)
    assert.equal(await primaryButton(page).isEnabled(), true)
    assert.equal(await missingText(page).count(), 0)

    // 12. Cantidad no supera pendientes (1 recibida).
    const quantity = modal.locator('input[type="number"]')
    assert.equal(await quantity.inputValue(), "1", "arranca en 1")
    assert.equal(await quantity.getAttribute("max"), "1")
    assert.equal(await modal.getByRole("button", { name: "Sumar una unidad" }).isDisabled(), true)
    await quantity.fill("2")
    assert.equal(await primaryButton(page).isDisabled(), true)
    assert.equal(await missingText(page).innerText(), "La cantidad supera las unidades pendientes de reemplazo.")
    await quantity.fill("0")
    assert.equal(await missingText(page).innerText(), "Indicá una cantidad válida.")

    // "Continuar sin recepción previa": 3 pendientes, sigue siendo el mismo producto.
    await modal.getByLabel("Continuar sin recepción previa", { exact: true }).check()
    await quantity.fill("1")
    assert.equal(await quantity.getAttribute("max"), "3")
    assert.equal(await optionTexts(page).then((options) => options.length), 4, "mismas variantes con garantía")
    await modal.getByRole("button", { name: "Sumar una unidad" }).click()
    await modal.getByRole("button", { name: "Sumar una unidad" }).click()
    assert.equal(await quantity.inputValue(), "3")
    assert.match(await stockText(page), /Stock después del reemplazo 0 unidades/)

    // 13. Cantidad no supera stock: Azul tiene 1.
    await variantSelect(page).selectOption("10")
    assert.equal(await quantity.getAttribute("max"), "1")
    assert.equal(await missingText(page).innerText(), "No hay stock suficiente de la variante elegida.")
    // 11. Variante con stock 0: bloquea con mensaje claro.
    await variantSelect(page).selectOption("11")
    assert.equal(await primaryButton(page).isDisabled(), true)
    assert.equal(await missingText(page).count(), 0, "advertencia visible una sola vez")
    assert.equal(await noticeText(page).innerText(), "Esta variante no tiene stock disponible.")

    await variantSelect(page).selectOption("9")
    await quantity.fill("2")
    await primaryButton(page).click()
    assert.match(await modal.getByRole("status").innerText(), /Vas a retirar 2 unidades de SKU TRIO1 para reemplazar 2 unidades del pedido #500\./)
    assert.equal(await modal.locator("textarea").isDisabled(), true, "formulario bloqueado durante la confirmación")
    assert.equal(await primaryButton(page).innerText(), "Confirmar retiro de stock")
    await primaryButton(page).click()
    await dialog(page).waitFor({ state: "detached" })
    const posts = (await page.evaluate("window.__posts")) as Array<Record<string, unknown>>
    const { idempotencyKey, ...payload } = posts[0]
    assert.equal(typeof idempotencyKey, "string")
    assert.deepEqual(payload, { orderItemId: 71, replacementVariantId: 9, quantity: 2, claimId: 900, reason: "garantia", notes: REASON })
  } finally {
    await page.close()
  }
})

test("variante original sin stock: no se cambia sola; se puede elegir otra del mismo producto", async () => {
  const page = await open("light", 1440, 1000, css, "original-sin-stock")
  try {
    await openFromStep(page)
    const modal = dialog(page)
    // 6. Sin preselección silenciosa + aviso claro.
    assert.equal(await variantSelect(page).inputValue(), "")
    assert.equal(await noticeText(page).innerText(), "La variante original (Negro) no tiene stock disponible. Elegí otra variante del mismo producto.")
    await modal.locator("textarea").fill(REASON)
    assert.equal(await primaryButton(page).isDisabled(), true)
    assert.equal(await missingText(page).innerText(), "Seleccioná la variante a enviar.")
    assert.match(await stockText(page), /Seleccioná la variante a enviar para calcular el stock\./)
    // 7. Otra variante del mismo producto.
    await variantSelect(page).selectOption("10")
    assert.match(await stockText(page), /Stock disponible 2 unidades Stock después del reemplazo 1 unidad/)
    assert.equal(await primaryButton(page).isEnabled(), true)
    assert.deepEqual(await submitAndReadPayload(page), { orderItemId: 71, replacementVariantId: 10, quantity: 1, claimId: 900, reason: "otra_variante", notes: REASON })
  } finally {
    await page.close()
  }
})

test("varios ítems reclamados: pide el ítem original y filtra variantes por su producto; historial previo intacto", async () => {
  const page = await open("dark", 1440, 1000, css, "multi")
  try {
    await openFromStep(page)
    const modal = dialog(page)
    // 2. Selector de ítem original.
    assert.equal(await modal.getByTestId("replacement-original-item").count(), 0)
    const itemSelect = modal.locator("select").first()
    assert.equal(await itemSelect.inputValue(), "")
    assert.equal(await missingText(page).innerText(), "Seleccioná el ítem original.")
    assert.match(await modal.innerText(), /Elegí el ítem original para ver sus variantes\./)

    // 15. Historial del flujo anterior (otro_producto) se sigue listando y contando.
    await itemSelect.selectOption("72")
    assert.deepEqual(await statTexts(page), ["Recibimos 1", "Ya reemplazadas 1", "Pendientes de reemplazo 0"])
    // Aro: una sola variante -> automática, sin select de variante.
    assert.equal(await modal.locator("select").count(), 1)
    assert.match(await modal.getByTestId("replacement-variant").innerText(), /Blanco[\s\S]*SKU ARO1[\s\S]*Stock 4/)

    await itemSelect.selectOption("71")
    assert.deepEqual(await optionTexts(page), ["Elegir variante", "Negro (original) · SKU TRIO1 · Stock 3", "Azul · SKU TRIO2 · Stock 1"])
    assert.equal(await variantSelect(page).inputValue(), "9")
    await modal.locator("textarea").fill(REASON)
    assert.deepEqual(await submitAndReadPayload(page), { orderItemId: 71, replacementVariantId: 9, quantity: 1, claimId: 900, reason: "mismo_producto", notes: REASON })
  } finally {
    await page.close()
  }
  const history = await open("dark", 1440, 1000, css, "multi")
  try {
    await history.getByText("Reemplazo previo por otro producto").waitFor()
    assert.match(await history.locator("#order-replacements-500").innerText(), /1 unidades · Cambio · Variante #999/)
  } finally {
    await history.close()
  }
})

for (const [scenarioName, variantLabel, sku] of [["una-variante", "Negro", "TRIO1"], ["sin-variantes", "Única", "TRIPODE"]] as const) {
  test(`${scenarioName}: la variante se toma automáticamente, sin select`, async () => {
    const page = await open("dark", 1440, 1000, css, scenarioName)
    try {
      await openFromStep(page)
      const modal = dialog(page)
      // 9 / 10. Selección automática informativa.
      assert.equal(await modal.locator("select").count(), 0)
      assert.match(await modal.getByTestId("replacement-variant").innerText(), new RegExp(`${variantLabel}[\\s\\S]*SKU ${sku}`))
      await modal.locator("textarea").fill(REASON)
      assert.equal(await primaryButton(page).isEnabled(), true)
      const payload = await submitAndReadPayload(page)
      assert.equal(payload.replacementVariantId, scenarioName === "una-variante" ? 9 : 30)
      assert.equal(payload.reason, scenarioName === "una-variante" ? "mismo_producto" : "otra_variante")
    } finally {
      await page.close()
    }
  })
}

test("sin stock en ninguna variante del producto: bloquea con mensaje claro", async () => {
  const page = await open("light", 1440, 1000, css, "sin-stock")
  try {
    await openFromStep(page)
    const modal = dialog(page)
    await modal.locator("textarea").fill(REASON)
    assert.equal(await variantSelect(page).inputValue(), "", "no elige una variante sin stock")
    assert.equal(await noticeText(page).innerText(), "No hay stock disponible de este producto para realizar el reemplazo.")
    assert.equal(await missingText(page).count(), 0, "advertencia visible una sola vez")
    await variantSelect(page).selectOption("10")
    assert.equal(await primaryButton(page).isDisabled(), true)
  } finally {
    await page.close()
  }
})

test("producto sin variantes activas: informa y no permite confirmar", async () => {
  const page = await open("dark", 1440, 1000, css, "sin-variantes-activas")
  try {
    await openFromStep(page)
    const modal = dialog(page)
    await modal.locator("textarea").fill(REASON)
    assert.equal(await modal.locator("select").count(), 0)
    assert.equal(await noticeText(page).innerText(), "Este producto no tiene variantes activas para realizar el reemplazo.")
    assert.equal(await missingText(page).count(), 0, "advertencia visible una sola vez")
    assert.equal(await modal.locator(".admin-replacement-modal__stock").count(), 0, "sin panel de stock vacío")
    assert.equal(await primaryButton(page).isDisabled(), true)
  } finally {
    await page.close()
  }
})

test("tooltips (?) aparecen con hover y con foco de teclado, sin recortarse", async () => {
  for (const width of [1440, 360]) {
    const page = await open("light", width, 800)
    try {
      await openFromStep(page)
      const tips = dialog(page).locator(".admin-claim-help")
      const labels = await dialog(page).locator(".admin-claim-help-trigger").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))
      assert.deepEqual(labels, [
        "Ayuda: Continuar sin recepción previa",
        "Ayuda: Motivo del reemplazo",
        "Ayuda: Variante a enviar",
        "Ayuda: Cantidad",
        "Ayuda: Stock",
      ])
      const count = await tips.count()
      for (let index = 0; index < count; index++) {
        const tip = tips.nth(index)
        const bubble = tip.locator('[role="tooltip"]')
        assert.equal(await bubble.isVisible(), false)
        await tip.locator("button").hover()
        await bubble.waitFor({ state: "visible" })
        await page.waitForTimeout(180)
        const box = (await bubble.boundingBox())!
        assert.ok(box.x >= 0 && box.x + box.width <= width, `${labels[index]} (${width}px): dentro del ancho (${box.x}..${box.x + box.width})`)
        const opacity = await bubble.evaluate((node) => getComputedStyle(node).opacity)
        assert.equal(opacity, "1")
        await page.mouse.move(0, 0)
        await bubble.waitFor({ state: "hidden" })
      }
      // Teclado: foco muestra, Escape oculta sin cerrar el modal.
      await tips.first().locator("button").focus()
      await tips.first().locator('[role="tooltip"]').waitFor({ state: "visible" })
      const described = await tips.first().locator("button").getAttribute("aria-describedby")
      assert.equal(await tips.first().locator('[role="tooltip"]').getAttribute("id"), described)
      await page.keyboard.press("Escape")
      await tips.first().locator('[role="tooltip"]').waitFor({ state: "hidden" })
      assert.equal(await dialog(page).count(), 1, "Escape en el tooltip no cierra el modal")
    } finally {
      await page.close()
    }
  }
})

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: todo texto del formulario cumple contraste AA contra su fondo real`, async () => {
    const page = await open(theme)
    try {
      await openFromStep(page)
      for (const state of ["vacío", "completo", "confirmación"]) {
        if (state === "completo") await fillValidForm(page)
        if (state === "confirmación") await dialog(page).getByRole("button", { name: "Revisar reemplazo" }).click()
        const { audited, failures, dialogLum } = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[]; dialogLum: number }
        assert.ok(audited > 20, `${state}: se auditaron ${audited} textos`)
        assert.deepEqual(failures, [], state)
        if (theme === "light") assert.ok(dialogLum > 0.9, `${state}: superficie clara (${dialogLum.toFixed(3)})`)
        else assert.ok(dialogLum < 0.05, `${state}: superficie oscura (${dialogLum.toFixed(3)})`)
      }
    } finally {
      await page.close()
    }
  })
}

test("responsive: formulario compacto sin overflow y con acciones accesibles", async () => {
  for (const [width, height] of [[360, 740], [768, 1024], [1366, 768], [1440, 900]] as const) {
    const page = await open("dark", width, height)
    try {
      await openFromStep(page)
      await fillValidForm(page)
      const layout = (await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"]')
        const r = d.getBoundingClientRect()
        const overflowing = [...d.querySelectorAll("*")].filter((el) => {
          const b = el.getBoundingClientRect()
          return b.width > 0 && (b.left < r.left - 0.5 || b.right > r.right + 0.5) && !el.closest('[role="tooltip"]')
        }).map((el) => el.className.toString().slice(0, 50))
        const stats = getComputedStyle(d.querySelector(".admin-replacement-modal__stats")).gridTemplateColumns.split(" ").length
        const body = d.querySelector(".admin-replacement-modal__body")
        return { left: r.left, right: r.right, height: r.height, bodyScrollable: body.scrollHeight > body.clientHeight + 1, docOverflow: document.documentElement.scrollWidth > window.innerWidth, overflowing, stats }
      })()`)) as { left: number; right: number; height: number; bodyScrollable: boolean; docOverflow: boolean; overflowing: string[]; stats: number }
      assert.ok(layout.left >= 0 && layout.right <= width, `${width}px: diálogo dentro del viewport`)
      assert.equal(layout.docOverflow, false, `${width}px: sin scroll horizontal`)
      if (width >= 1200) assert.equal(layout.bodyScrollable, false, `${width}px: formulario visible sin scroll interno`)
      assert.deepEqual(layout.overflowing, [], `${width}px: nada se sale del diálogo`)
      assert.equal(layout.stats, width < 480 ? 1 : 3, `${width}px: columnas de stats`)
      const primary = dialog(page).getByRole("button", { name: "Revisar reemplazo" })
      await primary.scrollIntoViewIfNeeded()
      assert.equal(await primary.isVisible(), true, `${width}px: acción principal alcanzable`)
      const box = (await primary.boundingBox())!
      assert.ok(box.height >= 40, `${width}px: target táctil (${box.height})`)
    } finally {
      await page.close()
    }
  }
})

test("Volver al paso anterior conserva la acción y desplaza al encabezado", async () => {
  const page = await open("dark")
  try {
    await page.evaluate("window.__scrollIntoViewCalls = 0")
    await page.getByRole("button", { name: "Volver al paso anterior" }).click()
    await page.waitForFunction("window.__scrollIntoViewCalls === 1")
    assert.match(await page.locator('.admin-claim-wizard-steps [aria-current="step"]').innerText(), /Recepción/)
    await page.locator(".admin-claim-wizard-steps").getByRole("button", { name: /Reemplazo/ }).click()
    await page.waitForFunction("window.__scrollIntoViewCalls === 2")
    assert.match(await page.locator('.admin-claim-wizard-steps [aria-current="step"]').innerText(), /Reemplazo/)
    await page.waitForTimeout(400)
    assert.equal(await page.evaluate("window.__scrollIntoViewCalls"), 2, "sin salto por refresco de datos")
  } finally {
    await page.close()
  }
})

test("contrato: ambos botones usan openReplacementModal y ningún camino desplaza la página", () => {
  const pedidos = readFileSync("app/admin/sections/pedidos/admin-pedidos.tsx", "utf8")
  assert.match(pedidos, /openRequest=\{replacementOpenRequest\?\.orderId === pedido\.id \? replacementOpenRequest : null\}/)
  assert.match(pedidos, /onRegisterReplacement=\{capabilities\.canManageReplacements \? openReplacementModal : undefined\}/)
  const claims = readFileSync("components/claims/admin-claim-manager.tsx", "utf8")
  assert.match(claims, /onClick=\{\(\) => onRegisterReplacement\?\.\(/, "el paso reutiliza el gestor de reemplazos")
  const replacements = readFileSync("app/admin/sections/pedidos/order-replacements.tsx", "utf8")
  assert.match(replacements, /onClick=\{\(\) => openReplacementModal\(null\)\}>Registrar reemplazo/)
  assert.match(replacements, /openReplacementModal\(openRequest\.orderItemId\)/)
  assert.doesNotMatch(replacements, /scrollIntoView|scrollTo\(/)
  assert.match(replacements, /createPortal\(/)
  assert.doesNotMatch(replacements, /<AdminModal/)
  const focus = readFileSync("lib/admin/modal-focus.ts", "utf8")
  assert.equal(focus.match(/\.focus\(/g)?.length, focus.match(/\.focus\(\{ preventScroll: true \}\)/g)?.length, "todo focus del modal sin scroll")
})
