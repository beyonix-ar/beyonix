import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Badge de las campanas (cliente, staff en el sitio y Admin) con los
// componentes REALES (bundle esbuild) y el CSS del proyecto, en Light/Dark y
// mobile/desktop. El badge siempre es la cantidad de no leídas de la MISMA
// lista que muestra el desplegable:
// - 0 → sin badge; 1 → 1; varias → exacto; 10+ → 9+;
// - abrir el desplegable (hover) no marca nada como leído;
// - marcar una baja el contador; marcar todas lo hace desaparecer;
// - una notificación nueva (realtime / recarga) lo sube sin recargar la página;
// - Admin: "Pedido nuevo" (información) también cuenta.
// Stubs sólo de infraestructura: auth, crédito, Supabase, router y las
// consultas de notificaciones (un store en memoria del navegador).

const SHOTS = process.env.NOTIFICATION_BELLS_SHOTS

const stubs: Plugin = {
  name: "notification-bells-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `export function useAuth() { return { user: { id: "u1", username: "Lucas", rol: "cliente" }, isLoading: false, isInternal: false, logout() {} } }`,
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: 0 } }`,
      "@/lib/supabase/client": `
        export const supabase = {
          auth: { getSession: async () => ({ data: { session: null } }) },
          channel() {
            const channel = { on(_event, _filter, handler) { window.__customer.handlers.push(handler); return channel }, subscribe() { return channel } }
            return channel
          },
          removeChannel: async () => "ok",
        }
        export async function getSafeSupabaseSession() { return null }
        export function clearSupabaseBrowserSession() {}
        export function isInvalidRefreshTokenError() { return false }
        export function isMissingAuthSessionError() { return false }`,
      "@/lib/supabase/queries/customer-notifications": `
        export async function getCustomerNotifications() { return window.__customer.list.map((item) => ({ ...item })) }
        export function isCustomerNotificationWithinRetention() { return true }
        export async function markCustomerNotificationRead(id) { const item = window.__customer.list.find((n) => n.id === id); if (item) item.is_read = true }
        export async function markAllCustomerNotificationsRead() { for (const item of window.__customer.list) item.is_read = true }
        export async function dismissExpiredReadCustomerNotifications() {}`,
      "@/lib/admin/admin-notifications": `
        export function isAdminActionNotification(n) { return n.kind ? n.kind === "action" : !["order", "message"].includes(n.type) }
        export async function markAdminNotificationRead(n) { window.__adminReads.push(n.id) }`,
      "next/navigation": `export function useRouter() { return { push() {}, replace() {} } } export function usePathname() { return "/" }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref }) })`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const ENTRY = `
