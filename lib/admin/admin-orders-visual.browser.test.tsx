import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Admin > Pedidos con el componente REAL (AdminPedidos, bundle esbuild) y el
// CSS del proyecto: listado, las 6 pestañas del detalle y el ajuste
// administrativo, en Light y Dark. Stubs sólo de infraestructura: auth,
// router (con URL real), Supabase, usePedidos (datos fijos) y fetch.

const stubs: Plugin = {
  name: "admin-orders-visual-stubs",
  setup(b) {
    const map: Record<string, string> = {
      "^@/context/auth-context$": "auth",
      "^@/lib/supabase/client$": "supabase",
      "^next/navigation$": "navigation",
      "^@/hooks/use-pedidos$": "pedidos",
    }
    for (const [filter, path] of Object.entries(map)) b.onResolve({ filter: new RegExp(filter) }, () => ({ path, namespace: "stub" }))
    b.onLoad({ filter: /^auth$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `export function useAuth() { return { user: { id: "u1", rol: "super_admin" }, isSuperAdmin: true, isAdmin: true } }`,
    }))
    b.onLoad({ filter: /^navigation$/, namespace: "stub" }, () => ({
      loader: "js",
      resolveDir: process.cwd(),
      contents: `import { useSyncExternalStore } from "react"
        const listeners = new Set()
        const go = (url) => { history.replaceState(null, "", url); listeners.forEach((l) => l()) }
        const router = { push: go, replace: go, refresh() {}, back() {}, prefetch() {} }
        const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l) }
        let cached = { key: null, value: null }
        const snapshot = () => { if (cached.key !== location.search) cached = { key: location.search, value: new URLSearchParams(location.search) }; return cached.value }
        export function useRouter() { return router }
        export function usePathname() { return useSyncExternalStore(subscribe, () => location.pathname) }
        export function useSearchParams() { return useSyncExternalStore(subscribe, snapshot) }`,
    }))
    b.onLoad({ filter: /^supabase$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `
        const channel = { on() { return channel }, subscribe() { return channel } }
        const query = new Proxy(function () {}, { get: (t, k) => k === "then" ? (res) => res({ data: [], error: null, count: 0 }) : query, apply: () => query })
        export const supabase = {
          auth: { getSession: async () => ({ data: { session: { access_token: "t" } }, error: null }), onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } } } },
          channel: () => channel, removeChannel: async () => "ok", from: () => query, rpc: () => query,
        }
        export function createClient() { return supabase }
        export function isInvalidRefreshTokenError() { return false }
        export function isMissingAuthSessionError() { return false }
        export function clearSupabaseBrowserSession() {}
        export async function getSafeSupabaseSession() { return null }`,
    }))
    b.onLoad({ filter: /^pedidos$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `export function usePedidos() {
        return { pedidos: window.__pedidos, total: window.__pedidos.length, hasMore: false, loadMore() {}, loading: false, error: null,
          async updatePedidoEstado() {}, async reloadPedidos() {} }
      }`,
    }))
  },
}

