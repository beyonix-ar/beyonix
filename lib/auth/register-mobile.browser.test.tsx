import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Registro mobile con la página REAL (bundle esbuild) y el CSS del proyecto.
// Stubs sólo de infraestructura: router, auth, Supabase, tema y el selector
// territorial (con la localidad más larga del país ya elegida).
// Cubre: nada del formulario se sale de la tarjeta (antes los fieldsets no
// se encogían por debajo de su min-content y la tarjeta recortaba el borde
// derecho), labels largos completos, localidad larga legible y
// Número/Piso/Dpto sin overflow.

const SHOTS = process.env.REGISTER_MOBILE_SHOTS
const LONG_LOCALITY = "CIUDAD AUTÓNOMA DE BUENOS AIRES"

const stubs: Plugin = {
  name: "register-mobile-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "next/navigation": `
        export function useRouter() { return { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} } }
        export function useSearchParams() { return new URLSearchParams("mode=register") }
        export function usePathname() { return "/login" }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref }) })`,
      "@/context/auth-context": `export function useAuth() { return { user: null, isLoading: false, async login() {}, async register() {} } }`,
      "@/context/account-theme-context": `export function useAccountTheme() { return { theme: document.documentElement.getAttribute("data-account-theme"), toggleTheme() {} } }`,
      "@/lib/supabase/client": `export const supabase = { auth: { async resend() { return { error: null } }, async resetPasswordForEmail() { return { error: null } } } }`,
      "@/hooks/use-territorial-selector": `
        const noop = () => {}
        export function useTerritorialSelector() {
          return {
            province: "CABA",
            provinceOptions: [{ value: "CABA", label: "Ciudad Autónoma de Buenos Aires" }, { value: "BA", label: "Buenos Aires" }],
            handleProvinceChange: noop,
            manualLocalityMode: false,
            locality: "${LONG_LOCALITY}",
            setLocality: noop,
            disableManualLocality: noop,
            enableManualLocality: noop,
            localityOptions: [{ value: "${LONG_LOCALITY}", label: "${LONG_LOCALITY}" }, { value: "VILLA GENERAL MITRE", label: "VILLA GENERAL MITRE" }],
            handleLocalityChange: noop,
            localitiesLoading: false,
            localityLoadError: "",
            cpEntryIsManual: false,
            postalCode: "1406",
            handlePostalCodeChange: noop,
            postalCodeOptions: [{ value: "1406", label: "1406" }],
            postalCodesLoading: false,
            postalCodeLoadError: "",
            showManualPostalCodeOption: false,
            retryPostalCodes: noop,
            enableManualPostalCode: noop,
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
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "register-mobile-fixture.tsx" },
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

async function open(theme: "light" | "dark", width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => route.abort())
  await page.setContent(`<!doctype html><html lang="es" data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script>${bundle}</script></body></html>`)
  try { await page.waitForSelector(".beyonix-register-form", { timeout: 10_000 }) }
  catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return page
}

type Overflow = { tag: string; text: string; left: number; right: number; cardLeft: number; cardRight: number }

/** Elementos visibles del formulario que se salen (aunque sea 1px) del área de la tarjeta. */
async function overflowingElements(page: Page) {
  return (await page.evaluate(`(() => {
    const card = document.querySelector(".beyonix-register-form").closest(".login-card")
    const box = card.getBoundingClientRect()
    const result = []
    for (const element of document.querySelectorAll(".beyonix-register-form *")) {
      const style = getComputedStyle(element)
      if (style.position === "absolute" || style.display === "none" || style.visibility === "hidden") continue
      if (element.closest(".sr-only")) continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.left < box.left - 1 || rect.right > box.right + 1) {
        result.push({ tag: element.tagName, text: (element.textContent || "").trim().slice(0, 40), left: Math.round(rect.left), right: Math.round(rect.right), cardLeft: Math.round(box.left), cardRight: Math.round(box.right) })
      }
    }
    return result
  })()`)) as Overflow[]
}

/** Texto recortado: el contenido es más ancho que la caja y no hace wrap. */
async function clippedTexts(page: Page) {
  return (await page.evaluate(`(() => {
    const result = []
    for (const element of document.querySelectorAll(".beyonix-register-form label, .beyonix-register-form legend, .beyonix-register-form p, .beyonix-register-form button, .beyonix-register-form [role=option]")) {
      if (element.scrollWidth > element.clientWidth + 1) result.push((element.textContent || "").trim().slice(0, 60))
    }
    return result
  })()`)) as string[]
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 360, 390, 412, 430]) {
    test(`registro ${theme} ${width}px: todo el formulario entra en la tarjeta, sin textos cortados`, async () => {
      const page = await open(theme, width)
      try {
        const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        assert.ok(pageOverflow <= 0, `scroll horizontal de página: ${pageOverflow}px`)
        assert.deepEqual(await overflowingElements(page), [], "ningún elemento se sale de la tarjeta")
        assert.deepEqual(await clippedTexts(page), [], "ningún label/título/botón recortado")

        // Label largo: completo y dentro del fieldset.
        const label = page.locator('label[for="references"]')
        assert.equal((await label.innerText()).trim(), "Referencias / Anotaciones (máximo 80 caracteres)")
        const [labelBox, fieldsetBox] = await Promise.all([label.boundingBox(), label.locator("xpath=ancestor::fieldset[1]").boundingBox()])
        assert.ok(labelBox && fieldsetBox && labelBox.x + labelBox.width <= fieldsetBox.x + fieldsetBox.width + 1, "label dentro del fieldset")

        // Localidad larga: el valor elegido se lee completo (sin elipsis).
        const locality = page.locator("#localidad")
        assert.equal((await locality.innerText()).replace(/\s+/g, " ").trim(), LONG_LOCALITY)
        assert.equal(await locality.evaluate((element) => {
          const value = element.querySelector("span")!
          return value.scrollWidth <= value.clientWidth + 1
        }), true, "el valor de la localidad no queda recortado")

        // Número / Piso / Dpto: cada input entra en el ancho disponible.
        for (const name of ["street-number", "floor", "apartment"]) {
          const box = await page.locator(`#${name}`).boundingBox()
          assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${name} dentro del viewport`)
        }

        // Dropdown de localidad: opción larga completa, dentro de la pantalla.
        await locality.click()
        const option = page.locator(`[role=option]:has-text("${LONG_LOCALITY}")`)
        await option.waitFor()
        const optionBox = await option.boundingBox()
        assert.ok(optionBox && optionBox.x >= 0 && optionBox.x + optionBox.width <= width, "opción dentro del viewport")
        assert.deepEqual(await clippedTexts(page), [], "opciones sin recortar")
        assert.equal(await option.evaluate((element) => {
          const text = element.querySelector("span")!
          return text.scrollWidth <= text.clientWidth + 1
        }), true, "opción larga completa")
        await page.keyboard.press("Escape")

        if (SHOTS) await page.screenshot({ path: `${SHOTS}/register-${theme}-${width}.png`, fullPage: true })
      } finally { await page.close() }
    })
  }
}

test("registro desktop 1280px: Calle/Número/Piso/Dpto siguen en una fila", async () => {
  const page = await open("dark", 1280)
  try {
    const tops = await Promise.all(["street", "street-number", "floor", "apartment"].map(async (name) => Math.round((await page.locator(`#${name}`).boundingBox())!.y)))
    assert.equal(new Set(tops).size, 1, `misma fila: ${tops}`)
    assert.deepEqual(await overflowingElements(page), [])
  } finally { await page.close() }
})