import { createElement as h, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { AccountMenu } from "@/components/account-menu"
import { CustomerNotificationsBell } from "@/components/customer-notifications-bell"
import { AdminNotificationBell } from "@/components/admin-notification-bell"

const groups = { order: 0, message: 0, payment: 0, invoice: 0, shipping: 0, cancellation: 0, claim: 0, mercadolibre_return: 0, inventory: 0 }

function CustomerHarness() {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  return h("div", { className: "flex items-center justify-end gap-2 p-4" },
    h("div", { "data-bell": "customer" }, h(CustomerNotificationsBell, { userId: "u1", open, onOpenChange: setOpen, onUnreadCountChange: setUnread })),
    h("div", { "data-bell": "avatar" }, h(AccountMenu, { compact: true, open: false, onOpenChange() {}, unreadNotificationsCount: unread })),
  )
}

function AdminHarness({ variant }) {
  const [list, setList] = useState([])
  useEffect(() => { window.__setAdmin[variant] = setList }, [])
  return h("div", { "data-bell": variant, className: "flex items-center justify-end p-4" },
    h(AdminNotificationBell, { variant, tone: "order", groups, notifications: list }),
  )
}

const customerRoot = document.getElementById("root-customer")
if (customerRoot) createRoot(customerRoot).render(h(CustomerHarness))
const staffRoot = document.getElementById("root-storefront")
if (staffRoot) createRoot(staffRoot).render(h(AdminHarness, { variant: "storefront" }))
const adminRoot = document.getElementById("root-admin")
if (adminRoot) createRoot(adminRoot).render(h(AdminHarness, { variant: "admin" }))
`

const STORE = `<script>window.process = { env: { NODE_ENV: "production" } }
window.__customer = { list: [], handlers: [] }; window.__adminReads = []; window.__setAdmin = {}</script>`

const storefrontHtml = (theme: Theme, css: string, bundle: string) => `<!doctype html>
<html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body class="bg-beyonix-page"><header class="beyonix-site-header"><div id="root-customer"></div><div id="root-storefront"></div></header>
${STORE}<script>${bundle}</script></body></html>`

const adminHtml = (theme: Theme, css: string, bundle: string) => `<!doctype html>
<html data-admin-theme="${theme}" data-account-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body><div class="beyonix-admin-shell min-h-screen"><aside class="beyonix-admin-sidebar admin-ds-sidebar"><div id="root-admin"></div></aside></div>
${STORE}<script>${bundle}</script></body></html>`

type Theme = "dark" | "light"
type Variant = "customer" | "avatar" | "storefront" | "admin"

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "notification-bells-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(html: string, viewport: { width: number; height: number }, readySelector: string): Promise<Page> {
  const page = await browser.newPage({ viewport })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) =>
    route.request().url() === "http://bells.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: html })
      : route.abort(),
  )
  await page.goto("http://bells.test/")
  try {
    await page.waitForSelector(readySelector, { timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

const customerItem = (id: number, isRead: boolean) => ({
  id, user_id: "u1", type: "order_shipped", title: `Aviso ${id}`, body: "Tu pedido está en camino.", action_url: "/cuenta",
  order_id: 10 + id, is_read: isRead, created_at: new Date(Date.now() - id * 60_000).toISOString(), source_key: `test:${id}`, target_items: null,
})

const adminItem = (id: number, kind: "info" | "action") => ({
  id: `${kind}:${id}`, type: kind === "info" ? "order" : "payment", eventKey: `${kind}:${id}`,
  eventAt: new Date(Date.now() - id * 60_000).toISOString(),
  title: kind === "info" ? "Pedido nuevo" : "Revisar pago", body: `Ingresó el pedido #BX-${1000 + id}.`,
  actionUrl: "/admin/pedidos", orderId: id, isRead: false, kind,
})

// Lee el badge de una campana: texto, geometría respecto del botón y del
// ícono, y contraste del número sobre el propio badge.
const PROBE = (variant: Variant) => `(() => {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const parse = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
  const lum = (c) => { const ch = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]) }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const root = document.querySelector("[data-bell=${variant}]")
  const button = root.querySelector("button[aria-expanded]")
  const badge = button.querySelector("[data-notification-badge]")
  const unreadItems = root.querySelectorAll("[data-unread]").length
  const summary = root.querySelector("[data-notification-summary]")?.textContent ?? null
  if (!badge) return { text: null, label: button.getAttribute("aria-label"), unreadItems, summary }
  const b = badge.getBoundingClientRect(), r = button.getBoundingClientRect(), i = button.querySelector("svg").getBoundingClientRect()
  const s = getComputedStyle(badge)
  return {
    text: badge.textContent, label: button.getAttribute("aria-label"), unreadItems, summary,
    width: b.width, height: b.height, round: parseFloat(s.borderTopLeftRadius) >= b.height / 2 - 0.5,
    topRight: b.left + b.width / 2 > r.left + r.width / 2 && b.top + b.height / 2 < r.top + r.height / 2,
    // Tolerancia de 1px: bordes que sólo se tocan no tapan el ícono.
    coversIcon: Math.min(b.right, i.right) - Math.max(b.left, i.left) > 1 && Math.min(b.bottom, i.bottom) - Math.max(b.top, i.top) > 1,
    contrast: ratio(parse(s.color), parse(s.backgroundColor)),
  }
})()`