const ENTRY = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { AdminPedidos } from "@/app/admin/sections/pedidos/admin-pedidos"
import { AdminThemeProvider } from "@/context/admin-theme-context"
window.__creditNotePosts = []
window.fetch = async (input, init) => {
  if (String(input).includes("/credit-note") && init && init.method === "POST") {
    window.__creditNotePosts.push(JSON.parse(init.body))
    return Response.json({ error: "Sin emisión en el test." }, { status: 400 })
  }
  return Response.json({ error: "sin datos" }, { status: 404 })
}
createRoot(document.getElementById("root")).render(
  createElement(AdminThemeProvider, null, createElement(AdminPedidos, window.__initialOrderId ? { initialOrderId: window.__initialOrderId } : {})),
)
`

const producto = { id: 1, nombre: "Trípode Ñandú", slug: "t", descripcion: null, precio: 45000, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" }
const order = (id: number, extra: Record<string, unknown>) => ({
  id, usuario_id: "c1", cliente_nombre: "María Núñez", cliente_email: "maria@example.test", cliente_telefono: "1122334455",
  estado: "pendiente", admin_visible_at: "2026-09-20T12:05:00Z", total: 45000, subtotal: 45000, created_at: "2026-09-20T12:00:00Z",
  payment_method_id: "mercadopago", payment_status: "approved", financial_status: "payment_confirmed", payment_confirmed_at: "2026-09-20T12:05:00Z",
  shipping_type: "domicilio", shipping_provider: "andreani", envio_proveedor: "andreani",
  invoice_status: "issued", invoice_cae: "123", invoice_number: 10, invoice_point: 1, invoice_created_at: "2026-09-20T13:00:00Z",
  orden_items: [{ id: id * 10, orden_id: id, producto_id: 1, cantidad: 1, precio: 45000, productos: producto }],
  order_claims: [], order_credit_notes: [], order_audit_events: [], ...extra,
})
// En proceso, completado/entregado, cancelado y transferencia pendiente.
const PEDIDOS = [
  // Facturado (CAE autorizado) y sin preparar: muestra el camioncito.
  order(1, { invoice_status: "authorized" }),
  order(2, { estado: "entregado", delivered_at: "2026-09-22T10:00:00Z" }),
  order(3, { estado: "cancelado", financial_status: "cancelled", cancelled_at: "2026-09-21T10:00:00Z", payment_status: "cancelled" }),
  order(4, { payment_method_id: "transferencia", payment_status: "pending", financial_status: "pending_payment", payment_confirmed_at: null }),
]

const pageHtml = (theme: "dark" | "light", css: string, bundle: string, orderId?: number) => `<!doctype html>
<html data-admin-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div id="root"></div></main></div>
<script>window.__pedidos = ${JSON.stringify(orderId ? PEDIDOS.filter((p) => p.id === orderId) : PEDIDOS)}; window.__initialOrderId = ${orderId ?? 0}</script>
<script>${bundle}</script></body></html>`

// Helpers de color (canvas: acepta oklch/oklab/color-mix), ejecutados como string.
const COLOR_HELPERS = `
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const parse = (v) => { if (!v || v === "none" || v === "transparent") return [0, 0, 0, 0]; ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = v; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
  const key = (v) => parse(v).map((n) => Math.round(n * 100) / 100).join(",")
  const lum = (c) => { const ch = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }; return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]) }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const over = (t, b) => { const a = t[3]; return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1] }
  const firstStop = (img) => { const m = /(rgba?|oklch|oklab|lab|color)\\(/.exec(img || ""); if (!m) return null; let i = m.index + m[0].length, l = 1; while (i < img.length && l > 0) { if (img[i] === "(") l++; else if (img[i] === ")") l--; i++ } return img.slice(m.index, i) }
  const effectiveBg = (el) => { const layers = []; for (let n = el; n; n = n.parentElement) { const s = getComputedStyle(n); const stop = firstStop(s.backgroundImage); if (stop) { const c = parse(stop); layers.push(c); if (c[3] >= 0.95) break } const c = parse(s.backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 0.95) break } } let r = [255, 255, 255, 1]; for (let i = layers.length - 1; i >= 0; i--) r = over(layers[i], r); return r }
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-orders-visual-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://x.invalid"', "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"k"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light", { width = 1440, orderId, tab }: { width?: number; orderId?: number; tab?: string } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } })
  page.setDefaultTimeout(15000)
  const html = pageHtml(theme, css, bundle, orderId)
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://localhost/pedidos") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort(),
  )
  await page.goto(`http://localhost/pedidos${tab ? `?tab=${tab}` : ""}`)
  await page.waitForSelector(orderId ? 'aside[aria-label="Secciones del pedido"]' : ".admin-orders-list-row")
  await page.mouse.move(0, 0)
  return page
}

// ───────────────────────────── Ajuste administrativo ─────────────────────────

const TRIGGER = 'button[aria-label="Seleccionar tipo de gestión"]'
const MONEY = ".admin-credit-adjustment-panel .admin-credit-note-money-input"

