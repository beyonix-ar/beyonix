import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Scroll al cambiar de paso del checkout, medido en Edge/Chrome real con el
// CSS del proyecto, el CheckoutHeader REAL (sticky) y el hook REAL. El bloque
// superior replica el del checkout (mismas clases, incluido scroll-mt; el
// contrato con app/checkout/page.tsx lo cubre use-scroll-on-step-change.test).
// Los pasos tienen contenido alto y "Resumen del pedido" debajo, como en mobile.

const SHOTS = process.env.CHECKOUT_STEP_SCROLL_SHOTS

const stubs: Plugin = {
  name: "checkout-step-scroll-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/auth-context": `export function useAuth() { return { user: { id: "u1", username: "ANTARES", rol: "cliente" }, isLoading: false, isInternal: false, logout() {} } }`,
      "@/context/customer-credit-context": `export function useCustomerCredit() { return { balance: 0 } }`,
      "@/context/account-theme-context": `export function useAccountTheme() { return { theme: "dark", toggleTheme() {} } }`,
      "@/hooks/use-order-notifications": `export function useOrderNotifications() { return { notificationCount: 0, notificationTone: "neutral", notificationGroups: {}, notifications: [], loading: false, error: null, reloadNotificationCount() {} } }`,
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
import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { CheckoutHeader } from "@/components/checkout/checkout-header"
import { useScrollOnStepChange } from "@/hooks/use-scroll-on-step-change"

const TITLES = { 1: "Datos del destinatario", 2: "Método de envío", 3: "Método de pago" }

function Checkout() {
  const [step, setStep] = useState(1)
  const [revision, setRevision] = useState(0)
  const topRef = useRef(null)
  useScrollOnStepChange(step, topRef)
  window.__setStep = setStep
  window.__refetch = () => setRevision((value) => value + 1)
  return (
    <main className="checkout-page min-h-screen bg-[#05070A] font-heading text-white">
      <CheckoutHeader />
      <div className="beyonix-checkout-container py-5 lg:py-7">
        <div className="mx-auto max-w-none">
          <div ref={topRef} data-checkout-top className="checkout-heading-row mb-4 flex scroll-mt-20 items-end justify-between gap-4 lg:scroll-mt-24">
            <div>
              <p className="text-10px font-semibold uppercase tracking-[0.2em]">Compra segura</p>
              <h1 className="mt-1 text-2xl font-bold lg:text-3xl">Checkout</h1>
            </div>
            <span className="hidden text-sm sm:block">Paso {step} de 3</span>
          </div>
          <div className="checkout-progress mb-3 grid grid-cols-3 gap-2" aria-label="Progreso del checkout">
            {[1, 2, 3].map((id) => <div key={id} className="min-h-12 rounded-lg border px-3 py-2">{id}</div>)}
          </div>
          <form data-checkout-step={step} className="checkout-layout grid gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(22rem,0.85fr)]" onSubmit={(event) => event.preventDefault()}>
            <section>
              <h2 data-step-title className="text-xl font-bold">{TITLES[step]}</h2>
              <p data-revision={revision}>Revisión {revision}</p>
              {Array.from({ length: 9 },(_, index) => <div key={index} className="mt-3 h-20 rounded-lg border border-white/10" />)}
              <div className="mt-4 flex justify-between">
                {step > 1 && <button type="button" onClick={() => setStep(step - 1)}>Anterior</button>}
                {step < 3 && <button type="button" onClick={() => setStep(step + 1)}>Continuar</button>}
              </div>
            </section>
            <aside>
              <h2 data-summary className="text-xl font-bold">Resumen del pedido</h2>
              <div className="mt-3 h-[700px] rounded-lg border border-white/10" />
            </aside>
          </form>
        </div>
      </div>
    </main>
  )
}
createRoot(document.getElementById("root")).render(<Checkout />)
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "checkout-step-scroll-fixture.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 640 })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => route.abort())
  await page.setContent(`<!doctype html><html lang="es" data-account-theme="dark" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script>${bundle}</script></body></html>`)
  try { await page.waitForSelector("[data-checkout-top]", { timeout: 10_000 }) }
  catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return page
}

/** Espera a que termine el scroll suave (scrollY estable varios frames). */
async function settle(page: Page) {
  // Como string: evita helpers (__name) inyectados por el transpilador.
  await page.evaluate(`new Promise((resolve) => {
    let last = -1
    let stable = 0
    const tick = () => {
      stable = window.scrollY === last ? stable + 1 : 0
      last = window.scrollY
      if (stable >= 10) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })`)
}

async function view(page: Page) {
  return (await page.evaluate(`(() => {
    const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }
    return {
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      header: rect(".checkout-header"),
      top: rect("[data-checkout-top]"),
      title: { ...rect("[data-step-title]"), text: document.querySelector("[data-step-title]").textContent },
      summary: rect("[data-summary]"),
    }
  })()`)) as {
    scrollY: number; innerHeight: number
    header: { top: number; bottom: number }
    top: { top: number; bottom: number }
    title: { top: number; bottom: number; text: string }
    summary: { top: number; bottom: number }
  }
}

function assertAtCheckoutTop(layout: Awaited<ReturnType<typeof view>>, expectedTitle: string, label: string) {
  assert.equal(layout.title.text, expectedTitle, label)
  assert.ok(layout.top.top >= layout.header.bottom - 0.5, `${label}: el header sticky no tapa "Compra segura" (${layout.top.top} vs ${layout.header.bottom})`)
  assert.ok(layout.top.top - layout.header.bottom <= 32, `${label}: el inicio del checkout queda arriba (${layout.top.top - layout.header.bottom}px bajo el header)`)
  assert.ok(layout.title.top >= layout.header.bottom && layout.title.bottom <= layout.innerHeight, `${label}: "${expectedTitle}" visible`)
}

for (const [width, height] of [[390, 844], [1366, 768]] as const) {
  test(`checkout a ${width}×${height}: cada cambio de paso lleva al inicio útil del checkout`, async () => {
    const page = await open(width, height)
    const tap = async (name: string) => {
      const button = page.getByRole("button", { name, exact: true })
      await button.scrollIntoViewIfNeeded()
      if (width < 640) await button.tap()
      else await button.click()
      await settle(page)
    }
    try {
      assert.equal((await view(page)).scrollY, 0, "sin scroll al montar")

      await tap("Continuar")
      const step2 = await view(page)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/checkout-step2-${width}.png` })
      assertAtCheckoutTop(step2, "Método de envío", "Paso 1 → 2")
      if (width < 640) assert.ok(step2.summary.top > step2.innerHeight, "mobile: no se entra viendo el Resumen del pedido")

      // Refetch dentro del mismo paso: no mueve el scroll.
      await page.mouse.wheel(0, 400)
      await settle(page)
      const before = (await view(page)).scrollY
      await page.evaluate("window.__refetch()")
      await settle(page)
      assert.equal((await view(page)).scrollY, before, "refetch del Paso 2 no desplaza")

      await tap("Continuar")
      assertAtCheckoutTop(await view(page), "Método de pago", "Paso 2 → 3")

      await tap("Anterior")
      assertAtCheckoutTop(await view(page), "Método de envío", "Paso 3 → 2")

      await tap("Anterior")
      assertAtCheckoutTop(await view(page), "Datos del destinatario", "Paso 2 → 1")

      const overflow = (await page.evaluate("document.documentElement.scrollWidth - window.innerWidth")) as number
      assert.ok(overflow <= 0, `sin scroll horizontal: ${overflow}px`)
    } finally {
      await page.close()
    }
  })
}
