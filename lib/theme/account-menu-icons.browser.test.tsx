import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Menú de cuenta con el SiteHeader REAL (bundle esbuild) dentro de la misma
// estructura del layout (body > div.relative.z-10) y el CSS del proyecto:
// dropdown desktop y menú mobile, en Light y Dark. El ícono debe quedar
// blanco sobre el navy en cualquier contexto: el blanco viaja como atributos
// stroke/fill del SVG, así que ni los remapeos de Light por página ni un CSS
// publicado desactualizado lo pueden oscurecer (causa real en producción:
// componente nuevo sin text-white + CSS sin la regla que lo reemplazaba).

const SHOTS = process.env.ACCOUNT_MENU_SHOTS

const stubs: Plugin = {
  name: "account-menu-icons-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `export function useAuth() { return { user: window.__GUEST__ ? null : { id: "u1", username: "Lucas", rol: "cliente" }, isLoading: false, isInternal: false, logout() {} } }`,
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: 1500 } }`,
      "@/context/cart-context": `export function useCart() { return { cart: [], total: 0, openCart() {} } }`,
      "@/context/account-theme-context": `export function useAccountTheme() { return { theme: document.documentElement.getAttribute("data-account-theme"), toggleTheme() {} } }`,
      "@/hooks/use-order-notifications": `export function useOrderNotifications() { return { notificationCount: 0, notificationTone: "neutral", notificationGroups: {}, notifications: [], loading: false, error: "", reloadNotificationCount() {} } }`,
      "@/lib/supabase/queries/store": `export async function getStoreCategorias() { return [] }`,
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
      "next/navigation": `export function useRouter() { return { push() {}, replace() {} } } export function usePathname() { return window.__PATHNAME__ || "/" }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, prefetch, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref }) })`,
      "next/image": `import { createElement } from "react"; export default function Image({ src, alt, fill, priority, ...props }) { return createElement("img", { ...props, src: typeof src === "string" ? src : src?.src, alt }) }`,
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
createRoot(document.getElementById("header-root")).render(h(SiteHeader))
`

const pageHtml = (theme: "dark" | "light", css: string, bundle: string, guest = false) => `<!doctype html>
<html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head>
<body class="antialiased"><div class="relative z-10"><div id="header-root" style="display:contents"></div>
<main class="min-h-screen bg-beyonix-page pt-24"><section class="container mx-auto p-8"><h1>Contenido</h1></section></main></div>
<script>window.process = { env: { NODE_ENV: "production" } }; window.__GUEST__ = ${guest}</script>
<script>${bundle}</script></body></html>`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "account-menu-icons-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light", width: number, guest = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) =>
    route.request().url() === "http://menu.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml(theme, css, bundle, guest) })
      : route.abort(),
  )
  await page.goto("http://menu.test/")
  try {
    await page.waitForSelector("header.beyonix-site-header", { timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

const ICONS = `[...document.querySelectorAll(".beyonix-account-menu-icon")].map((icon) => {
  const svg = icon.querySelector("svg")
  const s = getComputedStyle(svg)
  return { label: (icon.parentElement.textContent || "").trim().slice(0, 20), stroke: s.stroke, fill: s.fill, bg: getComputedStyle(icon).backgroundColor }
})`

type Icon = { label: string; stroke: string; fill: string; bg: string }

async function openMenu(page: Page, width: number) {
  if (width > 1000) await page.getByRole("button", { name: "Abrir menú de usuario" }).click()
  else await page.getByRole("button", { name: "Abrir menú" }).click()
  await page.waitForSelector(".beyonix-account-menu-icon")
}

function assertWhite(icons: Icon[], context: string, theme: "dark" | "light") {
  assert.ok(icons.length >= 7, `${context}: ${icons.length} íconos`)
  for (const icon of icons) {
    assert.equal(icon.stroke, "rgb(255, 255, 255)", `${context}: trazo blanco en ${icon.label}`)
    if (icon.label.startsWith("Favoritos")) assert.equal(icon.fill, "rgb(255, 255, 255)", `${context}: corazón relleno blanco`)
    else assert.equal(icon.fill, "none", `${context}: sin relleno en ${icon.label}`)
    if (theme === "light") assert.equal(icon.bg, "rgb(17, 42, 67)", `${context}: contenedor navy en ${icon.label}`)
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`A. ${theme} ${width}px: íconos del menú de cuenta del SiteHeader real siempre blancos`, async () => {
      const page = await open(theme, width)
      try {
        await openMenu(page, width)
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/menu-${theme}-${width}.png` })
        assertWhite((await page.evaluate(ICONS)) as Icon[], `${theme}/${width}`, theme)
      } finally {
        await page.close()
      }
    })
  }
}

test("A. contexto hostil (text-white/currentColor forzados a oscuro con !important): los íconos siguen blancos", async () => {
  const page = await open("light", 1440)
  try {
    // Simula cualquier remapeo contextual de Light (.checkout-page,
    // #contenido, …) o un CSS publicado desactualizado: todo el menú hereda
    // texto oscuro, incluido el contenedor del ícono.
    await page.addStyleTag({ content: `.beyonix-site-header *, .beyonix-account-menu-icon, .beyonix-account-menu-icon * { color: rgb(15, 23, 42) !important; }` })
    await openMenu(page, 1440)
    assertWhite((await page.evaluate(ICONS)) as Icon[], "hostil", "light")
  } finally {
    await page.close()
  }
})

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 1280, 390]) {
    for (const guest of [true, false]) {
      test(`B. ${theme} ${width}px ${guest ? "invitado" : "logueado"}: navbar comienza arriba sin franja de arrepentimiento`, async () => {
        const page = await open(theme, width, guest)
        try {
          const nav = await page.locator("header.beyonix-site-header > nav").boundingBox()
          assert.equal(nav?.y, 0, "el navbar comienza en el borde superior")
          assert.ok(nav && nav.height >= 56 && nav.height <= 80, `alto del navbar: ${nav?.height}`)
          assert.equal(await page.locator("header.beyonix-site-header a", { hasText: "BOTÓN DE ARREPENTIMIENTO" }).count(), 0)
          if (SHOTS) await page.screenshot({ path: `${SHOTS}/header-${theme}-${width}-${guest ? "guest" : "user"}.png` })
        } finally {
          await page.close()
        }
      })
    }
  }
}

test("A. hover de \"Cerrar sesión\" sigue pasando el ícono a rojo", async () => {
  const page = await open("light", 1440)
  try {
    await openMenu(page, 1440)
    await page.locator(".beyonix-account-menu-panel button[aria-label='Cerrar sesión']").hover()
    await page.waitForFunction(
      `getComputedStyle(document.querySelector(".beyonix-account-menu-panel button[aria-label='Cerrar sesión'] svg")).stroke === "rgb(239, 68, 68)"`,
      undefined,
      { timeout: 3_000 },
    )
  } finally {
    await page.close()
  }
})