async function openAdjustment(theme: "dark" | "light", width = 1440) {
  const page = await open(theme, { width, orderId: 1, tab: "facturacion" })
  await page.getByRole("button", { name: "Registrar ajuste administrativo" }).click()
  await page.waitForSelector(TRIGGER)
  return page
}

const CONTROL_METRICS = `(() => { ${COLOR_HELPERS}
  const trigger = document.querySelector('${TRIGGER}'); const label = trigger.querySelector("span span:last-child")
  const money = document.querySelector('${MONEY}'); const input = money.querySelector("input")
  const t = trigger.getBoundingClientRect(), m = money.getBoundingClientRect(), panel = document.querySelector(".admin-credit-adjustment-panel").getBoundingClientRect()
  return { triggerWidth: t.width, triggerLeft: t.left, moneyWidth: m.width, moneyLeft: m.left, panelWidth: panel.width,
    labelText: label.textContent, labelContrast: ratio(over(parse(getComputedStyle(label).color), effectiveBg(trigger)), effectiveBg(trigger)),
    triggerLum: lum(effectiveBg(trigger)), inputContrast: ratio(over(parse(getComputedStyle(input).color), effectiveBg(input)), effectiveBg(input)) }
})()`

for (const theme of ["light", "dark"] as const) {
  test(`1-4 (${theme}): "Tipo de gestión" legible y compacto, menú del mismo ancho, monto compacto y alineado`, async () => {
    const page = await openAdjustment(theme)
    try {
      const metrics = (await page.evaluate(CONTROL_METRICS)) as Record<string, number | string>
      assert.equal(metrics.labelText, "Ajuste manual")
      assert.ok(Number(metrics.labelContrast) >= 7, `texto seleccionado legible (${metrics.labelContrast})`)
      if (theme === "light") assert.ok(Number(metrics.triggerLum) > 0.8, "Light: fondo claro")
      else assert.ok(Number(metrics.triggerLum) < 0.05, "Dark: se mantiene navy")
      assert.ok(Number(metrics.triggerWidth) >= 240 && Number(metrics.triggerWidth) <= 320, `select compacto (${metrics.triggerWidth}px)`)
      assert.ok(Number(metrics.triggerWidth) < Number(metrics.panelWidth) / 2, "no ocupa todo el ancho")
      assert.ok(Number(metrics.moneyWidth) >= 220 && Number(metrics.moneyWidth) <= 280, `monto compacto (${metrics.moneyWidth}px)`)
      assert.equal(metrics.moneyWidth, metrics.triggerWidth, "monto alineado con el select (mismo ancho)")
      assert.equal(metrics.moneyLeft, metrics.triggerLeft, "monto alineado con el select (mismo borde)")
      assert.ok(Number(metrics.inputContrast) >= 7, "monto legible")

      // Menú: mismo ancho que el trigger, opciones legibles, seleccionada visible.
      await page.locator(TRIGGER).click()
      const menu = (await page.evaluate(`(() => { ${COLOR_HELPERS}
        const list = document.querySelector('[role="listbox"][aria-label="Seleccionar tipo de gestión"]')
        const options = [...list.querySelectorAll('[role="option"]')]
        return { width: list.getBoundingClientRect().width, overflow: list.scrollWidth > list.clientWidth,
          options: options.map((o) => { const s = getComputedStyle(o); return { text: o.textContent.trim(), selected: o.getAttribute("aria-selected") === "true", contrast: ratio(over(parse(s.color), effectiveBg(o)), effectiveBg(o)), bg: [key(s.backgroundColor), s.backgroundImage.slice(0, 60), key(s.borderTopColor), key(s.color)].join(" | ") } }) }
      })()`)) as { width: number; overflow: boolean; options: Array<{ text: string; selected: boolean; contrast: number; bg: string }> }
      assert.equal(menu.width, metrics.triggerWidth, "menú del mismo ancho que el trigger")
      assert.equal(menu.overflow, false)
      assert.deepEqual(menu.options.map((o) => [o.text, o.selected]), [["Ajuste manual", true], ["Reembolso excepcional", false]])
      for (const option of menu.options) assert.ok(option.contrast >= 4.5, `${option.text} legible (${option.contrast.toFixed(2)})`)
      assert.notEqual(menu.options[0].bg, menu.options[1].bg, "la opción seleccionada se distingue")
      await page.getByRole("option", { name: "Reembolso excepcional" }).click()
      assert.match(await page.locator(TRIGGER).innerText(), /Reembolso excepcional/)
    } finally {
      await page.close()
    }
  })
}

