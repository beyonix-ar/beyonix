import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Navbar mobile con el SiteHeader REAL (bundle esbuild) y el CSS del
// proyecto, en Light y Dark, como invitado y logueado. Stubs sólo de
// infraestructura: sesión, carrito, crédito, tema, categorías, Supabase y
// router. Las categorías existen (3) para comprobar que el menú de tres
// puntos ya no las lista.

const SHOTS = process.env.SITE_HEADER_MOBILE_SHOTS
const CATEGORIES = ["ACCESORIOS Y UTILIDADES", "HOGAR & BAZAR", "TECNOLOGÍA & GADGETS"]

const stubs: Plugin = {
  name: "site-header-mobile-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `
        export function useAuth() {
          const logged = window.__AUTH === "user"
          return { user: logged ? { id: "u1", username: "lucas.espinosa", rol: "cliente" } : null, isLoading: false, isInternal: false, logout() {} }
        }`,
      "@/context/cart-context": `export function useCart() { return { cart: [{ quantity: 2 }], total: 125000, openCart() {} } }`,
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: 15000 } }`,
      "@/context/account-theme-context": `export function useAccountTheme() { return { theme: document.documentElement.getAttribute("data-account-theme"), toggleTheme() {} } }`,
      "@/hooks/use-order-notifications": `export function useOrderNotifications() { return { notificationCount: 0, notificationTone: "neutral", notificationGroups: { payment: 0, shipping: 0, claim: 0, cancellation: 0, mercadolibre_return: 0 }, notifications: [], loading: false, error: null, reloadNotificationCount() {} } }`,
      "@/lib/supabase/queries/store": `export async function getStoreCategorias() { return ${JSON.stringify(CATEGORIES.map((nombre, index) => ({ id: index + 1, nombre, slug: "cat-" + (index + 1) })))} }`,
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
      "next/navigation": `export function useRouter() { return { push() {}, replace() {}, prefetch() {} } } export function usePathname() { return "/" }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, prefetch, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref }) })`,
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
import { SiteHeader } from "@/components/site-header"
createRoot(document.getElementById("root")).render(h(SiteHeader))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "site-header-mobile-fixture.tsx" },
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

test.after(async () => { await browser?.close() })

async function open(theme: "light" | "dark", width: number, auth: "guest" | "user"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 760 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => route.abort())
  await page.setContent(`<!doctype html><html lang="es" data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page" style="min-height:1400px"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}};window.__AUTH=${JSON.stringify(auth)}</script><script>${bundle}</script></body></html>`)
  try { await page.waitForSelector(".beyonix-site-header-actions", { timeout: 10_000 }) }
  catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return page
}

type Action = { label: string; left: number; right: number; width: number; height: number }

/** Botones visibles de la barra, en orden, y la caja del logo. */
async function barLayout(page: Page) {
  return (await page.evaluate(`(() => {
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden" }
    const actions = [...document.querySelectorAll(".beyonix-site-header-actions button")]
      .filter((button) => visible(button) && !button.closest(".beyonix-account-menu-panel, .beyonix-notifications-panel"))
      .map((button) => { const rect = button.getBoundingClientRect(); return { label: button.getAttribute("aria-label") || button.textContent.trim(), left: rect.left, right: rect.right, width: rect.width, height: rect.height } })
    const logo = document.querySelector(".beyonix-site-header-logo")
    const logoRect = logo.getBoundingClientRect()
    return {
      actions,
      logo: { left: logoRect.left, right: logoRect.right, fontSize: parseFloat(getComputedStyle(logo).fontSize), clipped: logo.scrollWidth > logo.clientWidth + 1 },
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }
  })()`)) as { actions: Action[]; logo: { left: number; right: number; fontSize: number; clipped: boolean }; overflow: number }
}

async function assertBar(page: Page, width: number, expected: string[]) {
  const bar = await barLayout(page)
  assert.ok(bar.overflow <= 0, `scroll horizontal: ${bar.overflow}px`)
  assert.deepEqual(bar.actions.map((action) => action.label), expected)
  assert.equal(bar.logo.clipped, false, "BEYONIX completo")
  assert.ok(bar.logo.fontSize >= 20, `logo legible (${bar.logo.fontSize}px)`)
  assert.ok(bar.logo.left >= 0, "logo dentro de la pantalla")
  assert.ok(bar.logo.right + 4 <= bar.actions[0].left, `logo sin pisar acciones (${bar.logo.right} vs ${bar.actions[0].left})`)
  for (const action of bar.actions) {
    assert.ok(action.right <= width, `${action.label} dentro de la pantalla`)
    assert.ok(action.width >= 40 && action.height >= 40, `${action.label}: zona táctil ${action.width}x${action.height}`)
  }
  for (let index = 1; index < bar.actions.length; index++) {
    assert.ok(bar.actions[index].left >= bar.actions[index - 1].right, "sin superposición")
  }
}

