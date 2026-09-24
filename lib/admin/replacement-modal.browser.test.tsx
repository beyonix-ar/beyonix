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
window.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes("/replacements")) {
    if (init && init.method === "POST") { window.__posts.push(JSON.parse(init.body)); return json({ ok: true }) }
    return json({
      replacements: [],
      variants: [
        { id: 9, nombre: "Negro", sku: "REP-9", stock: 5, productos: { nombre: "Trípode inteligente" } },
        { id: 10, nombre: "Blanco", sku: "REP-10", stock: 1, productos: [{ nombre: "Trípode inteligente" }] },
      ],
    })
  }
  return json({ error: "sin datos en el test" }, 404)
}

const producto = { id: 1, nombre: "Trípode Ñandú", slug: "t", descripcion: null, precio: 20000, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" }
const claim = {
  id: 900, order_id: 500, user_id: "c", claim_type: "garantia_beyonix", failure_type: "falla",
  status: "aprobado", resolution: "cambio_producto", description: "Producto afectado: Trípode Ñandú\\n\\nNo gira.",
  affected_items: [{ order_item_id: 71, quantity: 1 }],
  order_claim_messages: [], order_claim_files: [],
  created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:05:00Z",
}
const pedido = {
  id: 500, usuario_id: null, estado: "entregado", total: 60000, created_at: "2026-09-19T12:00:00Z",
  payment_method_id: "mercadopago", shipping_type: "domicilio",
  orden_items: [{ id: 71, orden_id: 500, producto_id: 1, variante_id: 9, cantidad: 3, precio: 20000, productos: producto, producto_variantes: { nombre: "Negro" }, return_restocked_quantity: 1, return_written_off_quantity: 0 }],
  order_claims: [claim],
}

function Harness() {
  const [openRequest, setOpenRequest] = useState(null)
  return (
    <>
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
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
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

async function open(theme: "dark" | "light", width = 1440, height = 1000): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } })
  // Origen localhost = contexto seguro (crypto.randomUUID, como en producción HTTPS).
  const html = pageHtml(theme, css, bundle)
  await page.route("**/*", (route) =>
    route.request().url() === "http://localhost/replacement" ? route.fulfill({ contentType: "text/html", body: html }) : route.abort(),
  )
  await page.goto("http://localhost/replacement")
  await page.waitForSelector(".admin-claim-flow")
  return page
}

const stepButton = (page: Page) => page.locator(".admin-claim-flow button", { hasText: "Registrar reemplazo" })
const dialog = (page: Page) => page.locator('[role="dialog"]')

async function openFromStep(page: Page) {
  const button = stepButton(page)
  await button.scrollIntoViewIfNeeded()
  await page.evaluate("window.__scrollIntoViewCalls = 0")
  await button.click()
  await dialog(page).waitFor()
  // El GET de variantes lleva un debounce de 300 ms.
  await page.locator('[role="dialog"] select').nth(1).locator("option", { hasText: "REP-9" }).waitFor({ state: "attached" })
}

async function fillValidForm(page: Page) {
  const modal = dialog(page)
  await modal.locator("textarea").fill("La unidad llegó con el motor dañado.")
  await modal.locator("select").nth(1).selectOption("9")
  // Deja terminar la transición de color del botón primario (150 ms).
  await page.waitForTimeout(250)
}