test("responsive: select y monto compactos sin desbordar en 1280, 1366, 1920 y mobile", async () => {
  for (const width of [1280, 1366, 1920, 390]) {
    const page = await openAdjustment("light", width)
    try {
      const layout = (await page.evaluate(`(() => {
        const panel = document.querySelector(".admin-credit-adjustment-panel"); const p = panel.getBoundingClientRect()
        const t = document.querySelector('${TRIGGER}').getBoundingClientRect(); const m = document.querySelector('${MONEY}').getBoundingClientRect()
        return { panel: p.width, trigger: t.width, money: m.width, inside: t.left >= p.left && t.right <= p.right && m.right <= p.right, docOverflow: document.documentElement.scrollWidth > innerWidth }
      })()`)) as { panel: number; trigger: number; money: number; inside: boolean; docOverflow: boolean }
      assert.equal(layout.inside, true, `${width}px: dentro del panel`)
      assert.equal(layout.docOverflow, false, `${width}px: sin scroll horizontal`)
      assert.equal(layout.trigger, layout.money, `${width}px: mismo ancho`)
      assert.ok(layout.trigger <= 320, `${width}px: compacto (${layout.trigger}px)`)
      if (layout.panel > 300) assert.ok(layout.trigger >= 240, `${width}px: suficiente para el texto (${layout.trigger}px)`)
    } finally {
      await page.close()
    }
  }
})

test("ayuda (?) del ajuste administrativo: tooltip con el texto pedido", async () => {
  const page = await openAdjustment("light")
  try {
    const help = page.locator(".admin-credit-adjustment-heading .admin-claim-help")
    await help.locator("button").hover()
    await help.locator('[role="tooltip"]').waitFor({ state: "visible" })
    assert.equal(await help.locator('[role="tooltip"]').innerText(),
      "Usá esta opción sólo para correcciones administrativas que no provienen de un reclamo del cliente, como ajustes contables, reembolsos excepcionales o gestiones autorizadas.")
    assert.equal(await page.getByRole("button", { name: "Ayuda: Ajuste administrativo/contable" }).count(), 1)
  } finally {
    await page.close()
  }
})

test("5-8: el monto no acepta letras/signos, coma y punto dan el mismo valor, máximo 2 decimales", async () => {
  const page = await openAdjustment("light")
  try {
    const input = page.locator(`${MONEY} input`)
    const error = page.locator(".admin-credit-adjustment-panel .admin-credit-adjustment-error")
    await input.pressSequentially("12a")
    assert.equal(await input.inputValue(), "12", "las letras no entran")
    assert.equal(await error.count(), 1, "se avisa el rechazo")
    await input.pressSequentially("3")
    assert.equal(await input.inputValue(), "123")
    assert.equal(await error.count(), 0, "un carácter válido limpia el aviso")
    for (const char of ["$", " ", "-", "+", "e"]) {
      await input.pressSequentially(char)
      assert.equal(await input.inputValue(), "123", `\"${char}\" no entra`)
      assert.equal(await error.count(), 1)
    }
    await input.fill("")
    await input.pressSequentially("1000,123")
    assert.equal(await input.inputValue(), "1000,12", "máximo 2 decimales")
    // Pegado inválido: se rechaza entero (no se transforma en otro monto).
    await input.fill("")
    await page.evaluate(`(() => { const i = document.querySelector('${MONEY} input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "$1000abc"); i.dispatchEvent(new Event("input", { bubbles: true })) })()`)
    assert.equal(await input.inputValue(), "")
    assert.equal(await error.count(), 1)

    await page.locator(".admin-credit-adjustment-panel textarea").fill("Ajuste contable autorizado por dirección.")
    const emit = page.getByRole("button", { name: "Emitir nota de crédito" })
    const payloadFor = async (value: string) => {
      await input.fill(value)
      assert.equal(await error.count(), 0, `${value} es válido`)
      await emit.click()
      await page.waitForFunction("window.__creditNotePosts.length > 0")
      const [body] = (await page.evaluate("window.__creditNotePosts.splice(0)")) as Array<Record<string, unknown>>
      return body.other_adjustment_amount
    }
    assert.equal(await payloadFor("1000,10"), 1000.1)
    assert.equal(await payloadFor("1000.10"), 1000.1, "coma y punto: mismo monto (antes 1000.10 se enviaba como 100010)")
    assert.equal(await payloadFor("1000,1"), 1000.1)
    assert.equal(await payloadFor("1000"), 1000)
  } finally {
    await page.close()
  }
})

