import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Acciones del header con los componentes REALES (bundle esbuild) y el CSS
// del proyecto, en Light y Dark, dentro de los tres contextos donde aparecen:
// header del sitio, header de checkout (.checkout-page) y páginas legales
// (#contenido). Esos dos últimos remapean text-white/border-[#…] en Light,
// que era la causa de las inconsistencias:
// - íconos del menú de cuenta negros sobre navy en checkout/#contenido;
// - toggle de tema "lavado" y de otro tamaño respecto de la campana.
// También cubre el par campana/tema del panel Admin y el orden campana→luna.
// Stubs sólo de infraestructura: auth, crédito, tema, Supabase y router.

const SHOTS = process.env.HEADER_ACTIONS_SHOTS

const stubs: Plugin = {
  name: "header-actions-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `export function useAuth() { return { user: { id: "u1", username: "Lucas", rol: "cliente" }, isLoading: false, isInternal: false, logout() {} } }`,
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: 0 } }`,
      "@/context/account-theme-context": `export function useAccountTheme() { return { theme: document.documentElement.getAttribute("data-account-theme"), toggleTheme() {} } }`,
      "@/context/admin-theme-context": `export function useAdminTheme() { return { theme: document.documentElement.getAttribute("data-admin-theme"), toggleTheme() {} } }`,
      "@/lib/supabase/client": `
        const channel = { on() { return channel }, subscribe() { return channel } }
        export const supabase = { auth: { getSession: async () => ({ data: { session: null } }) }, channel: () => channel, removeChannel: async () => "ok" }
        export async function getSafeSupabaseSession() { return null }
        export function clearSupabaseBrowserSession() {}
        export function isInvalidRefreshTokenError() { return false }
        export function isMissingAuthSessionError() { return false }`,
      "@/lib/supabase/queries/customer-notifications": `
        export async function getCustomerNotifications() { return [] }
        export function isCustomerNotificationWithinRetention() { return true }
        export async function markCustomerNotificationRead() {}
        export async function markAllCustomerNotificationsRead() {}
        export async function dismissExpiredReadCustomerNotifications() {}`,
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
import { createElement as h } from "react"
import { createRoot } from "react-dom/client"
import { AccountMenu } from "@/components/account-menu"
import { AccountThemeToggle } from "@/components/account/account-theme-toggle"
import { CustomerNotificationsBell } from "@/components/customer-notifications-bell"
import { AdminNotificationBell } from "@/components/admin-notification-bell"
import { AdminThemeToggle } from "@/components/admin-theme-toggle"

const groups = { payment: 0, shipping: 0, claim: 0, cancellation: 0, mercadolibre_return: 0 }
const adminRoot = document.getElementById("root-admin")
if (adminRoot) {
  createRoot(adminRoot).render(
    h("div", { "data-actions": "admin", className: "flex items-center gap-1.5 p-4" },
      h(AdminNotificationBell, { count: 0, tone: "neutral", groups, notifications: [] }),
      h(AdminThemeToggle, null),
    ),
  )
}
for (const scope of ["header", "checkout", "contenido"]) {
  const root = document.getElementById("root-" + scope)
  if (!root) continue
  createRoot(root).render(
    h("div", { "data-actions": scope, className: "flex items-center justify-end gap-2 p-4" },
      h(CustomerNotificationsBell, { userId: "u1", open: false, onOpenChange() {} }),
      h(AccountThemeToggle, null),
      h(AdminNotificationBell, { variant: "storefront", count: 0, tone: "neutral", groups, notifications: [] }),
      h(AccountMenu, { open: true, onOpenChange() {} }),
    ),
  )
}
`