type Probe = {
  text: string | null; label: string; unreadItems: number; summary: string | null
  width?: number; height?: number; round?: boolean; topRight?: boolean; coversIcon?: boolean; contrast?: number
}

async function probe(page: Page, variant: Variant) {
  return (await page.evaluate(PROBE(variant))) as Probe
}

async function waitForBadge(page: Page, variant: Variant, text: string | null) {
  await page.waitForFunction(
    `(() => { const el = document.querySelector("[data-bell=${variant}] button[aria-expanded] [data-notification-badge]"); return ${text === null ? "!el" : `el?.textContent === ${JSON.stringify(text)}`} })()`,
    undefined,
    { timeout: 5_000 },
  ).catch(async () => {
    throw new Error(`${variant}: se esperaba badge ${text}, hay ${JSON.stringify(await probe(page, variant))}`)
  })
}

function assertBadgeLook(data: Probe, context: string) {
  assert.ok(data.width! <= 24 && data.height! <= 20, `${context}: badge compacto (${data.width}x${data.height})`)
  assert.ok(data.round, `${context}: badge circular`)
  assert.ok(data.topRight, `${context}: esquina superior derecha`)
  assert.equal(data.coversIcon, false, `${context}: no tapa la campana`)
  assert.ok(data.contrast! >= 4.5, `${context}: contraste ${data.contrast!.toFixed(2)}`)
}