// ───────────────────────────── Detalle del pedido ────────────────────────────

// Nivel exterior (envoltorio de la vista) vs cards internas (primer nivel de
// contenido): colores efectivos y luminancias.
const HIERARCHY = `(() => { ${COLOR_HELPERS}
  const content = document.querySelector(".admin-order-detail-content")
  const outer = content.parentElement
  const cards = [...content.querySelectorAll("section, article, div")].filter((el) => {
    const s = getComputedStyle(el); const r = el.getBoundingClientRect()
    return r.width > 300 && r.height > 40 && parseFloat(s.borderTopWidth) > 0 && parse(s.backgroundColor)[3] + (firstStop(s.backgroundImage) ? 1 : 0) > 0
  })
  const card = cards[0]
  return { outer: key("rgb(" + effectiveBg(outer).slice(0, 3).join(",") + ")"), outerLum: lum(effectiveBg(outer)), cardLum: card ? lum(effectiveBg(card)) : null, cardClass: card ? card.className.toString().slice(0, 60) : null }
})()`

test("9-14 (Light): Resumen, Pago y Facturación usan la misma jerarquía que Envío, Atención e Historial", async () => {
  const results: Record<string, { outer: string; outerLum: number; cardLum: number | null; cardClass: string | null }> = {}
  for (const tab of ["resumen", "pago", "facturacion", "envio", "atencion", "historial"]) {
    const page = await open("light", { orderId: 1, tab })
    try {
      await page.waitForTimeout(250)
      results[tab] = (await page.evaluate(HIERARCHY)) as (typeof results)[string]
    } finally {
      await page.close()
    }
  }
  const reference = results.envio.outer
  for (const [tab, result] of Object.entries(results)) {
    assert.equal(result.outer, reference, `${tab}: mismo nivel exterior que Envío`)
    assert.ok(result.cardLum !== null, `${tab}: tiene cards internas`)
    assert.ok(result.cardLum! - result.outerLum > 0.08, `${tab}: card (${result.cardLum!.toFixed(3)}) más clara que el exterior (${result.outerLum.toFixed(3)})`)
  }
})

test("Dark: la jerarquía de fondos del detalle no cambia", async () => {
  // Valores Dark medidos y verificados sin cambios contra HEAD.
  const expected: Record<string, string> = { resumen: "1,15,25,1", pago: "1,15,25,1", facturacion: "1,15,25,1", envio: "21,21,21,1", atencion: "21,21,21,1", historial: "21,21,21,1" }
  for (const [tab, outer] of Object.entries(expected)) {
    const page = await open("dark", { orderId: 1, tab })
    try {
      await page.waitForTimeout(250)
      assert.equal(((await page.evaluate(HIERARCHY)) as { outer: string }).outer, outer, tab)
    } finally {
      await page.close()
    }
  }
})

