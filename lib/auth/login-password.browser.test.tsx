import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Contraseñas en el formulario REAL de /login (bundle esbuild + CSS del
// proyecto, Chromium real). Sólo se simulan router, tema, Supabase y el
// selector territorial; useAuth().login hace la MISMA solicitud que
// context/auth-context.tsx (POST /api/auth/login con {identifier, password})
// y esa solicitud se intercepta localmente para comparar el valor enviado
// con el introducido, carácter por carácter. Todas las contraseñas son
// ficticias; nunca hay red real ni cuentas reales.
//
// Antes: el campo de login reutilizaba maxLength={FIELD_LIMITS.password}
// (20), así que el navegador recortaba en silencio cualquier contraseña más
// larga (tipeada, pegada o autocompletada) y Supabase la rechazaba.

const IDENTIFIER = "cliente.ficticio@example.test"

const stubs: Plugin = {
  name: "login-password-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      // Router con URL mutable: permite simular navegación y el historial
      // (/login?mode=register -> /login) sin desmontar la página.
      "next/navigation": `
        import { useSyncExternalStore } from "react"
        const subscribe = (callback) => { window.addEventListener("test-navigation", callback); return () => window.removeEventListener("test-navigation", callback) }
        const read = () => window.__testSearch || ""
        export function navigate(search) { window.__testSearch = search; window.dispatchEvent(new Event("test-navigation")) }
        window.__navigate = navigate
        export function useSearchParams() { const search = useSyncExternalStore(subscribe, read, read); return new URLSearchParams(search) }
        export function useRouter() { return { push(url) { window.__pushes = [...(window.__pushes || []), url] }, replace(url) { const index = String(url).indexOf("?"); navigate(index >= 0 ? String(url).slice(index + 1) : "") }, refresh() {}, prefetch() {}, back() {} } }
        export function usePathname() { return "/login" }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref }) })`,
      "@/context/auth-context": `
        export function useAuth() {
          return {
            user: null,
            isLoading: false,
            // Misma solicitud que context/auth-context.tsx (login).
            async login(identifier, password) {
              const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier, password }) })
              const data = await response.json().catch(() => null)
              return response.ok && data && data.ok ? { ok: true } : { ok: false, error: (data && data.error) || "Ocurrió un error al iniciar sesión." }
            },
            async register(form) { window.__registered = [...(window.__registered || []), form.password]; return { ok: false, error: "Registro simulado." } },
          }
        }`,
      "@/context/account-theme-context": `export function useAccountTheme() { return { theme: "dark", toggleTheme() {} } }`,
      "@/lib/supabase/client": `export const supabase = { auth: { async resend() { return { error: null } }, async resetPasswordForEmail() { return { error: null } } } }`,
      "@/hooks/use-territorial-selector": `
        const noop = () => {}
        export function useTerritorialSelector() {
          return {
            province: "CABA", provinceOptions: [{ value: "CABA", label: "Ciudad Autónoma de Buenos Aires" }], handleProvinceChange: noop,
            manualLocalityMode: false, locality: "PALERMO", setLocality: noop, disableManualLocality: noop, enableManualLocality: noop,
            localityOptions: [{ value: "PALERMO", label: "PALERMO" }], handleLocalityChange: noop, localitiesLoading: false, localityLoadError: "",
            cpEntryIsManual: false, postalCode: "1406", handlePostalCodeChange: noop, postalCodeOptions: [{ value: "1406", label: "1406" }],
            postalCodesLoading: false, postalCodeLoadError: "", showManualPostalCodeOption: false, retryPostalCodes: noop, enableManualPostalCode: noop,
          }
        }`,
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
import LoginPage from "@/app/login/page"
createRoot(document.getElementById("root")).render(h(LoginPage))
`

let browser: Browser
let html: string

test.before(async () => {
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "login-password-fixture.tsx" },
    bundle: true,
    format: "iife",
    write: false,
    jsx: "automatic",
    plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  })
  html = `<!doctype html><html lang="es" data-account-theme="dark" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script>${result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

interface Opened { page: Page; sent: Array<{ identifier: string; password: string }> }

async function open(search = "", viewport = { width: 1280, height: 900 }): Promise<Opened> {
  const page = await browser.newPage({ viewport })
  const sent: Opened["sent"] = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.host !== "beyonix.test") return route.abort()
    if (url.pathname === "/api/auth/login") {
      // Interceptación local: nunca llega a ningún servidor.
      sent.push(JSON.parse(route.request().postData() ?? "{}"))
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Usuario/email o contraseña incorrectos." }) })
    }
    if (url.pathname === "/login") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
    return route.abort()
  })
  await page.addInitScript((initialSearch) => { (window as unknown as { __testSearch: string }).__testSearch = initialSearch }, search)
  await page.goto(`http://beyonix.test/login${search ? `?${search}` : ""}`)
  try { await page.waitForSelector("form", { timeout: 15_000 }) }
  catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return { page, sent }
}