for (const theme of ["light", "dark"] as const) {
  for (const viewport of VIEWPORTS) {
    const context = `${theme} ${viewport.name}`

    test(`cliente ${context}: badge = no leídas de la lista, hover no marca, leer baja, nueva sube`, async () => {
      const page = await open(storefrontHtml(theme, css, bundle), viewport, "[data-bell=customer] button[aria-expanded]")
      try {
        await page.waitForFunction("window.__customer.handlers.length > 0")
        const emit = (list: unknown[]) =>
          page.evaluate(`window.__customer.list = ${JSON.stringify(list)}; for (const handler of window.__customer.handlers) handler({})`)

        // 0 no leídas (aunque haya leídas en la lista) → sin badge.
        await emit([customerItem(1, true)])
        await waitForBadge(page, "customer", null)
        assert.equal((await probe(page, "customer")).label, "Abrir notificaciones")

        // Llega una nueva por realtime → 1, también en el avatar de mobile.
        await emit([customerItem(2, false), customerItem(1, true)])
        await waitForBadge(page, "customer", "1")
        await waitForBadge(page, "avatar", "1")
        assertBadgeLook(await probe(page, "customer"), `${context} campana`)

        // Varias → número exacto.
        await emit([customerItem(4, false), customerItem(3, false), customerItem(2, false), customerItem(1, true)])
        await waitForBadge(page, "customer", "3")
        await waitForBadge(page, "avatar", "3")
        assert.equal((await probe(page, "customer")).label, "Abrir notificaciones (3 sin leer)")

        // Abrir el desplegable (hover, como en el header) no marca nada.
        await page.locator("[data-bell=customer] button[aria-expanded]").hover()
        await page.waitForSelector("[data-bell=customer] [data-unread]")
        await page.waitForTimeout(300)
        let data = await probe(page, "customer")
        assert.equal(data.text, "3")
        assert.equal(data.unreadItems, 3, "desplegable y badge coinciden")
        assert.equal(data.summary, "3 sin leer", "badge = sin leer = encabezado")
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/customer-${theme}-${viewport.name}.png` })

        // Marcar una → baja al instante.
        await page.locator("[data-bell=customer] [data-unread]").first().click()
        await waitForBadge(page, "customer", "2")
        await waitForBadge(page, "avatar", "2")

        // 10+ → 9+ y el desplegable lista las 12.
        await emit(Array.from({ length: 12 }, (_, index) => customerItem(index + 1, false)))
        await waitForBadge(page, "customer", "9+")
        await page.locator("[data-bell=customer] button[aria-expanded]").hover()
        await page.waitForSelector("[data-bell=customer] [data-unread]")
        data = await probe(page, "customer")
        assert.equal(data.unreadItems, 12)
        assert.equal(data.summary, "12 sin leer", "el encabezado muestra el número real aunque el badge diga 9+")
        assertBadgeLook(data, `${context} 9+`)

        // Marcar todas → desaparece.
        await page.locator("button[aria-label='Marcar todas las notificaciones como leídas']").click()
        await waitForBadge(page, "customer", null)
        await waitForBadge(page, "avatar", null)
        assert.equal((await probe(page, "customer")).unreadItems, 0)
      } finally {
        await page.close()
      }
    })

    for (const variant of ["storefront", "admin"] as const) {
      test(`${variant === "admin" ? "admin" : "staff en el sitio"} ${context}: "Pedido nuevo" cuenta, lectura optimista y 9+`, async () => {
        const html = variant === "admin" ? adminHtml(theme, css, bundle) : storefrontHtml(theme, css, bundle)
        const page = await open(html, viewport, `[data-bell=${variant}] button[aria-expanded]`)
        try {
          await page.waitForFunction(`Boolean(window.__setAdmin.${variant})`)
          const set = (list: unknown[]) => page.evaluate(`window.__setAdmin.${variant}(${JSON.stringify(list)})`)

          await set([])
          await waitForBadge(page, variant, null)

          // El caso reportado: sólo información ("Pedido nuevo") → badge 1.
          await set([adminItem(1011, "info")])
          await waitForBadge(page, variant, "1")
          assertBadgeLook(await probe(page, variant), `${variant} ${context}`)

          // Nueva notificación (recarga del hook) → sube; acciones + información.
          await set([adminItem(1, "action"), adminItem(1012, "info"), adminItem(1011, "info")])
          await waitForBadge(page, variant, "3")
          await page.locator(`[data-bell=${variant}] button[aria-expanded]`).hover()
          await page.waitForSelector(`[data-bell=${variant}] [data-unread]`)
          const opened = await probe(page, variant)
          assert.equal(opened.unreadItems, 3, "desplegable y badge coinciden")
          assert.equal(opened.summary, "3 sin leer", "badge = sin leer = encabezado (1 acción + 2 información)")
          if (SHOTS) await page.screenshot({ path: `${SHOTS}/${variant}-${theme}-${viewport.name}.png` })

          // Leer un "Pedido nuevo" → baja sin esperar la recarga.
          await page.locator(`[data-bell=${variant}] [data-notification-section=info] [data-unread]`).first().click()
          await waitForBadge(page, variant, "2")
          assert.equal(await page.evaluate("window.__adminReads.length"), 1)
          await page.mouse.move(0, 0)
          await page.waitForTimeout(700)
          await page.locator(`[data-bell=${variant}] button[aria-expanded]`).hover()
          await page.waitForSelector(`[data-bell=${variant}] [data-notification-summary]`)
          const afterRead = await probe(page, variant)
          assert.equal(afterRead.summary, "2 sin leer", "tras leer: badge = encabezado")
          assert.equal(afterRead.unreadItems, 2)

          // La recarga ya sin la leída mantiene el mismo número.
          await set([adminItem(1, "action"), adminItem(1011, "info")])
          await waitForBadge(page, variant, "2")

          // 10+ → 9+.
          await set(Array.from({ length: 11 }, (_, index) => adminItem(index + 1, "info")))
          await waitForBadge(page, variant, "9+")
          assertBadgeLook(await probe(page, variant), `${variant} ${context} 9+`)

          // Todo leído/resuelto → sin badge.
          await set([])
          await waitForBadge(page, variant, null)
        } finally {
          await page.close()
        }
      })
    }
  }
}