test("15: Envío > Transportista muestra el texto en blanco sin cambiar su fondo", async () => {
  for (const theme of ["light", "dark"] as const) {
    const page = await open(theme, { orderId: 1, tab: "envio" })
    try {
      const style = (await page.evaluate(`(() => { ${COLOR_HELPERS}
        const t = document.querySelector(".admin-order-shipping-modality-select"); const label = t.querySelector("span span:last-child"); const s = getComputedStyle(t)
        return { text: label.textContent, color: key(getComputedStyle(label).color), chevron: key(getComputedStyle(t.querySelector("svg")).stroke), bg: key(s.backgroundColor), img: s.backgroundImage.slice(0, 60),
          contrast: ratio(parse(getComputedStyle(label).color), effectiveBg(t)) }
      })()`)) as Record<string, string | number>
      assert.equal(style.text, "Andreani")
      assert.equal(style.bg, "17,42,67,1", `${theme}: fondo navy intacto`)
      assert.match(String(style.img), /linear-gradient/)
      assert.ok(Number(style.contrast) >= 7, `${theme}: texto legible (${style.contrast})`)
      if (theme === "light") {
        assert.equal(style.color, "255,255,255,1", "texto blanco")
        assert.equal(style.chevron, "255,255,255,1", "chevron visible, como antes")
      }
    } finally {
      await page.close()
    }
  }
})

// ───────────────────────────── Listado de pedidos ────────────────────────────

const ROW_STYLES = `(() => { ${COLOR_HELPERS}
  return [...document.querySelectorAll(".admin-orders-list-row")].map((row) => [row, ...row.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
    const s = getComputedStyle(el); const svg = el instanceof SVGElement
    return [el.tagName, key(s.color), key(s.backgroundColor), s.backgroundImage.slice(0, 70), key(s.borderTopColor), svg ? key(s.stroke) : "-"].join(" | ")
  }))
})()`

const ROW_CHECKS = `(() => { ${COLOR_HELPERS}
  return [...document.querySelectorAll(".admin-orders-list-row")].map((row) => {
    const bg = effectiveBg(row)
    const texts = [...row.querySelectorAll("p")].filter((p) => p.getBoundingClientRect().width > 0 && p.textContent.trim())
      .map((p) => ({ text: p.textContent.trim(), contrast: ratio(over(parse(getComputedStyle(p).color), effectiveBg(p)), effectiveBg(p)) }))
    const eye = [...row.querySelectorAll('button[aria-label^="Ver pedido"]')].find((b) => b.getBoundingClientRect().width > 0)
    const eyeSvg = eye.querySelector("svg")
    const badges = [...row.querySelectorAll(".admin-order-semantic-badge, .admin-order-dispatch-badge")].filter((b) => b.getBoundingClientRect().width > 0)
      .map((b) => ({ text: b.textContent.trim(), border: key(getComputedStyle(b).borderTopColor), contrast: ratio(over(parse(getComputedStyle(b).color), effectiveBg(b)), effectiveBg(b)) }))
    return { rowLum: lum(bg), rowImg: getComputedStyle(row).backgroundImage.slice(0, 40), texts, badges,
      eyeContrast: ratio(parse(getComputedStyle(eyeSvg).stroke), effectiveBg(eye)) }
  })
})()`