const loginPassword = (page: Page) => page.locator("form input#password")
const COMPLEXITY_TEXT = /Requisitos de contraseña|mayúscula|minúscula|no cumple los requisitos|al menos 8|no puede superar/i

async function submitLogin({ page, sent }: Opened, password: string, how: "type" | "paste" | "fill", submit: "click" | "enter" = "click") {
  await page.locator("form input#username").fill(IDENTIFIER)
  const input = loginPassword(page)
  await input.click()
  if (how === "type") await input.pressSequentially(password)
  else if (how === "paste") await page.keyboard.insertText(password)
  else await input.fill(password)
  assert.equal(await input.inputValue(), password, "el campo conserva exactamente lo introducido")
  const before = sent.length
  if (submit === "enter") await input.press("Enter")
  else await page.getByRole("button", { name: "Ingresar" }).click()
  await page.waitForFunction((count) => document.body.textContent?.includes("Usuario/email o contraseña incorrectos.") && count >= 0, before)
  assert.equal(sent.length, before + 1, "una sola solicitud")
  return sent.at(-1)!
}

// Contraseñas ficticias: largas, de gestores, con símbolos, espacios y Unicode.
const CASES: Array<[string, string]> = [
  ["20 caracteres", "Ficticia-2026-Clave1"],
  ["21 caracteres", "Ficticia-2026-Clave12"],
  ["24 caracteres", "Ficticia-2026-Clave12345"],
  ["gestor de contraseñas (64)", "q7#Vt9!xR2$wLm8@Zp4^Hs6&Ky1*Nb3(Jd5)Fg0_Uc2+Ea7=Wr9{Ti4}Ol6|Ms8?"],
  ["símbolos", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"],
  ["espacios inicial, interno y final", "  clave con espacios  "],
  ["Unicode sin normalizar", "Ñandú-café-密码-🔐-Ωmega"],
  ["contraseña antigua sin requisitos actuales", "abc"],
]

test("login: llega íntegra a la solicitud (20, 21, 24, gestores, símbolos, espacios, Unicode y contraseñas antiguas)", async () => {
  assert.deepEqual(CASES.slice(0, 3).map(([, password]) => password.length), [20, 21, 24])
  const opened = await open()
  try {
    assert.equal(await loginPassword(opened.page).evaluate((input: HTMLInputElement) => input.maxLength), -1, "sin maxLength: el navegador no puede truncar (tipeo, pegado ni autocompletado)")
    for (const [label, password] of CASES) {
      const body = await submitLogin(opened, password, "type")
      assert.equal(body.password, password, `${label}: enviado exactamente igual`)
      assert.equal(body.password.length, password.length, label)
      assert.equal(body.identifier, IDENTIFIER)
      assert.doesNotMatch(await opened.page.locator("form").innerText(), COMPLEXITY_TEXT, `${label}: sin mensajes de complejidad en el login`)
      await loginPassword(opened.page).fill("")
    }
  } finally {
    await opened.page.close()
  }
})

test("login: copiar y pegar una contraseña larga no la recorta", async () => {
  const opened = await open()
  try {
    const password = "Pegada desde el gestor: 9fK#2mQ!7vR$4tZ@1xW"
    assert.equal((await submitLogin(opened, password, "paste")).password, password)
  } finally {
    await opened.page.close()
  }
})

test("login: autocompletado (valor asignado de una vez, como un gestor) y envío con Enter", async () => {
  const opened = await open()
  try {
    const password = "Autocompletada-por-gestor-2026!xyz"
    assert.equal((await submitLogin(opened, password, "fill", "enter")).password, password)
  } finally {
    await opened.page.close()
  }
})

test("login: mostrar y ocultar la contraseña no cambia el valor enviado", async () => {
  const opened = await open()
  try {
    const password = "  Visible y Oculta 24 ch "
    const input = loginPassword(opened.page)
    await input.click()
    await input.pressSequentially(password)
    await opened.page.getByRole("button", { name: "Mostrar contraseña" }).click()
    assert.equal(await input.getAttribute("type"), "text")
    assert.equal(await input.inputValue(), password)
    await opened.page.getByRole("button", { name: "Ocultar contraseña" }).click()
    assert.equal(await input.getAttribute("type"), "password")
    await input.fill("")
    assert.equal((await submitLogin(opened, password, "type")).password, password)
  } finally {
    await opened.page.close()
  }
})

test("cambio de registro a inicio de sesión: sin validaciones de creación ni mensajes de complejidad", async () => {
  const opened = await open("mode=register")
  try {
    const { page } = opened
    await page.waitForSelector(".beyonix-register-form")
    await page.locator("form input#password").click()
    await page.locator("form input#password").pressSequentially("abc")
    await page.getByRole("button", { name: "Crear cuenta" }).last().click()
    await page.getByRole("button", { name: /^Iniciar sesión$/ }).first().click()
    await page.waitForSelector("form:not(.beyonix-register-form)")
    assert.doesNotMatch(await page.locator("form").innerText(), COMPLEXITY_TEXT)
    await loginPassword(page).fill("")
    const password = "Antigua corta"
    assert.equal((await submitLogin(opened, password, "type")).password, password)
    assert.doesNotMatch(await page.locator("form").innerText(), COMPLEXITY_TEXT)
  } finally {
    await opened.page.close()
  }
})

test("historial: volver de /login?mode=register a /login muestra el inicio de sesión, no el registro", async () => {
  const opened = await open("mode=register")
  try {
    const { page } = opened
    await page.waitForSelector(".beyonix-register-form")
    await page.evaluate(() => (window as unknown as { __navigate: (search: string) => void }).__navigate(""))
    await page.waitForSelector("form:not(.beyonix-register-form)", { timeout: 3_000 })
    assert.equal(await page.locator("form input#password").getAttribute("autocomplete"), "current-password")
    assert.doesNotMatch(await page.locator("form").innerText(), COMPLEXITY_TEXT)
    // Y al revés: un enlace a ?mode=register sigue abriendo el registro.
    await page.evaluate(() => (window as unknown as { __navigate: (search: string) => void }).__navigate("mode=register"))
    await page.waitForSelector(".beyonix-register-form", { timeout: 3_000 })
  } finally {
    await opened.page.close()
  }
})

test("mobile: el login conserva una contraseña de 24 caracteres", async () => {
  const opened = await open("", { width: 390, height: 844 })
  try {
    const password = "Mobile-Ficticia-24chars!"
    assert.equal((await submitLogin(opened, password, "type", "enter")).password, password)
  } finally {
    await opened.page.close()
  }
})

test("registro: acepta una contraseña segura de gestor (más de 20) sin recortarla", async () => {
  const opened = await open("mode=register")
  try {
    const { page } = opened
    const password = "Gestor-Segura-2026-Abc9xyz!Q"
    const input = page.locator("form input#password")
    await input.click()
    await input.pressSequentially(password)
    assert.equal(await input.inputValue(), password, "sin recorte en el registro")
    assert.equal(await input.evaluate((element: HTMLInputElement) => element.maxLength), -1)
    await page.locator("form input#confirm-password").pressSequentially(password)
    assert.equal(await page.locator("form input#confirm-password").inputValue(), password)
    assert.doesNotMatch(await page.locator("form").innerText(), /no puede superar/)
  } finally {
    await opened.page.close()
  }
})
