import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Header REAL del checkout (bundle esbuild) con el CSS del proyecto, dentro
// de .checkout-page, como staff (campana + tema + cuenta, el caso más ancho)
// y como cliente. Verifica que Volver, BEYONIX y las acciones entren sin
// superponerse ni generar scroll horizontal desde 320 px hasta desktop.
// Stubs sólo de infraestructura: sesión, crédito, tema, notificaciones,
// navegación y Supabase.

const SHOTS = process.env.CHECKOUT_HEADER_SHOTS

const stubs: Plugin = {
  name: "checkout-header-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `
        export function useAuth() {
          const internal = window.__AUTH === "internal"
          return { user: { id: "u1", username: internal ? "ANTARES" : "lucas.espinosa", rol: internal ? "admin" : "cliente" }, isLoading: false, isInternal: internal, logout() {} }
        }`,
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: 0 } }`,
      "@/context/account-theme-context": `export function useAccountTheme() { return { theme: document.documentElement.getAttribute("data-account-theme"), toggleTheme() {} } }`,
      "@/hooks/use-order-notifications": `export function useOrderNotifications() { return { notificationCount: 3, notificationTone: "neutral", notificationGroups: { payment: 3, shipping: 0, claim: 0, cancellation: 0, mercadolibre_return: 0 }, notifications: [], loading: false, error: null, reloadNotificationCount() {} } }`,
      "@/hooks/use-back-navigation": `export function useBackNavigation() { return { back() {}, backTo() {} } }`,
      "@/lib/supabase/client": `
        const channel = { on() { return channel }, subscribe() { return channel } }
        export const supabase = { auth: { getSession: async () => ({ data: { session: null } }) }, channel: () => channel, removeChannel: async () => "ok" }
        export async function getSafeSupabaseSession() { return null }
        export function clearSupabaseBrowserSession() {}
        export function isInvalidRefreshTokenError() { return false }
        export function isMissingAuthSessionError() { return false }`,
      "next/navigation": `export function useRouter() { return { push() {}, replace() {}, prefetch() {}, back() {} } } export function usePathname() { return "/checkout" }`,
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
import { CheckoutHeader } from "@/components/checkout/checkout-header"
createRoot(document.getElementById("root")).render(h(CheckoutHeader))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "checkout-header-fixture.tsx" },
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

async function open(theme: "light" | "dark", width: number, auth: "internal" | "customer"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => route.abort())
  await page.setContent(`<!doctype html><html lang="es" data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><main class="checkout-page min-h-screen bg-[#05070A] font-heading text-white"><div id="root"></div></main><script>window.process={env:{NODE_ENV:"production"}};window.__AUTH=${JSON.stringify(auth)}</script><script>${bundle}</script></body></html>`)
  try { await page.waitForSelector("[data-checkout-header-row] button[aria-label^='Cambiar a modo']", { timeout: 10_000 }) }
  catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return page
}

type Box = { label: string; left: number; right: number; top: number; bottom: number; width: number; height: number; onTop: boolean }

async function headerLayout(page: Page) {
  return (await page.evaluate(`(() => {
    const row = document.querySelector("[data-checkout-header-row]")
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden" }
    const box = (element, label) => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { label, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, onTop: Boolean(hit && element.contains(hit)) }
    }
    const back = row.querySelector("button[aria-label='Volver a la tienda']")
    const brand = row.querySelector("a[aria-label='Ir al inicio de BEYONIX']")
    const actions = [...row.querySelectorAll(":scope > div button")]
      .filter((button) => visible(button) && !button.closest(".beyonix-account-menu-panel"))
      .map((button) => box(button, button.getAttribute("aria-label")))
    const backLabel = back.querySelector("span")
    const accountLabel = [...row.querySelectorAll(".beyonix-account-menu-trigger-label")].find(visible)
    return {
      back: box(back, "Volver"),
      backTextVisible: visible(backLabel),
      brand: { ...box(brand, "BEYONIX"), clipped: brand.scrollWidth > brand.clientWidth + 1, text: brand.textContent },
      actions,
      accountLabelVisible: Boolean(accountLabel),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }
  })()`)) as {
    back: Box
    backTextVisible: boolean
    brand: Box & { clipped: boolean; text: string }
    actions: Box[]
    accountLabelVisible: boolean
    overflow: number
  }
}

const overlaps = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5

for (const theme of ["dark", "light"] as const) {
  for (const auth of ["internal", "customer"] as const) {
    for (const width of [320, 360, 375, 390, 768, 1366]) {
      test(`checkout header ${theme} ${auth} a ${width}px: Volver, BEYONIX y acciones sin superposición ni overflow`, async () => {
        const page = await open(theme, width, auth)
        try {
          const layout = await headerLayout(page)
          if (SHOTS) await page.screenshot({ path: `${SHOTS}/checkout-header-${theme}-${auth}-${width}.png`, clip: { x: 0, y: 0, width, height: 90 } })

          assert.ok(layout.overflow <= 0, `scroll horizontal: ${layout.overflow}px`)
          assert.equal(layout.brand.text, "BEYONIX")
          assert.equal(layout.brand.clipped, false, "BEYONIX completo, sin recorte")
          assert.ok(layout.brand.onTop, "BEYONIX no queda tapado por otro elemento")
          assert.ok(layout.back.onTop, "Volver accesible")

          const expectedActions = auth === "internal" ? 3 : 2
          assert.equal(layout.actions.length, expectedActions, layout.actions.map((action) => action.label).join(", "))
          assert.match(layout.actions.at(-1)!.label, /^Abrir menú de (cuenta|usuario)$/)

          const all = [layout.back, layout.brand, ...layout.actions]
          for (const item of all) {
            assert.ok(item.left >= 0 && item.right <= width + 0.5, `${item.label} dentro de la pantalla (${item.left}–${item.right})`)
          }
          for (const action of layout.actions) {
            assert.ok(action.onTop, `${action.label} accesible`)
            // size-11 con la escala de spacing fluida del proyecto (≈39–44 px):
            // el header no achica los botones para hacer lugar.
            assert.ok(action.width >= 38 && action.height >= 38, `${action.label}: área táctil ${action.width}×${action.height}`)
          }
          for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
              assert.ok(!overlaps(all[i], all[j]), `${all[i].label} se superpone con ${all[j].label}`)
            }
          }
          // Orden visual: Volver | BEYONIX | acciones.
          assert.ok(layout.back.right <= layout.brand.left && layout.brand.right <= layout.actions[0].left, "orden Volver → BEYONIX → acciones")

          if (width < 640) {
            assert.equal(layout.accountLabelVisible, false, "mobile: sólo avatar, sin nombre")
          } else {
            assert.equal(layout.accountLabelVisible, true, "tablet/desktop: conserva el nombre del usuario")
            assert.equal(layout.backTextVisible, true, "tablet/desktop: conserva el texto Volver")
          }
          // Debajo de 375 px "Volver" queda como ícono (aria-label intacto).
          assert.equal(layout.backTextVisible, width >= 375)
        } finally {
          await page.close()
        }
      })
    }
  }
}

test("checkout header mobile: el avatar compacto abre el mismo menú de cuenta", async () => {
  const page = await open("dark", 360, "internal")
  try {
    await page.getByRole("button", { name: "Abrir menú de cuenta" }).click()
    const panel = page.locator(".beyonix-account-menu-panel")
    await panel.waitFor()
    const box = await panel.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= 360 + 0.5, "el panel entra en la pantalla")
    assert.equal(await page.getByRole("link", { name: "Mi cuenta" }).count(), 1)
  } finally {
    await page.close()
  }
})