for (const width of [1920, 1440, 1366, 1280, 768, 390]) {
  test(`16-21 (${width}px): la fila Light replica la de Dark; header y fondo siguen claros`, async () => {
    const pages = { dark: await open("dark", { width }), light: await open("light", { width }) }
    try {
      const dark = (await pages.dark.evaluate(ROW_STYLES)) as string[][]
      const light = (await pages.light.evaluate(ROW_STYLES)) as string[][]
      assert.equal(light.length, 4)
      // Mismos colores/fondos/bordes/trazos, nodo por nodo (el <button> sólo
      // difiere en `stroke`, que no pinta en elementos HTML: se excluye).
      assert.deepEqual(light, dark, "cada fila Light es idéntica a la de Dark")

      const checks = (await pages.light.evaluate(ROW_CHECKS)) as Array<{ rowLum: number; rowImg: string; texts: Array<{ text: string; contrast: number }>; badges: Array<{ text: string; border: string; contrast: number }>; eyeContrast: number }>
      for (const row of checks) {
        assert.ok(row.rowLum < 0.02, `fondo navy/oscuro (${row.rowLum.toFixed(4)})`)
        assert.match(row.rowImg, /linear-gradient/)
        for (const text of row.texts) assert.ok(text.contrast >= 3, `"${text.text}" legible (${text.contrast.toFixed(2)})`)
        for (const badge of row.badges) assert.ok(badge.contrast >= 4.5, `badge "${badge.text}" legible (${badge.contrast.toFixed(2)})`)
        assert.ok(row.eyeContrast >= 4.5, `ojo visible (${row.eyeContrast.toFixed(2)})`)
      }
      // Estados distinguibles por color semántico (borde del badge de estado).
      const estado = checks.map((row) => row.badges[0])
      assert.deepEqual(estado.map((b) => b.text), ["En proceso", "Completado", "Cancelado", "En proceso"])
      assert.equal(new Set([estado[0].border, estado[1].border, estado[2].border]).size, 3, "en proceso / completado / cancelado distinguibles")

      // Header y página siguen en Light.
      const shell = (await pages.light.evaluate(`(() => { ${COLOR_HELPERS} return { page: lum(effectiveBg(document.querySelector(".beyonix-admin-main"))),
        header: (() => { const h = document.querySelector(".admin-orders-table-header"); return h && h.getBoundingClientRect().width > 0 ? lum(effectiveBg(h)) : null })() } })()`)) as { page: number; header: number | null }
      assert.ok(shell.page > 0.7, "fondo general Light")
      if (shell.header !== null) assert.ok(shell.header > 0.5, "header de tabla Light")
    } finally {
      await pages.dark.close()
      await pages.light.close()
    }
  })
}

test("camioncito de la fila: blanco en Light (igual que Dark, que no cambia); el badge no cambia", async () => {
  const TRUCK = `(() => { ${COLOR_HELPERS}
    const badges = [...document.querySelectorAll(".admin-orders-list-row .admin-order-shipping-reminder")].filter((b) => b.getBoundingClientRect().width > 0)
    return badges.map((b) => { const svg = b.querySelector("svg"); const s = getComputedStyle(b)
      return { icon: key(getComputedStyle(svg).color), stroke: key(getComputedStyle(svg).stroke), badge: [key(s.backgroundColor), key(s.borderTopColor), s.width, s.height].join(" | ") } })
  })()`
  for (const width of [1920, 1280]) {
    const pages = { dark: await open("dark", { width }), light: await open("light", { width }) }
    try {
      const dark = (await pages.dark.evaluate(TRUCK)) as Array<{ icon: string; stroke: string; badge: string }>
      const light = (await pages.light.evaluate(TRUCK)) as Array<{ icon: string; stroke: string; badge: string }>
      assert.equal(light.length, 1, `${width}px: el pedido facturado muestra el camioncito`)
      assert.equal(light[0].icon, "255,255,255,1", "Light: ícono blanco")
      assert.equal(light[0].stroke, "255,255,255,1", "Light: trazo blanco")
      assert.equal(dark[0].icon, "255,255,255,1", "Dark: sigue blanco como antes")
      assert.equal(dark[0].stroke, "255,255,255,1")
      assert.equal(light[0].badge, dark[0].badge, "el badge (fondo, borde, tamaño) no cambia")
    } finally {
      await pages.dark.close()
      await pages.light.close()
    }
  }
})

test("CSS: sin guerra de especificidad -- exclusiones semánticas explícitas", () => {
  const source = readFileSync("app/globals.css", "utf8")
  assert.match(source, /:not\(\.admin-claim-flow-control\):not\(\.admin-control-select\) \{/, "catch-all de botones excluye AdminSelect")
  assert.match(source, /\[class\*="rounded"\]\[class\*="border"\]:not\(\.bx-surface, \.admin-orders-list-row\) \{/, "catch-all Light de superficies excluye la fila")
  assert.match(source, /html\[data-admin-theme="light"\] \.admin-order-detail-scope \.admin-order-summary-layout-bg \{\n  background: transparent !important;/)
  const controls = readFileSync("app/admin/components/admin-controls.tsx", "utf8")
  assert.match(controls, /className=\{wrapperClassName \? `relative block \$\{wrapperClassName\}` : "relative block w-full"\}/)
})
