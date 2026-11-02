import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Login, Registro y /recuperar-contrasena REALES (bundle esbuild + CSS del
// proyecto). Stubs sólo de infraestructura: router, Link (registra a dónde
// navegaría en vez de salir de la página), auth, Supabase y territorial.
// /api/auth/forgot-password se intercepta en el navegador para verificar el
// request y devolver la respuesta neutra del servidor.

const NEUTRAL_MESSAGE =
  "Si existe una cuenta asociada, te enviaremos un enlace para restablecer tu contraseña."

const stubs: Plugin = {
  name: "recover-password-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "next/navigation": `
        export function useRouter() { return { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} } }
        export function useSearchParams() { return new URLSearchParams(window.__search || "") }
        export function usePathname() { return "/login" }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref, onClick: (event) => { event.preventDefault(); window.__navigatedTo = String(href) } }) })`,
      "@/context/auth-context": `export function useAuth() { return { user: null, isLoading: false, async login() { return { ok: false } }, async register() { return { ok: false } } } }`,
      "@/context/account-theme-context": `export function useAccountTheme() { return { theme: document.documentElement.getAttribute("data-account-theme"), toggleTheme() {} } }`,
      "@/lib/supabase/client": `export const supabase = { auth: { async resend() { return { error: null } } } }`,
      "@/hooks/use-territorial-selector": `
        const noop = () => {}
        export function useTerritorialSelector() {
          return { province: "", provinceOptions: [], handleProvinceChange: noop, manualLocalityMode: false, locality: "", setLocality: noop, disableManualLocality: noop, enableManualLocality: noop, localityOptions: [], handleLocalityChange: noop, localitiesLoading: false, localityLoadError: "", cpEntryIsManual: false, postalCode: "", handlePostalCodeChange: noop, postalCodeOptions: [], postalCodesLoading: false, postalCodeLoadError: "", showManualPostalCodeOption: false, retryPostalCodes: noop, enableManualPostalCode: noop }
        }`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

async function bundlePage(importPath: string) {
  const result = await build({
    stdin: {
      contents: `import { createElement as h } from "react"; import { createRoot } from "react-dom/client"; import Page from "${importPath}"; createRoot(document.getElementById("root")).render(h(Page))`,
      resolveDir: process.cwd(),
      loader: "tsx",
      sourcefile: "recover-password-fixture.tsx",
    },
    bundle: true,
    format: "iife",
    write: false,
    jsx: "automatic",
    plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  })
  return result.outputFiles[0].text
}

let browser: Browser
let css: string
let loginBundle: string
let recoverBundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  ;[loginBundle, recoverBundle] = await Promise.all([bundlePage("@/app/login/page"), bundlePage("@/app/recuperar-contrasena/page")])
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

type ForgotRequest = { identifier: unknown }

async function open(bundle: string, search: string, ready: string) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors: string[] = []
  const requests: ForgotRequest[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.exposeFunction("__recordForgot", (body: string) => { requests.push(JSON.parse(body) as ForgotRequest) })
  // fetch interceptado: misma respuesta neutra que da el servidor exista o no la cuenta.
  const fetchStub = `window.fetch = async (url, init) => {
    if (String(url) === "/api/auth/forgot-password") {
      await window.__recordForgot(init.body)
      return new Response(JSON.stringify({ ok: true, message: ${JSON.stringify(NEUTRAL_MESSAGE)} }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    throw new Error("fetch inesperado: " + url)
  }`
  await page.route("**/*", (route) => route.abort())
  await page.setContent(`<!doctype html><html lang="es" data-account-theme="dark" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-beyonix-page"><div id="root"></div><script>window.__search=${JSON.stringify(search)};window.process={env:{NODE_ENV:"production"}};${fetchStub}</script><script>${bundle}</script></body></html>`)
  try { await page.waitForSelector(ready, { timeout: 10_000 }) }
  catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return { page, requests, errors }
}

const navigatedTo = (page: Page) => page.evaluate(() => (window as unknown as { __navigatedTo?: string }).__navigatedTo ?? null)

test("login: '¿Olvidaste tu contraseña?' navega a /recuperar-contrasena sin mostrar el error rojo ni llamar a la API", async () => {
  const { page, requests } = await open(loginBundle, "", "text=¿Olvidaste tu contraseña?")
  try {
    await page.getByText("¿Olvidaste tu contraseña?").click()
    assert.equal(await navigatedTo(page), "/recuperar-contrasena")
    assert.equal(await page.getByText("Ingresá tu usuario o email para recuperar la contraseña.").count(), 0)
    assert.equal(requests.length, 0)
  } finally { await page.close() }
})

test("login con ?redirect=/checkout: la recuperación conserva el redirect interno; uno externo se descarta", async () => {
  const internal = await open(loginBundle, "redirect=/checkout", "text=¿Olvidaste tu contraseña?")
  try {
    await internal.page.getByText("¿Olvidaste tu contraseña?").click()
    assert.equal(await navigatedTo(internal.page), "/recuperar-contrasena?redirect=%2Fcheckout")
  } finally { await internal.page.close() }

  const external = await open(loginBundle, "redirect=//evil.com", "text=¿Olvidaste tu contraseña?")
  try {
    await external.page.getByText("¿Olvidaste tu contraseña?").click()
    assert.equal(await navigatedTo(external.page), "/recuperar-contrasena")
  } finally { await external.page.close() }
})

test("registro: muestra 'Datos de acceso' sin el prefijo '01 ·'", async () => {
  const { page } = await open(loginBundle, "mode=register", ".beyonix-register-form")
  try {
    const legend = page.locator(".beyonix-register-form legend").first()
    assert.equal((await legend.textContent())?.trim(), "Datos de acceso")
    assert.equal(await page.getByText("01 ·").count(), 0)
  } finally { await page.close() }
})

test("/recuperar-contrasena: único campo, título, texto y acciones pedidas", async () => {
  const { page } = await open(recoverBundle, "", "#recovery-identifier")
  try {
    assert.equal(await page.locator("input").count(), 1)
    assert.equal((await page.locator("h1").textContent())?.trim(), "Recuperar contraseña")
    assert.equal(await page.getByText("Ingresá tu email o usuario para recibir un enlace de recuperación.").count(), 1)
    assert.equal(await page.getByLabel("Email o usuario").count(), 1)
    assert.equal(await page.getByRole("button", { name: "Enviar enlace de recuperación" }).count(), 1)
    await page.getByText("Volver a iniciar sesión").click()
    assert.equal(await navigatedTo(page), "/login")
  } finally { await page.close() }
})

for (const identifier of ["cliente@example.com", "usuario.tech"]) {
  test(`/recuperar-contrasena acepta ${identifier.includes("@") ? "email" : "username"} y muestra el mensaje neutro`, async () => {
    const { page, requests } = await open(recoverBundle, "", "#recovery-identifier")
    try {
      await page.fill("#recovery-identifier", `  ${identifier}  `)
      await page.getByRole("button", { name: "Enviar enlace de recuperación" }).click()
      await page.getByRole("status").waitFor()
      assert.deepEqual(requests, [{ identifier }])
      assert.equal((await page.getByRole("status").textContent())?.trim(), NEUTRAL_MESSAGE)
      assert.equal(await page.getByRole("alert").count(), 0)
    } finally { await page.close() }
  })
}

test("/recuperar-contrasena con ?redirect=/checkout vuelve al login conservándolo", async () => {
  const { page } = await open(recoverBundle, "redirect=/checkout", "#recovery-identifier")
  try {
    await page.getByText("Volver a iniciar sesión").click()
    assert.equal(await navigatedTo(page), "/login?redirect=%2Fcheckout")
  } finally { await page.close() }
})