async function menuEntries(page: Page) {
  await page.locator('button[aria-label="Abrir menú"]').click()
  const menu = page.locator("[data-mobile-menu]")
  await menu.waitFor()
  const entries = await menu.locator("a, button").evaluateAll((elements) => elements.map((element) => element.textContent!.trim()))
  return { menu, entries }
}

async function assertInsideViewport(page: Page, selector: string, width: number) {
  const box = await page.locator(selector).boundingBox()
  assert.ok(box && box.x >= 0 && box.x + box.width <= width + 0.5, `${selector} dentro de la pantalla: ${JSON.stringify(box)}`)
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 360, 390, 412, 430, 768]) {
    test(`navbar ${theme} ${width}px invitado: tema, carrito y menú; menú sólo con navegación + ingreso`, async () => {
      const page = await open(theme, width, "guest")
      try {
        await assertBar(page, width, ["Cambiar a modo claro", "Abrir carrito", "Abrir menú"].map((label) =>
          label === "Cambiar a modo claro" ? (theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro") : label))
        const { menu, entries } = await menuEntries(page)
        assert.deepEqual(entries, ["Inicio", "Productos", "Categorías", "Contacto", "Iniciar sesión", "Registrarse"])
        const text = await menu.innerText()
        for (const category of CATEGORIES) assert.doesNotMatch(text, new RegExp(category.replace(/[&]/g, "\\&")), "sin categorías duplicadas")
        assert.doesNotMatch(text, /Apariencia/)
        await assertInsideViewport(page, "[data-mobile-menu]", width)
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/navbar-guest-${theme}-${width}.png` })
      } finally { await page.close() }
    })

    test(`navbar ${theme} ${width}px logueado: cuenta separada del menú general`, async () => {
      const page = await open(theme, width, "user")
      try {
        const themeLabel = theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"
        await assertBar(page, width, [themeLabel, "Abrir carrito", "Abrir menú de cuenta", "Abrir menú"])

        const { menu, entries } = await menuEntries(page)
        assert.deepEqual(entries, ["Inicio", "Productos", "Categorías", "Contacto"], "sólo navegación general")
        assert.doesNotMatch(await menu.innerText(), /Mi cuenta|Mi saldo|Mis compras|Cerrar sesión|Notificaciones|Apariencia/)

        // Cuenta: abre su propio menú (y cierra el general).
        await page.locator('button[aria-label="Abrir menú de cuenta"]').click()
        assert.equal(await page.locator("[data-mobile-menu]").count(), 0)
        const panel = page.locator(".beyonix-account-menu-panel").filter({ visible: true })
        await panel.waitFor()
        const accountText = await panel.innerText()
        for (const item of ["Mi cuenta", "Mi saldo", "Mis compras", "Notificaciones", "Cerrar sesión"]) assert.match(accountText, new RegExp(item))
        const box = await panel.boundingBox()
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 0.5, `panel de cuenta dentro de la pantalla: ${JSON.stringify(box)}`)
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/navbar-account-${theme}-${width}.png` })

        // Notificaciones: desde el menú de cuenta, panel fijo bajo la barra.
        await panel.getByRole("button", { name: "Abrir notificaciones" }).click()
        const notifications = page.locator(".beyonix-notifications-panel")
        await notifications.waitFor()
        const notificationsBox = await notifications.boundingBox()
        assert.ok(notificationsBox && notificationsBox.x >= 0 && notificationsBox.x + notificationsBox.width <= width + 0.5, `notificaciones dentro de la pantalla: ${JSON.stringify(notificationsBox)}`)
        assert.ok(notificationsBox.y >= 60, "debajo de la barra")
      } finally { await page.close() }
    })
  }

  test(`navbar ${theme} desktop 1280px: igual que antes (links, tema, cuenta con nombre, sin menú mobile)`, async () => {
    const page = await open(theme, 1280, "user")
    try {
      const bar = await barLayout(page)
      assert.ok(bar.overflow <= 0)
      const labels = bar.actions.map((action) => action.label)
      assert.deepEqual(labels, ["Abrir notificaciones", theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro", "Abrir menú de usuario", "Abrir carrito"])
      assert.match(await page.locator('button[aria-label="Abrir menú de usuario"]').innerText(), /LUCAS\.ESPINOSA/)
      for (const link of ["Inicio", "Productos", "Contacto"]) assert.equal(await page.locator(`nav a:text-is("${link}")`).first().isVisible(), true)
      assert.equal(await page.locator('button[aria-label="Abrir menú"]').isVisible(), false)
      assert.equal(await page.locator('button[aria-label="Abrir menú de cuenta"]').isVisible(), false)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/navbar-desktop-${theme}.png` })
    } finally { await page.close() }
  })
}