test("el botón del PASO 2 abre directamente el formulario, sin scroll y en un Portal", async () => {
  const page = await open("dark")
  try {
    // Esperar la carga inicial de la sección (cambia su alto y el navegador
    // compensa el scroll por scroll anchoring, ajeno al click).
    await page.getByText("Todavía no hay reemplazos registrados.").waitFor()
    const button = stepButton(page)
    assert.equal(await button.isEnabled(), true, "paso 2 habilitado con el original recibido")
    await button.scrollIntoViewIfNeeded()
    const before = (await page.evaluate("window.scrollY")) as number
    assert.ok(before > 1000, `el paso 2 queda lejos del inicio (scrollY ${before})`)
    await page.evaluate("window.__scrollIntoViewCalls = 0")
    await button.click()
    await dialog(page).waitFor()
    assert.equal(await page.evaluate("window.__scrollIntoViewCalls"), 0, "no se llama scrollIntoView")
    assert.equal(await page.evaluate("window.scrollY"), before, "la página no se desplaza")
    assert.equal(await dialog(page).count(), 1, "un solo diálogo")
    const placement = (await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]')
      const r = d.getBoundingClientRect()
      return {
        portal: d.parentElement.parentElement === document.body,
        outsideScope: !d.closest(".admin-order-detail-scope"),
        inViewport: r.top >= 0 && r.top < window.innerHeight,
        modal: d.getAttribute("aria-modal"),
        focusInside: d.contains(document.activeElement),
      }
    })()`)) as Record<string, unknown>
    assert.deepEqual(placement, { portal: true, outsideScope: true, inViewport: true, modal: "true", focusInside: true })
    await assert.doesNotReject(dialog(page).getByRole("heading", { name: "Reemplazo del pedido #500" }).waitFor())
    // Reusa el formulario existente: el ítem reclamado llega preseleccionado.
    assert.equal(await dialog(page).locator("select").first().inputValue(), "71")

    // Cerrar y reabrir desde el paso: cada click vuelve a abrir (nonce nuevo).
    await dialog(page).getByRole("button", { name: "Cancelar" }).click()
    assert.equal(await dialog(page).count(), 0)
    await button.click()
    await dialog(page).waitFor()
    assert.equal(await page.evaluate("window.scrollY"), before)
    await page.keyboard.press("Escape")
    assert.equal(await dialog(page).count(), 0, "Escape cierra")
  } finally {
    await page.close()
  }
})

test("el botón propio de la sección abre el mismo formulario", async () => {
  const page = await open("light")
  try {
    await page.locator("#order-replacements-500 button", { hasText: "Registrar reemplazo" }).click()
    await dialog(page).waitFor()
    assert.equal(await dialog(page).count(), 1)
    assert.equal(await dialog(page).locator("select").first().inputValue(), "", "sin preselección desde la sección")
  } finally {
    await page.close()
  }
})

test("selects, cantidad, stock y confirmación conservan la lógica existente", async () => {
  const page = await open("dark")
  try {
    await openFromStep(page)
    const modal = dialog(page)
    const primary = modal.locator(".admin-replacement-modal__button.is-primary")
    const missing = modal.locator(".admin-replacement-modal__missing")

    // Estado inicial: stats del ítem y stock neutral.
    const stats = await modal.locator(".admin-replacement-modal__stat").allInnerTexts()
    assert.deepEqual(stats.map((text) => text.replace(/\s+/g, " ").trim()), ["Recibimos 1", "Ya reemplazadas 0", "Disponibles para reemplazar 1"])
    assert.match(await modal.locator(".admin-replacement-modal__stock").innerText(), /Seleccioná un producto para calcular el stock\./)
    assert.equal(await primary.isDisabled(), true)
    assert.equal(await missing.innerText(), "Escribí el motivo del reemplazo (mínimo 10 caracteres).")

    await modal.locator("textarea").fill("La unidad llegó con el motor dañado.")
    assert.equal(await missing.innerText(), "Seleccioná un producto de reemplazo.")

    // Variante: resumen con nombre, variante, SKU y stock.
    await modal.locator("select").nth(1).selectOption("9")
    const summary = await modal.locator(".admin-replacement-modal__selection").innerText()
    assert.match(summary, /Trípode inteligente/)
    assert.match(summary, /Negro/)
    assert.match(summary, /SKU REP-9/)
    assert.match(summary, /Stock 5/)
    assert.match(await modal.locator(".admin-replacement-modal__stock").innerText(), /Stock disponible\s*5 unidades[\s\S]*Stock después del reemplazo\s*4 unidades/)
    assert.equal(await primary.isEnabled(), true)
    assert.equal(await missing.count(), 0)

    // Buscar vuelve a limpiar la variante elegida (misma lógica que antes).
    await modal.locator('input[placeholder="Ej.: Trípode inteligente negro"]').fill("negro")
    assert.equal(await modal.locator("select").nth(1).inputValue(), "")
    assert.equal(await primary.isDisabled(), true)
    await modal.locator("select").nth(1).locator("option", { hasText: "REP-9" }).waitFor({ state: "attached" })
    await modal.locator("select").nth(1).selectOption("9")

    // Cantidad: límites min/max y validación (sólo 1 recibida).
    const quantity = modal.locator('input[type="number"]')
    assert.equal(await quantity.getAttribute("min"), "1")
    assert.equal(await quantity.getAttribute("max"), "1")
    assert.equal(await modal.getByRole("button", { name: "Sumar una unidad" }).isDisabled(), true)
    await quantity.fill("2")
    assert.equal(await primary.isDisabled(), true)
    assert.equal(await missing.innerText(), "La cantidad supera las unidades disponibles para reemplazar.")
    await quantity.fill("0")
    assert.equal(await missing.innerText(), "Indicá una cantidad válida.")
    await quantity.fill("1.5")
    assert.equal(await primary.isDisabled(), true)

    // "Continuar sin recepción previa" (garantía) habilita las 3 vendidas.
    await modal.getByLabel("Continuar sin recepción previa", { exact: true }).check()
    await quantity.fill("1")
    assert.equal(await quantity.getAttribute("max"), "3")
    await modal.getByRole("button", { name: "Sumar una unidad" }).click()
    await modal.getByRole("button", { name: "Sumar una unidad" }).click()
    assert.equal(await quantity.inputValue(), "3")
    assert.equal(await modal.getByRole("button", { name: "Sumar una unidad" }).isDisabled(), true, "tope en 3")
    assert.match(await modal.locator(".admin-replacement-modal__stock").innerText(), /Stock después del reemplazo\s*2 unidades/)
    await modal.getByRole("button", { name: "Restar una unidad" }).click()
    assert.equal(await quantity.inputValue(), "2")

    // Stock de la variante manda: la de stock 1 limita a 1.
    await modal.locator("select").nth(1).selectOption("10")
    assert.equal(await quantity.getAttribute("max"), "1")
    assert.equal(await missing.innerText(), "No hay stock suficiente del producto elegido.")
    await modal.locator("select").nth(1).selectOption("9")

    // Revisar -> confirmar: mismo texto y mismo payload que antes.
    await primary.click()
    assert.match(await modal.getByRole("status").innerText(), /Vas a retirar 2 unidades de SKU REP-9 para reemplazar 2 unidades del pedido #500\./)
    assert.equal(await modal.locator("textarea").isDisabled(), true, "formulario bloqueado durante la confirmación")
    assert.equal(await primary.innerText(), "Confirmar retiro de stock")
    await primary.click()
    await dialog(page).waitFor({ state: "detached" })
    const posts = (await page.evaluate("window.__posts")) as Array<Record<string, unknown>>
    assert.equal(posts.length, 1)
    const { idempotencyKey, ...payload } = posts[0]
    assert.equal(typeof idempotencyKey, "string")
    assert.deepEqual(payload, {
      orderItemId: 71,
      replacementVariantId: 9,
      quantity: 2,
      claimId: 900,
      reason: "garantia",
      notes: "La unidad llegó con el motor dañado.",
    })
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
        "Ayuda: Ítem original",
        "Ayuda: Continuar sin recepción previa",
        "Ayuda: Motivo del reemplazo",
        "Ayuda: Buscar producto de reemplazo",
        "Ayuda: Producto de reemplazo",
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

test("responsive: sin overflow horizontal y con acciones accesibles en mobile, tablet y desktop", async () => {
  for (const [width, height] of [[360, 740], [768, 1024], [1440, 900]] as const) {
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
        return { left: r.left, right: r.right, docOverflow: document.documentElement.scrollWidth > window.innerWidth, overflowing, stats }
      })()`)) as { left: number; right: number; docOverflow: boolean; overflowing: string[]; stats: number }
      assert.ok(layout.left >= 0 && layout.right <= width, `${width}px: diálogo dentro del viewport`)
      assert.equal(layout.docOverflow, false, `${width}px: sin scroll horizontal`)
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

test("contrato: admin-pedidos abre el formulario por openRequest y el paso 2 ya no hace scroll", () => {
  const pedidos = readFileSync("app/admin/sections/pedidos/admin-pedidos.tsx", "utf8")
  assert.match(pedidos, /openRequest=\{replacementOpenRequest\?\.orderId === pedido\.id \? replacementOpenRequest : null\}/)
  assert.match(pedidos, /capabilities\.canManageReplacements\s*\?\s*\(orderItemId\) =>\s*setReplacementOpenRequest/)
  const claims = readFileSync("components/claims/admin-claim-manager.tsx", "utf8")
  const handler = claims.slice(claims.indexOf("onRegisterReplacement={() => {"), claims.indexOf("onConfirmDelivery=", claims.indexOf("onRegisterReplacement={() => {")))
  assert.ok(handler.indexOf("return") < handler.indexOf("scrollIntoView"), "scroll sólo como respaldo sin gestor")
  const replacements = readFileSync("app/admin/sections/pedidos/order-replacements.tsx", "utf8")
  assert.match(replacements, /createPortal\(/)
  assert.doesNotMatch(replacements, /<AdminModal/)
})
