import assert from "node:assert/strict"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// "Volver" con el historial REAL del navegador: NavigationHistoryTracker +
// useBackNavigation reales sobre un router mínimo basado en la History API
// (mismo contrato que el de Next: push/replace/back + popstate). Se usa el
// botón Atrás del navegador (page.goBack) y los botones internos.

const ORIGIN = "http://nav.test"

const stubs: Plugin = {
  name: "back-navigation-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "next/navigation": `
        import { useMemo, useSyncExternalStore } from "react"
        const listeners = new Set()
        const notify = () => listeners.forEach((listener) => listener())
        window.addEventListener("popstate", notify)
        const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
        const router = {
          push(url) { window.history.pushState({}, "", url); notify() },
          replace(url) { window.history.replaceState({}, "", url); notify() },
          back() { window.history.back() },
        }
        export function useRouter() { return router }
        export function usePathname() { return useSyncExternalStore(subscribe, () => window.location.pathname) }
        export function useSearchParams() {
          const search = useSyncExternalStore(subscribe, () => window.location.search)
          return useMemo(() => new URLSearchParams(search), [search])
        }`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const ENTRY = `
import { createElement as h, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { useRouter, usePathname } from "next/navigation"
import { NavigationHistoryTracker } from "@/components/navigation-history-tracker"
import { useBackNavigation } from "@/hooks/use-back-navigation"

function App() {
  const router = useRouter()
  const pathname = usePathname()
  const { back, backTo } = useBackNavigation()
  const go = (url) => () => router.push(url)
  return h("main", null,
    h(NavigationHistoryTracker),
    h("p", { "data-url": true }, pathname + window.location.search),
    h("button", { id: "to-productos", onClick: go("/productos") }, "Productos"),
    h("button", { id: "to-categoria", onClick: go("/categorias/hogar") }, "Categoría"),
    h("button", { id: "to-producto", onClick: go("/productos/encendedor") }, "Producto"),
    h("button", { id: "to-login", onClick: go("/login?redirect=%2Fproductos") }, "Login"),
    h("button", { id: "to-ordenes", onClick: () => router.replace("/cuenta?tab=ordenes") }, "Mis compras (replace)"),
    h("button", { id: "to-pedido", onClick: go("/cuenta/compras/42") }, "Pedido"),
    h("button", { id: "volver-login", onClick: () => back("/") }, "Volver (login)"),
    h("button", { id: "volver-checkout", onClick: () => back("/productos") }, "Volver (checkout)"),
    h("button", { id: "volver-ordenes", onClick: () => backTo("/cuenta?tab=ordenes", (url) => url.startsWith("/cuenta?tab=ordenes")) }, "Volver a Mis compras"),
  )
}
createRoot(document.getElementById("root")).render(h(App))
`

let browser: Browser
let bundle: string

test.before(async () => {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "back-navigation-fixture.tsx" },
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

/** Página nueva que arranca en `path` (primera entrada del sitio en esta pestaña). */
async function open(path: string): Promise<Page> {
  const page = await browser.newPage()
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html lang="es"><body><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script>${bundle}</script></body></html>`,
  }))
  await page.route("**/*", (route) => (route.request().url().startsWith(ORIGIN) ? route.fallback() : route.abort()))
  await page.goto(ORIGIN + path)
  await page.waitForSelector("[data-url]")
  return page
}

const url = (page: Page) => page.evaluate(() => window.location.pathname + window.location.search)
async function waitUrl(page: Page, expected: string) {
  await page.waitForFunction((target) => window.location.pathname + window.location.search === target, expected)
  assert.equal(await url(page), expected)
}

test("Home → Productos → Categoría → Producto: el Atrás del navegador recorre la secuencia real", async () => {
  const page = await open("/")
  try {
    await page.click("#to-productos")
    await page.click("#to-categoria")
    await page.click("#to-producto")
    await waitUrl(page, "/productos/encendedor")
    await page.goBack(); await waitUrl(page, "/categorias/hogar")
    await page.goBack(); await waitUrl(page, "/productos")
    await page.goBack(); await waitUrl(page, "/")
  } finally { await page.close() }
})

test("Productos → Login → Volver: vuelve a Productos (no al inicio)", async () => {
  const page = await open("/")
  try {
    await page.click("#to-productos")
    await page.click("#to-login")
    await waitUrl(page, "/login?redirect=%2Fproductos")
    await page.click("#volver-login")
    await waitUrl(page, "/productos")
  } finally { await page.close() }
})

test("Login abierto directo (sin historial interno) → Volver: va a la tienda sin salir del sitio", async () => {
  const page = await open("/login")
  try {
    await page.click("#volver-login")
    await waitUrl(page, "/")
  } finally { await page.close() }
})

test("Checkout abierto directo → Volver: catálogo (respaldo), nunca fuera del sitio", async () => {
  const page = await open("/checkout")
  try {
    await page.click("#volver-checkout")
    await waitUrl(page, "/productos")
  } finally { await page.close() }
})

test("Cuenta → Mis compras → Pedido → 'Volver a Mis compras': retrocede sin apilar entradas", async () => {
  const page = await open("/cuenta")
  try {
    await page.click("#to-ordenes")
    await page.click("#to-pedido")
    await waitUrl(page, "/cuenta/compras/42")
    const lengthBefore = await page.evaluate(() => window.history.length)
    await page.click("#volver-ordenes")
    await waitUrl(page, "/cuenta?tab=ordenes")
    assert.equal(await page.evaluate(() => window.history.length), lengthBefore, "router.back, no un push nuevo")
    // Y el Atrás del navegador desde el pedido también llega a Mis compras.
    await page.click("#to-pedido")
    await page.goBack()
    await waitUrl(page, "/cuenta?tab=ordenes")
  } finally { await page.close() }
})

test("Pedido abierto directo (link externo) → 'Volver a Mis compras': navega a Mis compras", async () => {
  const page = await open("/cuenta/compras/42")
  try {
    await page.click("#volver-ordenes")
    await waitUrl(page, "/cuenta?tab=ordenes")
  } finally { await page.close() }
})