// Storefront: data-account-scope como en todo el sitio salvo /admin.
const storefrontHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head>
<body class="bg-beyonix-page">
<header class="beyonix-site-header"><div id="root-header" style="height:560px"></div></header>
<main class="checkout-page bg-[#05070A] text-white"><header class="checkout-header"><div id="root-checkout" style="height:560px"></div></header></main>
<section id="contenido" class="bg-beyonix-page"><div id="root-contenido" style="height:560px"></div></section>
<script>window.process = { env: { NODE_ENV: "production" } }</script>
<script>${bundle}</script></body></html>`

// Admin: sin data-account-scope (el script de layout.tsx lo apaga en /admin).
const adminHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-admin-theme="${theme}" data-account-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="beyonix-admin-shell min-h-screen"><aside class="beyonix-admin-sidebar admin-ds-sidebar"><div id="root-admin"></div></aside></div>
<script>window.process = { env: { NODE_ENV: "production" } }</script>
<script>${bundle}</script></body></html>`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "header-actions-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(html: string, readySelector: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 900, height: 1800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) =>
    route.request().url() === "http://header.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: html })
      : route.abort(),
  )
  await page.goto("http://header.test/")
  try {
    await page.waitForSelector(readySelector, { timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

type ButtonLook = { size: string; radius: string; bg: string; border: string; icon: string; iconSize: string }

// Se evalúa como string: evita helpers inyectados por el transpilador.
const READ_BUTTON = `const read = (el) => {
  const s = getComputedStyle(el)
  const svg = el.querySelector("svg")
  const r = el.getBoundingClientRect()
  const ir = svg.getBoundingClientRect()
  return { size: Math.round(r.width) + "x" + Math.round(r.height), radius: s.borderRadius, bg: s.backgroundColor,
    border: s.borderColor + " " + s.borderWidth, icon: getComputedStyle(svg).color, iconSize: Math.round(ir.width) + "x" + Math.round(ir.height) }
}`

const PROBE_STOREFRONT = `(() => {
  ${READ_BUTTON}
  const out = {}
  for (const scope of ["header", "checkout", "contenido"]) {
    const root = document.querySelector("[data-actions=" + scope + "]")
    out[scope] = {
      bell: read(root.querySelector("button[aria-label='Abrir notificaciones']")),
      toggle: read(root.querySelector("button[aria-label^='Cambiar a modo']")),
      staffBell: read(root.querySelector("button[aria-label='Abrir notificaciones administrativas']")),
      menuIcons: [...root.querySelectorAll(".beyonix-account-menu-icon")].map((icon) => ({
        bg: getComputedStyle(icon).backgroundColor, icon: getComputedStyle(icon.querySelector("svg")).stroke,
      })),
    }
  }
  return out
})()`

const PROBE_ADMIN = `(() => {
  ${READ_BUTTON}
  const root = document.querySelector("[data-actions=admin]")
  return {
    order: [...root.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
    bell: read(root.querySelector("button[aria-label='Abrir notificaciones administrativas']")),
    toggle: read(root.querySelector("button[aria-label^='Cambiar a modo']")),
  }
})()`

type StorefrontProbe = Record<"header" | "checkout" | "contenido", {
  bell: ButtonLook; toggle: ButtonLook; staffBell: ButtonLook; menuIcons: Array<{ bg: string; icon: string }>
}>

for (const theme of ["light", "dark"] as const) {
  test(`storefront ${theme}: toggle de tema idéntico a la campana (cliente y staff) en header, checkout y legales`, async () => {
    const page = await open(storefrontHtml(theme, css, bundle), "[data-actions=contenido] .beyonix-account-menu-panel")
    try {
      const data = (await page.evaluate(PROBE_STOREFRONT)) as StorefrontProbe
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/header-${theme}.png`, fullPage: true })
      const reference = data.header.bell
      assert.equal(reference.iconSize, "17x17")
      assert.equal(reference.border.endsWith(" 1px"), true)
      assert.deepEqual(reference, theme === "light"
        ? { ...reference, bg: "rgb(255, 255, 255)", icon: "rgb(0, 0, 0)" }
        : { ...reference, bg: "rgb(13, 17, 23)", icon: "rgba(255, 255, 255, 0.8)" })
      for (const scope of ["header", "checkout", "contenido"] as const) {
        assert.deepEqual(data[scope].bell, reference, `${scope}: campana`)
        assert.deepEqual(data[scope].toggle, reference, `${scope}: toggle de tema`)
        assert.deepEqual(data[scope].staffBell, reference, `${scope}: campana de staff`)
      }
    } finally {
      await page.close()
    }
  })

  test(`storefront ${theme}: íconos del menú de cuenta blancos sobre navy en todas las pantallas`, async () => {
    const page = await open(storefrontHtml(theme, css, bundle), "[data-actions=contenido] .beyonix-account-menu-panel")
    try {
      const data = (await page.evaluate(PROBE_STOREFRONT)) as StorefrontProbe
      for (const scope of ["header", "checkout", "contenido"] as const) {
        assert.equal(data[scope].menuIcons.length, 7, scope)
        for (const icon of data[scope].menuIcons) {
          assert.equal(icon.icon, "rgb(255, 255, 255)", `${scope}: trazo blanco`)
          if (theme === "light") assert.equal(icon.bg, "rgb(17, 42, 67)", `${scope}: contenedor navy`)
        }
      }
      // "Cerrar sesión" sigue pasando a rojo al hacer hover (también en checkout).
      const logout = page.locator("[data-actions=checkout] button[aria-label='Cerrar sesión']")
      await logout.hover()
      // El ícono tiene transition-all: se espera el color final.
      await page.waitForFunction(
        `getComputedStyle(document.querySelector("[data-actions=checkout] button[aria-label='Cerrar sesión'] .beyonix-account-menu-icon svg")).stroke === "rgb(239, 68, 68)"`,
        undefined,
        { timeout: 3_000 },
      )
    } finally {
      await page.close()
    }
  })

  test(`admin ${theme}: campana primero y toggle de tema con el mismo botón que la campana`, async () => {
    const page = await open(adminHtml(theme, css, bundle), "[data-actions=admin] button[aria-label^='Cambiar a modo']")
    try {
      const data = (await page.evaluate(PROBE_ADMIN)) as { order: string[]; bell: ButtonLook; toggle: ButtonLook }
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-${theme}.png`, clip: { x: 0, y: 0, width: 300, height: 90 } })
      assert.equal(data.order[0], "Abrir notificaciones administrativas")
      assert.match(data.order[1], /^Cambiar a modo/)
      assert.deepEqual(data.toggle, data.bell)
    } finally {
      await page.close()
    }
  })
}

test("orden campana → luna en todos los headers que muestran ambos", () => {
  const sources: Record<string, string> = {
    "components/site-header.tsx": "<AccountThemeToggle />",
    "components/public-minimal-header.tsx": "<AccountThemeToggle />",
    "app/checkout/page.tsx": "<AccountThemeToggle />",
  }
  for (const [file, toggle] of Object.entries(sources)) {
    const source = readFileSync(file, "utf8")
    const toggleIndex = source.indexOf(toggle)
    const bellIndex = source.search(/<(Admin|Customer)NotificationsBell\b/)
    assert.ok(toggleIndex > 0, `${file}: toggle presente`)
    assert.ok(bellIndex > 0 && bellIndex < toggleIndex, `${file}: campana antes de la luna`)
    assert.doesNotMatch(source, /<AccountThemeToggle className="size-(9|10)" \/>/, `${file}: toggle sin tamaño propio`)
  }
  const admin = readFileSync("app/admin/admin-client.tsx", "utf8")
  const pairs = [...admin.matchAll(/<AdminNotificationsBell[\s\S]*?\/>\s*<AdminThemeToggle \/>/g)]
  assert.equal(pairs.length, 2, "sidebar y header mobile del Admin: campana y luego luna")
  assert.doesNotMatch(admin, /<AdminThemeToggle \/>\s*<AdminNotificationsBell/)
})
